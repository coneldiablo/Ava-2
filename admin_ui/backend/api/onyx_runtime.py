"""CRM-to-knowledge runtime API; separate from browser/admin configuration."""
import asyncio
from typing import Literal

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field, StrictInt

from api.outbound import _require_sales_brain_service_token
from src.core.onyx_knowledge_runtime import OnyxKnowledgeRuntime

router = APIRouter(prefix='/api/internal/onyx', tags=['onyx-runtime'],
                   dependencies=[Depends(_require_sales_brain_service_token)])


class KnowledgeRequest(BaseModel):
    business_id: StrictInt = Field(gt=0)
    question: str = Field(min_length=1, max_length=8000)
    channel: Literal['voice', 'whatsapp']
    correlation_id: str = Field(min_length=1, max_length=160)
    customer_id: StrictInt | None = Field(default=None, gt=0)

    class Config:
        extra = 'forbid'


@router.post('/knowledge')
async def knowledge(payload: KnowledgeRequest):
    return await OnyxKnowledgeRuntime().answer(**payload.dict())


# Explicit diagnostic route. It uses the same tenant/source guards, never
# switches a hotel to live, sends messages, or creates tasks/bookings.
async def _preview_until_disconnect(request: Request, payload: KnowledgeRequest):
    # A browser cancel closes the CRM upstream socket. Stop the Onyx task so
    # the runner can fence generation and end its incognito session.
    answer = asyncio.create_task(OnyxKnowledgeRuntime().answer(**payload.dict(), preview=True))

    async def disconnected():
        while not answer.done():
            if await request.is_disconnected():
                return True
            await asyncio.sleep(0.1)
        return False

    watcher = asyncio.create_task(disconnected())
    try:
        done, _ = await asyncio.wait({answer, watcher}, return_when=asyncio.FIRST_COMPLETED)
        if watcher in done and watcher.result():
            answer.cancel()
            await asyncio.gather(answer, return_exceptions=True)
            return None  # The peer is gone; no answer can be delivered.
        return await answer
    finally:
        watcher.cancel()
        await asyncio.gather(watcher, return_exceptions=True)
        if not answer.done():
            answer.cancel()
            await asyncio.gather(answer, return_exceptions=True)


@router.post('/knowledge/preview')
async def preview_knowledge(payload: KnowledgeRequest, request: Request):
    return await _preview_until_disconnect(request, payload)
