import asyncio
import pytest
from src.core.onyx_resilience import OnyxCircuitBreaker, CircuitState


@pytest.mark.asyncio
async def test_circuit_breaker_success():
    cb = OnyxCircuitBreaker(failure_threshold=2, request_timeout=0.5)

    async def mock_onyx_call():
        return {"result": "rag_answer", "score": 0.95}

    result = await cb.execute(mock_onyx_call)
    assert result == {"result": "rag_answer", "score": 0.95}
    assert cb.state == CircuitState.CLOSED
    assert cb.failure_count == 0


@pytest.mark.asyncio
async def test_circuit_breaker_timeout_and_fallback():
    cb = OnyxCircuitBreaker(failure_threshold=2, request_timeout=0.1)

    async def slow_onyx_call():
        await asyncio.sleep(0.3)
        return {"result": "too_late"}

    fallback_data = {"result": "local_cached_answer", "fallback": True}
    result = await cb.execute(slow_onyx_call, fallback_value=fallback_data)

    assert result == fallback_data
    assert cb.failure_count == 1
    assert cb.state == CircuitState.CLOSED


@pytest.mark.asyncio
async def test_circuit_breaker_trips_to_open():
    cb = OnyxCircuitBreaker(failure_threshold=2, recovery_timeout=0.2, request_timeout=0.05)

    async def failing_onyx_call():
        raise ConnectionError("Onyx is down")

    # Failure 1
    res1 = await cb.execute(failing_onyx_call, fallback_value="fallback_1")
    assert res1 == "fallback_1"
    assert cb.state == CircuitState.CLOSED
    assert cb.failure_count == 1

    # Failure 2 -> Trips to OPEN
    res2 = await cb.execute(failing_onyx_call, fallback_value="fallback_2")
    assert res2 == "fallback_2"
    assert cb.state == CircuitState.OPEN

    # While OPEN, immediate fallback without even calling the function
    called = False
    async def should_not_run():
        nonlocal called
        called = True
        return "unexpected"

    res3 = await cb.execute(should_not_run, fallback_value="fallback_3")
    assert res3 == "fallback_3"
    assert not called

    # Wait for recovery timeout to transition to HALF_OPEN
    await asyncio.sleep(0.25)
    assert cb.can_execute() is True
    assert cb.state == CircuitState.HALF_OPEN

    # Successful call in HALF_OPEN resets circuit to CLOSED
    async def healthy_onyx_call():
        return "recovered"

    res4 = await cb.execute(healthy_onyx_call, fallback_value="fallback_4")
    assert res4 == "recovered"
    assert cb.state == CircuitState.CLOSED
    assert cb.failure_count == 0
