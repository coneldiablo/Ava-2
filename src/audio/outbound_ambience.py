"""A bounded, caller-output-only office loop. No inbound audio is processed."""
import asyncio
import audioop
import contextlib
import math
import struct
import wave


def load_office_loop(path):
    with wave.open(str(path), 'rb') as source:
        if (source.getnchannels(), source.getsampwidth(), source.getframerate()) != (1, 2, 8000):
            raise ValueError('ambience_format')
        if not 160 <= source.getnframes() <= 8000 * 300:
            raise ValueError('ambience_length')
        return source.readframes(source.getnframes())


class OutboundAmbience:
    """One 20 ms writer owns voice and ambience, including idle periods.

    The normal voice pacer remains upstream. At most 40 ms of voice is buffered;
    clear() removes only that buffer during barge-in, leaving the office loop.
    """
    FRAME = 320  # 160 PCM16 samples, 8 kHz, 20 ms.
    LIMIT = FRAME * 2

    def __init__(self, pcm, encoding, write, volume=1.0):
        if not pcm or len(pcm) % 2 or encoding not in ('ulaw', 'pcm16'):
            raise ValueError('ambience_format')
        if isinstance(volume, bool) or not isinstance(volume, (int, float)) or not math.isfinite(volume) or not 0 <= volume <= 1:
            raise ValueError('ambience_volume')
        self.pcm, self.encoding, self.write = audioop.mul(pcm, 2, volume), encoding, write
        self.cursor = 0
        self.voice = bytearray()
        self.condition = asyncio.Condition()
        self.closed = False
        self.task = asyncio.create_task(self._run())

    async def send(self, data):
        pcm = audioop.ulaw2lin(data, 2) if self.encoding == 'ulaw' else data
        if len(pcm) % 2:
            return False
        offset = 0
        async with self.condition:
            while offset < len(pcm):
                await self.condition.wait_for(lambda: self.closed or len(self.voice) < self.LIMIT)
                if self.closed:
                    return False
                size = min(len(pcm) - offset, self.LIMIT - len(self.voice))
                self.voice.extend(pcm[offset:offset + size])
                offset += size
        return not self.closed

    async def clear(self):
        async with self.condition:
            self.voice.clear()
            self.condition.notify_all()

    def _bed(self):
        # The final partial frame wraps without adding a silent frame or dropping
        # samples. The prepared asset fades at the loop seam and limits peaks.
        needed, parts = self.FRAME, []
        while needed:
            size = min(needed, len(self.pcm) - self.cursor)
            parts.append(self.pcm[self.cursor:self.cursor + size])
            self.cursor = (self.cursor + size) % len(self.pcm)
            needed -= size
        return b''.join(parts)

    @staticmethod
    def _mix(voice, bed):
        # Sum at wider precision before limiting; audioop.add would clip first.
        # Only near-full-scale foreground needs headroom; normal voice is exact.
        samples = [a[0] + b[0] for a, b in zip(struct.iter_unpack('<h', voice), struct.iter_unpack('<h', bed))]
        peak = max(abs(value) for value in samples)
        gain = min(1.0, 32700 / peak) if peak else 1.0
        return struct.pack('<160h', *(int(value * gain) for value in samples))

    async def _run(self):
        clock = asyncio.get_running_loop()
        due = clock.time()
        try:
            while not self.closed:
                await asyncio.sleep(max(0, due - clock.time()))
                async with self.condition:
                    voice = bytes(self.voice[:self.FRAME])
                    del self.voice[:self.FRAME]
                    self.condition.notify_all()
                mixed = self._mix(voice.ljust(self.FRAME, b'\0'), self._bed())
                data = audioop.lin2ulaw(mixed, 2) if self.encoding == 'ulaw' else mixed
                if not await self.write(data):
                    return
                # Do not burst accumulated office frames after event-loop stalls.
                due = max(due + .02, clock.time())
        finally:
            self.closed = True
            async with self.condition:
                self.voice.clear()
                self.condition.notify_all()

    async def close(self):
        self.closed = True
        self.task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await self.task
