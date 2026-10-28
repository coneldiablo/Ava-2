"""
AVA ↔ Onyx Resilience Layer (Circuit Breaker & Fallback Protection)
Ensures AVA operational runtime (SIP/ARI, WhatsApp, Campaigns) remains 100% resilient
even if Onyx AI Layer experiences degradation, high latency, or outages.
"""

import time
import asyncio
import logging
from enum import Enum
from typing import Optional, Callable, Any, Dict

logger = logging.getLogger("ava.onyx.resilience")


class CircuitState(str, Enum):
    CLOSED = "CLOSED"      # Normal state, all traffic goes to Onyx
    OPEN = "OPEN"          # Onyx is down; fail-fast with fallback immediately
    HALF_OPEN = "HALF_OPEN"# Trial state to probe if Onyx has recovered


class OnyxCircuitBreaker:
    """
    Circuit Breaker implementation protecting AVA against Onyx downtime or slow responses.
    """
    def __init__(
        self,
        failure_threshold: int = 3,
        recovery_timeout: float = 30.0,
        request_timeout: float = 2.0
    ):
        self.failure_threshold = failure_threshold
        self.recovery_timeout = recovery_timeout
        self.request_timeout = request_timeout
        
        self.state = CircuitState.CLOSED
        self.failure_count = 0
        self.last_state_change = time.time()
        self.last_failure_time = 0.0

    def can_execute(self) -> bool:
        """Check if request is allowed to pass to Onyx."""
        now = time.time()
        if self.state == CircuitState.OPEN:
            if now - self.last_state_change >= self.recovery_timeout:
                logger.info("[OnyxCircuitBreaker] Recovery timeout expired. Moving to HALF_OPEN.")
                self.state = CircuitState.HALF_OPEN
                self.last_state_change = now
                return True
            return False
        return True

    def record_success(self):
        """Record successful call to Onyx."""
        if self.state != CircuitState.CLOSED:
            logger.info("[OnyxCircuitBreaker] Onyx responded successfully. Moving to CLOSED.")
        self.state = CircuitState.CLOSED
        self.failure_count = 0
        self.last_state_change = time.time()

    def record_failure(self, error: Optional[Exception] = None):
        """Record failed or timed-out call to Onyx."""
        self.failure_count += 1
        self.last_failure_time = time.time()
        logger.warning(
            f"[OnyxCircuitBreaker] Recorded failure #{self.failure_count} (state: {self.state}): {error}"
        )
        if self.state in (CircuitState.CLOSED, CircuitState.HALF_OPEN):
            if self.failure_count >= self.failure_threshold:
                logger.error("[OnyxCircuitBreaker] Failure threshold reached. Tripping to OPEN state.")
                self.state = CircuitState.OPEN
                self.last_state_change = time.time()

    async def execute(
        self,
        async_func: Callable[..., Any],
        *args,
        fallback_value: Any = None,
        fallback_func: Optional[Callable[..., Any]] = None,
        **kwargs
    ) -> Any:
        """
        Execute an async call to Onyx protected by timeout, circuit breaker and fallback.
        AVA callers are guaranteed to never hang or crash if Onyx fails.
        """
        if not self.can_execute():
            logger.debug("[OnyxCircuitBreaker] Circuit is OPEN. Triggering immediate fallback.")
            return await self._handle_fallback(fallback_value, fallback_func, *args, **kwargs)

        try:
            result = await asyncio.wait_for(
                async_func(*args, **kwargs),
                timeout=self.request_timeout
            )
            self.record_success()
            return result
        except asyncio.TimeoutError as e:
            logger.warning(f"[OnyxCircuitBreaker] Call timed out after {self.request_timeout}s: {async_func.__name__}")
            self.record_failure(e)
            return await self._handle_fallback(fallback_value, fallback_func, *args, **kwargs)
        except Exception as e:
            logger.error(f"[OnyxCircuitBreaker] Call failed: {async_func.__name__}, error: {e}")
            self.record_failure(e)
            return await self._handle_fallback(fallback_value, fallback_func, *args, **kwargs)

    async def _handle_fallback(
        self,
        fallback_value: Any,
        fallback_func: Optional[Callable[..., Any]],
        *args,
        **kwargs
    ) -> Any:
        if fallback_func is not None:
            if asyncio.iscoroutinefunction(fallback_func):
                return await fallback_func(*args, **kwargs)
            return fallback_func(*args, **kwargs)
        return fallback_value

    def get_status(self) -> Dict[str, Any]:
        return {
            "state": self.state.value,
            "failure_count": self.failure_count,
            "failure_threshold": self.failure_threshold,
            "recovery_timeout_sec": self.recovery_timeout,
            "request_timeout_sec": self.request_timeout,
            "is_operational": self.state != CircuitState.OPEN
        }
