"""Lifecycle wrapper for the asynchronous Onyx outbox worker."""

from __future__ import annotations

import asyncio
import logging
import os
from typing import Optional

from src.core.onyx_outbox_worker import OnyxOutboxWorker


logger = logging.getLogger("ava.onyx.runtime")


class OnyxWorkerRuntime:
    def __init__(self, db_path: Optional[str] = None):
        self.db_path = db_path
        self.task: Optional[asyncio.Task] = None
        self.stop_event: Optional[asyncio.Event] = None

    def start(self) -> bool:
        if self.task and not self.task.done():
            return True
        if str(os.getenv("ONYX_SYNC_ENABLED", "false")).lower() not in {"1", "true", "yes"}:
            logger.info("Onyx outbox worker is disabled")
            return False
        self.stop_event = asyncio.Event()
        self.task = asyncio.create_task(self._run(), name="ava-onyx-outbox")
        return True

    async def stop(self) -> None:
        if not self.task:
            return
        if self.stop_event:
            self.stop_event.set()
        try:
            await asyncio.wait_for(self.task, timeout=10)
        except asyncio.TimeoutError:
            self.task.cancel()
        finally:
            self.task = None

    async def _run(self) -> None:
        worker = OnyxOutboxWorker(db_path=self.db_path)
        interval = max(1.0, min(float(os.getenv("ONYX_SYNC_INTERVAL_SECONDS", "5")), 60.0))
        batch_size = max(1, min(int(os.getenv("ONYX_SYNC_BATCH_SIZE", "10")), 50))
        while self.stop_event and not self.stop_event.is_set():
            try:
                processed = 0
                for _ in range(batch_size):
                    if self.stop_event.is_set():
                        break
                    # Do not lease a batch whose tail can expire while earlier
                    # documents are embedding. Claim each item just before I/O.
                    events = worker.lease_events(limit=1)
                    if not events:
                        break
                    await worker.process_single_event(events[0])
                    processed += 1
                if processed:
                    await asyncio.sleep(0)
                    continue
            except asyncio.CancelledError:
                raise
            except Exception as error:
                logger.exception("Onyx outbox iteration failed: %s", error)
            try:
                await asyncio.wait_for(self.stop_event.wait(), timeout=interval)
            except asyncio.TimeoutError:
                pass
