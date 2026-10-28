"""Authoritative AVA actions: tenant scope, approval, durable dedupe and real effects.

An uncertain side effect is never repeated automatically after a process crash.
Critical actions need an operator approval bound to the exact arguments.
"""
import asyncio
import hashlib
import json
import math
import re
import secrets
import time
import uuid
from contextvars import ContextVar
from enum import Enum

from src.core.onyx_action_client import AvaActionClient
from src.core.onyx_client import redact_onyx_error
from src.core.onyx_db import get_db_connection, init_onyx_tables


class ActionTier(str, Enum):
    READ = "READ"
    WRITE = "WRITE"
    CRITICAL = "CRITICAL"


class PolicyDecision(str, Enum):
    ALLOWED = "ALLOWED"
    DENIED = "DENIED"
    EXECUTED = "EXECUTED"
    FAILED = "FAILED"


class PolicyGatewayError(Exception):
    def __init__(self, message, code="POLICY_DENIED"):
        super().__init__(redact_onyx_error(message))
        self.code = code


_execution = ContextVar("onyx_action_execution", default=None)


def _json(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, allow_nan=False)


def _hash(value):
    return hashlib.sha256(_json(value).encode()).hexdigest()


def _safe(value):
    if isinstance(value, dict):
        return {key: ("[REDACTED]" if re.search(r"password|secret|token|authorization|api.?key", key, re.I) else _safe(item)) for key, item in value.items()}
    if isinstance(value, list):
        return [_safe(item) for item in value]
    if isinstance(value, str):
        return redact_onyx_error(value, 2000) if value else ""
    return value


class PolicyGateway:
    ROLE_ACTIONS = {
        "sales": {"get_customer", "get_booking", "get_availability", "get_hotel_info", "create_task", "update_customer", "send_whatsapp", "make_call", "send_followup", "cancel_booking"},
        "manager": {"get_customer", "get_booking", "get_availability", "get_hotel_info", "get_call_history", "get_campaign", "update_customer", "create_task", "update_opportunity", "approve_followup", "send_whatsapp", "make_call", "launch_campaign", "cancel_booking", "send_followup"},
        "revenue": {"get_hotel_info", "get_availability", "get_campaign", "create_task", "change_price"},
    }

    def __init__(self, db_path=None, *, client=None, outbound_store=None):
        self.db_path = db_path
        self.client = client or AvaActionClient()
        self.outbound_store = outbound_store
        self._action_registry = {}
        self._rate_limits = {"send_whatsapp": (30, 60), "make_call": (10, 60), "launch_campaign": (2, 60), "change_price": (5, 60), "cancel_booking": (5, 60), "send_followup": (20, 60), "approve_followup": (20, 60)}
        self._register_default_actions()
        with get_db_connection(self.db_path) as conn:
            init_onyx_tables(conn)

    def register_action(self, name, tier, required_schema, handler, description=""):
        self._action_registry[name] = {"tier": tier, "schema": required_schema, "handler": handler, "description": description}

    def _register_default_actions(self):
        definitions = [
            ("get_customer", ActionTier.READ, {"customer_id": int}),
            ("get_booking", ActionTier.READ, {"booking_number": str, "surname": str}),
            ("get_availability", ActionTier.READ, {"date_from": str, "date_to": str}),
            ("get_hotel_info", ActionTier.READ, {}),
            ("get_call_history", ActionTier.READ, {"customer_id": int}),
            ("get_campaign", ActionTier.READ, {"campaign_id": str}),
            ("update_customer", ActionTier.WRITE, {"customer_id": int, "lead_status": str}),
            ("create_task", ActionTier.WRITE, {"summary": str, "priority": str}),
            ("update_opportunity", ActionTier.WRITE, {"opportunity_id": str, "stage": str}),
            # AVA approval also sends the message: classify as critical.
            ("approve_followup", ActionTier.CRITICAL, {"draft_id": str}),
            ("send_whatsapp", ActionTier.CRITICAL, {"chat_id": str, "text": str}),
            # An existing campaign owns trunk/caller-ID, consent and context.
            ("make_call", ActionTier.CRITICAL, {"campaign_id": str, "phone": str}),
            ("launch_campaign", ActionTier.CRITICAL, {"campaign_id": str}),
            ("change_price", ActionTier.CRITICAL, {"room_category": str, "new_price": (int, float)}),
            ("cancel_booking", ActionTier.CRITICAL, {"booking_id": str, "reason": str}),
            ("send_followup", ActionTier.CRITICAL, {"draft_id": str}),
        ]
        for name, tier, schema in definitions:
            self.register_action(name, tier, schema, getattr(self, f"_handle_{name}"))

    def _validate(self, business_id, agent_id, action, arguments):
        if type(business_id) is not int or business_id < 1:
            raise PolicyGatewayError("Explicit positive business_id required", "BUSINESS_REQUIRED")
        prefix = f"ava:{business_id}:agent:"
        if not isinstance(agent_id, str) or not agent_id.startswith(prefix):
            raise PolicyGatewayError("Agent business scope mismatch", "CROSS_TENANT_FORBIDDEN")
        if not isinstance(action, str) or action not in self._action_registry:
            raise PolicyGatewayError("Action is not registered", "ACTION_NOT_FOUND")
        if action not in self.ROLE_ACTIONS.get(agent_id[len(prefix):], set()):
            raise PolicyGatewayError("Action forbidden for this agent role", "ROLE_FORBIDDEN")
        self._validate_schema(action, self._action_registry[action]["schema"], arguments)
        with get_db_connection(self.db_path) as conn:
            if not conn.execute("SELECT id FROM instances WHERE id=? AND isActive=1", (business_id,)).fetchone():
                raise PolicyGatewayError("Business not found or disabled", "BUSINESS_NOT_FOUND")

    def _validate_schema(self, action, schema, arguments):
        if not isinstance(arguments, dict) or set(arguments) != set(schema):
            raise PolicyGatewayError("Arguments must match the exact action schema", "INVALID_SCHEMA")
        for name, expected in schema.items():
            value = arguments[name]
            if isinstance(value, bool) or not isinstance(value, expected):
                raise PolicyGatewayError(f"Invalid type for {name}", "INVALID_PARAMETER_TYPE")
            if isinstance(value, (int, float)) and (not math.isfinite(value) or value < 0):
                raise PolicyGatewayError(f"Invalid number for {name}", "INVALID_SCHEMA")
            if isinstance(value, str) and (not value.strip() or len(value) > 2000):
                raise PolicyGatewayError(f"Invalid length for {name}", "INVALID_SCHEMA")
        if "priority" in arguments and arguments["priority"] not in {"low", "normal", "high", "urgent"}:
            raise PolicyGatewayError("Invalid priority", "INVALID_SCHEMA")
        if action == "make_call" and not re.fullmatch(r"\+?[1-9][0-9]{7,14}", arguments["phone"]):
            raise PolicyGatewayError("International phone number required, not a SIP dial string", "INVALID_PHONE")

    def issue_approval(self, *, business_id, agent_id, action, arguments, approved_by):
        """Only authenticated operator endpoints may issue approvals, never tools."""
        self._validate(business_id, agent_id, action, arguments)
        if not approved_by or self._action_registry[action]["tier"] != ActionTier.CRITICAL:
            raise PolicyGatewayError("Critical action and authenticated approver required", "APPROVAL_INVALID")
        token = secrets.token_urlsafe(32)
        expires = time.time() + 600
        with get_db_connection(self.db_path) as conn:
            conn.execute("""INSERT INTO onyx_action_approvals
                (token_hash,business_id,agent_id,action,arguments_hash,approved_by,expires_at)
                VALUES (?,?,?,?,?,?,?)""", (hashlib.sha256(token.encode()).hexdigest(), business_id, agent_id, action, _hash(arguments), str(approved_by), expires))
            conn.commit()
        return {"approval_token": token, "business_id": business_id, "action": action, "expires_at": expires}

    def execute_action(self, business_id, agent_id, action, arguments, user_id=None, idempotency_key=None, approval_token=None):
        try:
            return self._execute_action(business_id, agent_id, action, arguments, user_id, idempotency_key, approval_token)
        except PolicyGatewayError as error:
            if type(business_id) is int and business_id > 0:
                self._log_audit(str(uuid.uuid4()), business_id, user_id, str(agent_id), str(action), "rejected", "DENIED", None, {"error_code": error.code})
            raise

    def _execute_action(self, business_id, agent_id, action, arguments, user_id, idempotency_key, approval_token):
        self._validate(business_id, agent_id, action, arguments)
        tier = self._action_registry[action]["tier"]
        if tier != ActionTier.READ and (not isinstance(idempotency_key, str) or not idempotency_key.strip()):
            raise PolicyGatewayError("Writes require a stable idempotency key", "IDEMPOTENCY_REQUIRED")
        key = idempotency_key or str(uuid.uuid4())
        if not isinstance(key, str) or len(key) > 200:
            raise PolicyGatewayError("Invalid idempotency key", "INVALID_SCHEMA")
        event_id = f"action:{business_id}:{hashlib.sha256(key.encode()).hexdigest()}"
        args_hash, now = _hash(arguments), time.time()
        with get_db_connection(self.db_path) as conn:
            conn.execute("BEGIN IMMEDIATE")
            row = conn.execute("SELECT * FROM onyx_action_audit WHERE business_id=? AND event_id=?", (business_id, event_id)).fetchone()
            if row:
                if row["arguments_hash"] != args_hash or row["action"] != action or row["agent_id"] != agent_id:
                    raise PolicyGatewayError("Idempotency key bound to different arguments", "IDEMPOTENCY_CONFLICT")
                if row["status"] == "EXECUTED" and row["result_json"] is not None:
                    return {"event_id": event_id, "action": action, "tier": tier.value, "status": "EXECUTED (CACHED)", "result": json.loads(row["result_json"])}
                raise PolicyGatewayError("Action running or outcome needs reconciliation", "ACTION_RECONCILIATION_REQUIRED")
            approved_by = None
            if tier == ActionTier.CRITICAL:
                if not isinstance(approval_token, str) or not approval_token:
                    raise PolicyGatewayError("Authenticated operator approval required", "APPROVAL_REQUIRED")
                approval = conn.execute("SELECT * FROM onyx_action_approvals WHERE token_hash=?", (hashlib.sha256(approval_token.encode()).hexdigest(),)).fetchone()
                if not approval or approval["business_id"] != business_id or approval["agent_id"] != agent_id or approval["action"] != action or approval["arguments_hash"] != args_hash or approval["expires_at"] <= now or approval["consumed_event_id"]:
                    raise PolicyGatewayError("Approval expired, consumed or does not match action", "APPROVAL_INVALID")
                approved_by = approval["approved_by"]
                limit, seconds = self._rate_limits.get(action, (10, 60))
                count = conn.execute("SELECT COUNT(*) FROM onyx_action_audit WHERE business_id=? AND action=? AND started_at_epoch>?", (business_id, action, now-seconds)).fetchone()[0]
                if count >= limit:
                    raise PolicyGatewayError("Action rate limit exceeded", "RATE_LIMIT_EXCEEDED")
                conn.execute("UPDATE onyx_action_approvals SET consumed_event_id=? WHERE token_hash=?", (event_id, approval["token_hash"]))
            conn.execute("""INSERT INTO onyx_action_audit
                (event_id,business_id,user_id,agent_id,action,arguments_hash,status,payload_json,started_at_epoch)
                VALUES (?,?,?,?,?,?,'PROCESSING',?,?)""", (event_id, business_id, approved_by or user_id or "system", agent_id, action, args_hash, _json({"argument_fields": sorted(arguments)}), now))
            conn.commit()
        context_token = _execution.set({"event_id": event_id, "approved_by": approved_by})
        try:
            result = _safe(self._action_registry[action]["handler"](business_id=business_id, **arguments))
            encoded = _json(result)
            if len(encoded.encode()) > 256 * 1024:
                raise PolicyGatewayError("Action response too large", "RESULT_TOO_LARGE")
            with get_db_connection(self.db_path) as conn:
                conn.execute("""UPDATE onyx_action_audit SET status='EXECUTED',result_json=?,result_hash=?,finished_at_epoch=?
                    WHERE business_id=? AND event_id=? AND status='PROCESSING'""", (encoded, _hash(result), time.time(), business_id, event_id))
                conn.commit()
            return {"event_id": event_id, "action": action, "tier": tier.value, "status": "EXECUTED", "result": result}
        except Exception as error:
            code = getattr(error, "code", "EXECUTION_FAILED")
            with get_db_connection(self.db_path) as conn:
                conn.execute("""UPDATE onyx_action_audit SET status='FAILED',payload_json=?,finished_at_epoch=?
                    WHERE business_id=? AND event_id=? AND status='PROCESSING'""", (_json({"error_code": code, "error": redact_onyx_error(error)}), time.time(), business_id, event_id))
                conn.commit()
            raise PolicyGatewayError(str(error), code) from None
        finally:
            _execution.reset(context_token)

    def _log_audit(self, event_id, business_id, user_id, agent_id, action, arguments_hash, status, result_hash, payload):
        # Compatibility for cutover/rollback. Never overwrite another event.
        with get_db_connection(self.db_path) as conn:
            conn.execute("""INSERT INTO onyx_action_audit
                (event_id,business_id,user_id,agent_id,action,arguments_hash,status,result_hash,payload_json)
                VALUES (?,?,?,?,?,?,?,?,?)""", (f"audit:{business_id}:{event_id}:{uuid.uuid4()}", business_id, user_id or "system", agent_id, action, arguments_hash, status, result_hash, _json(_safe(payload))))
            conn.commit()

    def _crm(self, business_id, path, payload):
        context = _execution.get() or {}
        return self.client.post(path, business_id, {**payload, "source": "onyx_policy_gateway", "correlation_id": context.get("event_id")})

    def _customer(self, business_id, customer_id):
        with get_db_connection(self.db_path) as conn:
            row = conn.execute("SELECT id,chatId,senderName,leadStatus FROM clients WHERE id=? AND instanceId=?", (customer_id, business_id)).fetchone()
        if not row:
            raise PolicyGatewayError("Customer not found in this business", "CUSTOMER_NOT_FOUND")
        return dict(row)

    def _handle_get_customer(self, business_id, customer_id):
        from src.core.onyx_customer_context import CustomerContextManager
        customer = self._customer(business_id, customer_id)
        context = CustomerContextManager(self.db_path).get_customer_context(business_id, customer_id)
        if context is None:
            raise PolicyGatewayError("Customer or business is unavailable", "CUSTOMER_NOT_FOUND")
        return {"found": True, "customer": {'id':customer['id'], 'senderName':context['profile']['name'],
                                            'leadStatus':context['profile']['lead_stage']},
                "context": context}

    def _handle_get_booking(self, business_id, booking_number, surname):
        return self._crm(business_id, "/pms/lookup-booking", {"booking_number": booking_number, "surname": surname})

    def _handle_get_availability(self, business_id, date_from, date_to):
        return self._crm(business_id, "/pms/check-availability", {"date_from": date_from, "date_to": date_to})

    def _handle_get_hotel_info(self, business_id):
        with get_db_connection(self.db_path) as conn:
            row = conn.execute("SELECT id,name,businessType FROM instances WHERE id=?", (business_id,)).fetchone()
        return {"hotel": dict(row)}

    def _handle_get_call_history(self, business_id, customer_id):
        from src.core.onyx_customer_context import CustomerContextManager
        customer = self._customer(business_id, customer_id)
        summaries = CustomerContextManager(self.db_path).get_recent_call_summaries_for_client(
            business_id, customer['chatId'], limit=20)
        return {"business_id": business_id, "customer_id": customer_id, "call_summaries": summaries}

    def _store(self):
        if self.outbound_store is None:
            from src.core.outbound_store import get_outbound_store
            self.outbound_store = get_outbound_store()
        return self.outbound_store

    def _campaign(self, business_id, campaign_id):
        campaign = self._store().get_campaign_sync(campaign_id)
        if not campaign or int(campaign.get("business_id") or 0) != business_id:
            raise PolicyGatewayError("Campaign not found in this business", "CAMPAIGN_NOT_FOUND")
        return campaign

    def _handle_get_campaign(self, business_id, campaign_id):
        campaign = self._campaign(business_id, campaign_id)
        return {"campaign": {key: campaign.get(key) for key in ("id", "business_id", "name", "status", "context", "max_attempts", "is_test")}}

    def _handle_update_customer(self, business_id, customer_id, lead_status):
        customer = self._customer(business_id, customer_id)
        return self._crm(business_id, "/stage/update", {"chatId": customer["chatId"], "stage": lead_status})

    def _handle_create_task(self, business_id, summary, priority):
        task_id = "task_onyx_" + hashlib.sha256(_execution.get()["event_id"].encode()).hexdigest()
        result = self._crm(business_id, "/manager-task", {"taskId": task_id, "summary": summary, "priority": priority, "reason": "manual"})
        if not result.get("task_id"):
            raise PolicyGatewayError("AVA did not confirm a persisted task", "TASK_NOT_CONFIRMED")
        return result

    def _handle_update_opportunity(self, business_id, opportunity_id, stage):
        # AVA has no opportunity table. Never substitute a client ID or claim
        # that a Twenty deal was updated. Persist a review request instead.
        result = self._handle_create_task(business_id, f"Запрос изменения сделки {opportunity_id}: этап {stage}", "normal")
        return {"status": "manager_review_required", "updated": False, "task_id": result["task_id"]}

    def _handle_approve_followup(self, business_id, draft_id):
        return self._crm(business_id, "/followup/approve", {"draftId": draft_id, "approvedBy": _execution.get()["approved_by"]})

    def _handle_send_whatsapp(self, business_id, chat_id, text):
        draft = self._crm(business_id, "/followup/draft", {"chatId": chat_id, "text": text})
        if not draft.get("draft_id"):
            raise PolicyGatewayError("AVA did not confirm a persisted draft", "DRAFT_NOT_CONFIRMED")
        return self._handle_approve_followup(business_id, draft["draft_id"])

    def _handle_make_call(self, business_id, campaign_id, phone):
        self._campaign(business_id, campaign_id)
        run = asyncio.run(self._store().create_test_campaign(campaign_id, phone, business_id=business_id, name="Onyx: approved one-number call"))
        return {"business_id": business_id, "status": "scheduled", "initiated": False, "campaign_id": run["test_campaign"]["id"], "lead_id": run["lead"]["id"], "max_attempts": 1}

    def _handle_launch_campaign(self, business_id, campaign_id):
        self._campaign(business_id, campaign_id)
        result = asyncio.run(self._store().set_campaign_status(campaign_id, "running", business_id=business_id))
        return {"campaign_id": result["id"], "business_id": business_id, "status": result["status"]}

    def _handle_change_price(self, business_id, room_category, new_price):
        result = self._handle_create_task(business_id, f"Запрос изменения тарифа: {room_category}, цена {new_price}. Проверить валюту и даты в PMS.", "normal")
        return {"status": "manager_review_required", "price_changed": False, "task_id": result["task_id"]}

    def _handle_cancel_booking(self, business_id, booking_id, reason):
        result = self._handle_create_task(business_id, f"Запрос отмены брони {booking_id}. Причина: {reason}. Проверить личность гостя и условия в PMS.", "high")
        return {"status": "manager_review_required", "canceled": False, "task_id": result["task_id"]}

    def _handle_send_followup(self, business_id, draft_id):
        return self._crm(business_id, "/followup/send", {"draftId": draft_id, "confirmed": True})
