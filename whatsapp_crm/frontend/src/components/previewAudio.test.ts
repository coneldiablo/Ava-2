// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { primePreviewAudio } from './previewAudio';
afterEach(() => vi.unstubAllGlobals());
function setup() {
    const source = { buffer: null, connect: vi.fn(), start: vi.fn(), stop: vi.fn(), disconnect: vi.fn(), onended: null };
    const context = { state: 'running', destination: {}, resume: vi.fn(async () => {}), decodeAudioData: vi.fn(async () => ({ decoded: true })), createBufferSource: vi.fn(() => source), close: vi.fn(async () => {}) };
    vi.stubGlobal('AudioContext', class { constructor() { return context; } });
    return { context, source };
}
it('resumes audio during the click before the preview bytes arrive and decodes the WAV', async () => {
    const { context, source } = setup(); const audio = primePreviewAudio();
    expect(context.resume).toHaveBeenCalledTimes(1); expect(context.decodeAudioData).not.toHaveBeenCalled();
    const blob = { arrayBuffer: async () => new ArrayBuffer(48) } as Blob;
    await audio!.play(blob, vi.fn()); expect(source.start).toHaveBeenCalledTimes(1);
    audio!.stop(); expect(context.close).toHaveBeenCalledTimes(1); expect(source.stop).toHaveBeenCalledTimes(1);
});
it('cancellation during a late decode cannot start audio from an old screen', async () => {
    const { context, source } = setup(); let finish!: (v: { decoded: boolean }) => void;
    context.decodeAudioData.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const audio = primePreviewAudio(); const playing = audio!.play({ arrayBuffer: async () => new ArrayBuffer(48) } as Blob, vi.fn());
    await vi.waitFor(() => expect(context.decodeAudioData).toHaveBeenCalled()); audio!.stop(); finish({ decoded: true });
    await expect(playing).rejects.toThrow('audio_cancelled'); expect(source.start).not.toHaveBeenCalled();
});
