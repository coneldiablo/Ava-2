"""
Onyx Migration & Synchronization API Router
Provides standard endpoints for Onyx Knowledge Connector, Outbox Worker management,
and Tenant Sync status.
"""

from typing import Dict, Any, List, Optional
from fastapi import APIRouter, HTTPException, Query, Body, Depends
import auth

from src.core.onyx_connector import AVAOnyxConnector
from src.core.onyx_outbox_worker import OnyxOutboxWorker
from src.core.onyx_db import get_db_connection
from src.core.onyx_tenant_service import OnyxTenantService

router = APIRouter(prefix="/api/onyx", tags=["onyx"])


def _tenant_service_error(error: Exception) -> HTTPException:
    return HTTPException(
        status_code=int(getattr(error, "status_code", 400)),
        detail={
            "code": getattr(error, "code", "ONYX_CONFIGURATION_ERROR"),
            "message": str(error),
        },
    )


@router.get("/tenants/{business_id}")
async def get_onyx_tenant(business_id: int):
    try:
        return {"onyx": OnyxTenantService().public(business_id)}
    except Exception as error:
        raise _tenant_service_error(error) from error


@router.put("/tenants/{business_id}")
async def configure_onyx_tenant(business_id: int, payload: Dict[str, Any] = Body(...)):
    """Store only a credential environment-variable reference, never the API key."""
    try:
        return {"onyx": OnyxTenantService().configure(business_id, payload)}
    except Exception as error:
        raise _tenant_service_error(error) from error


@router.post("/tenants/{business_id}/test")
async def test_onyx_tenant(business_id: int):
    try:
        return {"onyx": await OnyxTenantService().test_connection(business_id)}
    except Exception as error:
        raise _tenant_service_error(error) from error


@router.put("/tenants/{business_id}/readiness")
async def record_onyx_readiness(business_id: int, payload: Dict[str, Any] = Body(...)):
    try:
        revision = payload.get("revision")
        if not isinstance(revision, int) or isinstance(revision, bool) or revision < 1:
            raise ValueError("ONYX_CONFIGURATION_REVISION_REQUIRED")
        return {"onyx": OnyxTenantService().update_readiness(
            business_id, payload.get("evidence") or {}, expected_revision=revision)}
    except Exception as error:
        raise _tenant_service_error(error) from error


@router.delete("/tenants/{business_id}")
async def disable_onyx_tenant(business_id: int):
    try:
        return {"onyx": OnyxTenantService().disable(business_id)}
    except Exception as error:
        raise _tenant_service_error(error) from error


@router.post("/tenants/{business_id}/sync")
async def sync_onyx_tenant(business_id: int):
    try:
        service = OnyxTenantService()
        tenant = service.public(business_id)
        if tenant.get("status") not in {"STAGING", "ACTIVE", "ACTIVE_LIVE"}:
            raise HTTPException(status_code=409, detail={
                "code": "ONYX_CONNECTION_NOT_VERIFIED",
                "message": "Сначала проверьте подключение Onyx",
            })
        from src.core.onyx_migration_runner import OnyxKnowledgeMigrator
        report = OnyxKnowledgeMigrator().run_migration(business_id=business_id, dry_run=False)
        return {"business_id": business_id, "queued": report["counts"]["imported_count"] + report["counts"]["updated_count"], "report": report}
    except HTTPException:
        raise
    except Exception as error:
        raise _tenant_service_error(error) from error

@router.get("/knowledge")
async def get_onyx_knowledge(
    business_id: int = Query(..., description="AVA business_id / instanceId"),
    since: Optional[str] = Query(None, description="ISO timestamp for incremental sync"),
    slim: bool = Query(False, description="Return lightweight ID/hash list")
):
    """
    Endpoint for Onyx Knowledge Connector to fetch documents (full, incremental, or slim).
    """
    connector = AVAOnyxConnector()
    if slim:
        return {"documents": connector.slim(business_id=business_id)}
    elif since:
        return {"documents": connector.poll(business_id=business_id, since_timestamp=since)}
    else:
        return {"documents": connector.load(business_id=business_id)}

@router.get("/knowledge/{doc_id}")
async def get_onyx_document(
    doc_id: int,
    business_id: int = Query(..., description="AVA business_id / instanceId")
):
    """Fetch single document formatted for Onyx ingestion."""
    connector = AVAOnyxConnector()
    docs = connector.get_documents(business_id=business_id, doc_ids=[doc_id])
    if not docs:
        raise HTTPException(status_code=404, detail="Document not found")
    return {"document": docs[0]}

@router.get("/tenants/{business_id}/status")
async def get_tenant_onyx_status(business_id: int):
    """Get tenant link details, synchronization status, and outbox metrics."""
    connector = AVAOnyxConnector()
    creds = connector.get_credentials(business_id=business_id)

    with get_db_connection() as conn:
        cursor = conn.cursor()
        cursor.execute("""
            SELECT status, COUNT(*) as cnt
            FROM onyx_sync_outbox
            WHERE business_id = ?
            GROUP BY status
        """, (business_id,))
        outbox_stats = {row["status"]: row["cnt"] for row in cursor.fetchall()}

        cursor.execute("""
            SELECT COUNT(*) as synced_count
            FROM onyx_document_links
            WHERE business_id = ?
        """, (business_id,))
        synced_docs = cursor.fetchone()["synced_count"]

    return {
        "business_id": business_id,
        "tenant_link": creds,
        "synced_documents_count": synced_docs,
        "outbox_status": outbox_stats
    }

@router.post("/outbox/process")
async def trigger_outbox_processing(limit: int = Query(10, ge=1, le=100)):
    """Trigger background batch processing of pending outbox sync events."""
    worker = OnyxOutboxWorker()
    leased = worker.lease_events(limit=limit)
    processed = 0
    for event in leased:
        ok = await worker.process_single_event(event)
        if ok:
            processed += 1

    return {
        "leased_events": len(leased),
        "processed_events": processed,
        "status": "success"
    }

@router.get("/customer/{customer_id}/context")
async def get_customer_context_endpoint(
    customer_id: int,
    business_id: int = Query(..., description="AVA business_id / instanceId")
):
    """
    Read-only Customer Context endpoint for Onyx AI Agents.
    Returns unified profile, lead stage, interests, objections, dates, and summarized history.
    """
    from src.core.onyx_customer_context import CustomerContextManager
    ctx_mgr = CustomerContextManager()
    ctx = ctx_mgr.get_customer_context(business_id=business_id, customer_id=customer_id)
    if not ctx:
        raise HTTPException(status_code=404, detail=f"Customer #{customer_id} not found for business #{business_id}")
    return {"customer_context": ctx}

@router.get("/calls/{call_id}/summary")
async def get_call_summary_endpoint(
    call_id: str,
    business_id: int = Query(..., gt=0, description="AVA business_id / instanceId"),
    customer_id: int = Query(..., gt=0, description="AVA customer id in this business")
):
    """
    Read-only Call Summary endpoint for Onyx AI Agents.
    Returns structured summary and next steps without raw audio or ARI state machines.
    """
    from src.core.onyx_customer_context import CustomerContextManager
    ctx_mgr = CustomerContextManager()
    summary = ctx_mgr.get_single_call_summary(business_id=business_id, call_id=call_id, customer_id=customer_id)
    if not summary:
        raise HTTPException(status_code=404, detail=f"Call summary #{call_id} not found for business #{business_id}")
    return {"call_summary": summary}

@router.post("/actions/execute")
def execute_agent_action_endpoint(
    payload: Dict[str, Any] = Body(..., description="Action request payload"),
    current_user=Depends(auth.get_current_user),
):
    """
    Unified Policy Gateway endpoint for Onyx Agent Actions (READ, WRITE, CRITICAL).
    Validates tenant scope, authorization, parameters, rate-limits, and logs audit trail.
    """
    from src.core.onyx_policy_gateway import PolicyGateway, PolicyGatewayError

    business_id = payload.get("business_id")
    agent_id = payload.get("agent_id")
    action = payload.get("action")
    arguments = payload.get("arguments", {})
    user_id = current_user.username
    idempotency_key = payload.get("idempotency_key")

    if not business_id or not agent_id or not action:
        raise HTTPException(status_code=400, detail="Fields 'business_id', 'agent_id', and 'action' are required.")

    gateway = PolicyGateway()
    try:
        result = gateway.execute_action(
            business_id=business_id,
            agent_id=str(agent_id),
            action=str(action),
            arguments=arguments,
            user_id=user_id,
            idempotency_key=idempotency_key,
            approval_token=payload.get("approval_token"),
        )
        return result
    except PolicyGatewayError as e:
        status_code = 403 if "FORBIDDEN" in e.code or "DENIED" in e.code else 422
        raise HTTPException(status_code=status_code, detail={"error": str(e), "code": e.code})


@router.post("/actions/approvals")
def approve_agent_action_endpoint(
    payload: Dict[str, Any] = Body(...),
    current_user=Depends(auth.get_current_user),
):
    """Operator-only capability issuance. Never expose as an Onyx/LLM tool."""
    from src.core.onyx_policy_gateway import PolicyGateway, PolicyGatewayError
    try:
        return PolicyGateway().issue_approval(
            business_id=payload.get("business_id"),
            agent_id=payload.get("agent_id"),
            action=payload.get("action"),
            arguments=payload.get("arguments", {}),
            approved_by=current_user.username,
        )
    except PolicyGatewayError as error:
        raise HTTPException(status_code=422, detail={"code": error.code, "error": str(error)}) from error

@router.get("/cutover/criteria")
async def get_cutover_criteria_endpoint(
    business_id: int = Query(..., description="AVA business_id / instanceId")
):
    """Evaluate Go / No-Go readiness criteria and cutover checklist."""
    from src.core.onyx_cutover_manager import OnyxCutoverManager
    manager = OnyxCutoverManager()
    return manager.check_go_no_go_criteria(business_id=business_id)

@router.post("/cutover/enable")
async def enable_cutover_endpoint(
    payload: Dict[str, Any] = Body(..., description="Cutover payload")
):
    """Enable live traffic routing to Onyx AI Agent for tenant."""
    from src.core.onyx_cutover_manager import OnyxCutoverManager
    business_id = payload.get("business_id")
    if not business_id:
        raise HTTPException(status_code=400, detail="Field 'business_id' is required.")
    
    manager = OnyxCutoverManager()
    result = manager.enable_live_cutover(business_id=int(business_id))
    if not result.get("success"):
        raise HTTPException(status_code=412, detail=result)
    return result

@router.post("/cutover/rollback")
async def rollback_cutover_endpoint(
    payload: Dict[str, Any] = Body(..., description="Rollback payload")
):
    """Trigger emergency zero-downtime rollback to AVA Core fallback."""
    from src.core.onyx_cutover_manager import OnyxCutoverManager
    business_id = payload.get("business_id")
    reason = payload.get("reason", "Manual operator rollback")
    if not business_id:
        raise HTTPException(status_code=400, detail="Field 'business_id' is required.")
    
    manager = OnyxCutoverManager()
    return manager.execute_instant_rollback(business_id=int(business_id), reason=reason)
