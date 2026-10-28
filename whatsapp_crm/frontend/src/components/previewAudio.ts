// Resume inside the click gesture, before network work. Safari may reject a
// newly-created HTMLAudioElement.play() after an awaited preview request.
export function primePreviewAudio() {
    const Constructor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Constructor) return null;
    try {
        const context = new Constructor();
        const ready = context.resume().then(() => true, () => false);
        let stopped = false, source: AudioBufferSourceNode | null = null;
        return {
            async play(blob: Blob, ended: () => void) {
                if (!(await ready) || stopped) throw Error('audio_cancelled');
                const decoded = await context.decodeAudioData(await blob.arrayBuffer());
                if (stopped) throw Error('audio_cancelled');
                source = context.createBufferSource(); source.buffer = decoded;
                source.connect(context.destination); source.onended = ended; source.start();
            },
            stop() {
                stopped = true;
                if (source) { source.onended = null; try { source.stop(); } catch { /* Already ended. */ } source.disconnect(); source = null; }
                if (context.state !== 'closed') void context.close().catch(() => {});
            },
        };
    } catch { return null; }
}
