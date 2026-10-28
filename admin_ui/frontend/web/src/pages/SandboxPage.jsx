import { useState, useEffect, useRef } from "react";
import { Mic, MicOff, Settings2, Play, Square, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Card, PillButton } from "@/components/ui/core";
import { api } from "@/lib/api";

export default function SandboxPage() {
  const [googleKey, setGoogleKey] = useState("");
  const [model, setModel] = useState("models/gemini-2.5-flash-native-audio-latest");
  const [systemPrompt, setSystemPrompt] = useState("You are a helpful voice assistant.");
  const [isConnected, setIsConnected] = useState(false);
  const [isConnecting, setIsConnecting] = useState(false);
  const [isMuted, setIsMuted] = useState(false);

  const wsRef = useRef(null);
  const recordCtxRef = useRef(null);
  const playCtxRef = useRef(null);
  const masterGainRef = useRef(null);   // single gain node all chunks route through
  const streamRef = useRef(null);
  const processorRef = useRef(null);
  const playbackTimeRef = useRef(0);

  // Refs for closure-safe access to current state
  const isMutedRef = useRef(false);
  const isConnectedRef = useRef(false);
  // Guard: prevents ws.onclose → disconnect() → ws.close() infinite loop
  const isClosingRef = useRef(false);

  useEffect(() => { isMutedRef.current = isMuted; }, [isMuted]);
  useEffect(() => { isConnectedRef.current = isConnected; }, [isConnected]);

  useEffect(() => {
    api.get("/api/wizard/load-config")
      .then(res => { if (res.data?.google_key) setGoogleKey(res.data.google_key); })
      .catch(() => console.warn("Failed to load google_key."));
  }, []);

  // Chunked base64 encode — String.fromCharCode(...bigArray) blows the call stack
  const encodeBase64 = (uint8Array) => {
    let binary = "";
    const chunkSize = 8192;
    for (let i = 0; i < uint8Array.length; i += chunkSize) {
      binary += String.fromCharCode(...uint8Array.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  };

  const connect = async () => {
    if (!googleKey) {
      toast.error("Google API Key is missing. Please save it in the Setup Wizard.");
      return;
    }

    isClosingRef.current = false;
    setIsConnecting(true);

    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;

      // Recording context locked to 16kHz (Gemini's required input rate)
      const recordCtx = new AudioCtx({ sampleRate: 16000 });
      recordCtxRef.current = recordCtx;

      // Playback context at the device's native sample rate (48kHz / 44.1kHz).
      // Avoids browser resampling distortion when playing 24kHz audio through
      // a 16kHz context.
      const playCtx = new AudioCtx();
      playCtxRef.current = playCtx;

      // Master gain node — all playback chunks connect here.
      // Centralises volume control and prevents pops when the context closes.
      const masterGain = playCtx.createGain();
      masterGain.gain.value = 1.0;
      masterGain.connect(playCtx.destination);
      masterGainRef.current = masterGain;

      // Start 200ms ahead so the first few chunks never underrun the scheduler
      playbackTimeRef.current = playCtx.currentTime + 0.2;

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        }
      });
      streamRef.current = stream;

      // Backend WebSocket proxy
      const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
      const wssUrl = `${protocol}//${window.location.host}/api/sandbox-ws?key=${googleKey.trim()}`;
      const ws = new WebSocket(wssUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        ws.send(JSON.stringify({
          setup: {
            model,
            generationConfig: { responseModalities: ["AUDIO"] },
            systemInstruction: { parts: [{ text: systemPrompt }] }
          }
        }));
      };

      const handleMessage = (raw) => {
        try {
          let data;
          if (typeof raw === "string") {
            data = JSON.parse(raw);
          } else {
            data = JSON.parse(new TextDecoder("utf-8").decode(raw));
          }

          console.log("[Gemini Live] msg:", JSON.stringify(data).slice(0, 200));

          const isSetupComplete = !!(
            data.setupComplete ||
            data.setup_complete ||
            data.serverContent?.setupComplete
          );

          if (isSetupComplete) {
            console.log("[Gemini Live] setupComplete — starting mic");
            setIsConnected(true);
            setIsConnecting(false);
            toast.success("Connected to Gemini Live!");
            startRecording(recordCtxRef.current, streamRef.current, wsRef.current);
          }

          if (data.serverContent?.modelTurn?.parts) {
            for (const part of data.serverContent.modelTurn.parts) {
              if (part.inlineData?.data) {
                playAudioChunk(part.inlineData.data);
              }
            }
          }
        } catch (err) {
          console.error("Message parse error", err, raw);
        }
      };

      ws.onmessage = (event) => {
        if (event.data instanceof Blob) {
          event.data.arrayBuffer().then(buf => handleMessage(new Uint8Array(buf)));
        } else {
          handleMessage(event.data);
        }
      };

      ws.onerror = (err) => console.error("[Gemini Live] WebSocket error:", err);

      ws.onclose = (e) => {
        console.log(`[Gemini Live] closed code=${e.code} reason=${e.reason}`);
        // Only show toast if we weren't the ones initiating the close
        if (!isClosingRef.current) {
          if (isConnectedRef.current) {
            toast.info("Disconnected from Gemini Live.");
          } else {
            toast.error(
              `Connection failed: Code ${e.code}.` +
              (e.reason ? ` ${e.reason}` : " Check browser console for details.")
            );
          }
        }
        cleanupAudio();
      };

    } catch (err) {
      console.error(err);
      toast.error("Failed to connect: " + err.message);
      cleanupAudio();
    }
  };

  const startRecording = (recordCtx, stream, ws) => {
    const source = recordCtx.createMediaStreamSource(stream);
    // 2048-sample buffer → lower input latency vs the previous 4096
    const processor = recordCtx.createScriptProcessor(2048, 1, 1);

    // ScriptProcessor MUST reach destination to fire, but we don't want
    // mic audio in speakers → route through gain=0 "silent sink"
    const silentGain = recordCtx.createGain();
    silentGain.gain.value = 0;

    processor.onaudioprocess = (e) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (isMutedRef.current) return;

      const channelData = e.inputBuffer.getChannelData(0);
      const pcm16 = new Int16Array(channelData.length);
      for (let i = 0; i < channelData.length; i++) {
        pcm16[i] = Math.max(-32768, Math.min(32767, channelData[i] * 32768));
      }

      ws.send(JSON.stringify({
        realtimeInput: {
          mediaChunks: [{ mimeType: "audio/pcm;rate=16000", data: encodeBase64(new Uint8Array(pcm16.buffer)) }]
        }
      }));
    };

    source.connect(processor);
    processor.connect(silentGain);
    silentGain.connect(recordCtx.destination);

    processorRef.current = { source, processor, silentGain };
  };

  const playAudioChunk = (base64) => {
    const ctx = playCtxRef.current;
    const masterGain = masterGainRef.current;
    if (!ctx || !masterGain) return;

    // Decode base64 → PCM16 → Float32
    const binary = atob(base64);
    const uint8 = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) uint8[i] = binary.charCodeAt(i);

    // Gemini outputs 24kHz signed 16-bit LE PCM
    const int16 = new Int16Array(uint8.buffer);
    const float32 = new Float32Array(int16.length);
    for (let i = 0; i < int16.length; i++) float32[i] = int16[i] / 32768.0;

    // Buffer tagged at 24kHz; the playback AudioContext (native rate)
    // handles the resampling cleanly without distortion
    const audioBuffer = ctx.createBuffer(1, float32.length, 24000);
    audioBuffer.getChannelData(0).set(float32);

    // Per-chunk gain node with a 2ms linear ramp up/down.
    // Eliminates click/pop artifacts at chunk boundaries where the PCM
    // waveform doesn't start/end at zero.
    const chunkGain = ctx.createGain();
    chunkGain.connect(masterGain);

    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(chunkGain);

    const now = ctx.currentTime;
    // Keep scheduler at least 50ms ahead of real-time to absorb network jitter.
    // If we've fallen far behind (tab hidden, etc.), snap back to now+50ms.
    if (playbackTimeRef.current < now + 0.05) {
      playbackTimeRef.current = now + 0.05;
    }

    const startAt = playbackTimeRef.current;
    const duration = audioBuffer.duration;
    const fadeMs = 0.002; // 2ms crossfade

    // Fade in: 0 → 1 over first 2ms
    chunkGain.gain.setValueAtTime(0, startAt);
    chunkGain.gain.linearRampToValueAtTime(1, startAt + fadeMs);

    // Fade out: 1 → 0 over last 2ms
    chunkGain.gain.setValueAtTime(1, startAt + duration - fadeMs);
    chunkGain.gain.linearRampToValueAtTime(0, startAt + duration);

    source.start(startAt);
    source.stop(startAt + duration);

    playbackTimeRef.current += duration;
  };

  // Separate "close WebSocket" action (user-initiated) from audio cleanup
  const disconnect = () => {
    if (isClosingRef.current) return;   // guard against re-entry
    isClosingRef.current = true;

    setIsConnecting(false);
    setIsConnected(false);

    const ws = wsRef.current;
    wsRef.current = null;
    if (ws && ws.readyState !== WebSocket.CLOSED && ws.readyState !== WebSocket.CLOSING) {
      // Must pass explicit code 1000; calling close() with no args
      // makes the browser omit the status code → server returns 1005
      ws.close(1000, "User disconnected");
    }

    cleanupAudio();
  };

  // Teardown everything audio-related (called both from disconnect() and ws.onclose)
  const cleanupAudio = () => {
    setIsConnecting(false);
    setIsConnected(false);

    if (processorRef.current) {
      try { processorRef.current.source.disconnect(); } catch (_) {}
      try { processorRef.current.processor.disconnect(); } catch (_) {}
      try { processorRef.current.silentGain?.disconnect(); } catch (_) {}
      processorRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(t => t.stop());
      streamRef.current = null;
    }
    if (masterGainRef.current) {
      try { masterGainRef.current.disconnect(); } catch (_) {}
      masterGainRef.current = null;
    }
    if (recordCtxRef.current) {
      recordCtxRef.current.close().catch(() => {});
      recordCtxRef.current = null;
    }
    if (playCtxRef.current) {
      playCtxRef.current.close().catch(() => {});
      playCtxRef.current = null;
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h1 className="font-clash-display text-4xl font-bold uppercase">Gemini Live Sandbox</h1>
        <p className="mt-2 text-[#666666]">
          Тестовое окружение для Gemini Live. Настройте параметры и начните разговор в реальном времени.
        </p>
      </div>

      <div className="grid gap-6 md:grid-cols-2">
        <Card className="p-6 rounded-[28px]">
          <div className="mb-4 flex items-center gap-2 text-[#838282]">
            <Settings2 size={16} />
            <h2 className="text-[10px] font-bold uppercase tracking-[0.2em]">Config</h2>
          </div>

          <div className="space-y-4">
            <label className="block space-y-2">
              <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#838282]">Model</span>
              <select
                value={model}
                onChange={e => setModel(e.target.value)}
                disabled={isConnected || isConnecting}
                className="w-full border border-[#111111]/10 bg-white px-4 py-3 text-sm outline-none rounded-2xl"
              >
                <option value="models/gemini-2.5-flash-native-audio-latest">gemini-2.5-flash-native-audio</option>
                <option value="models/gemini-2.0-flash-exp">gemini-2.0-flash-exp (legacy)</option>
              </select>
            </label>

            <label className="block space-y-2">
              <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-[#838282]">System Prompt</span>
              <textarea
                value={systemPrompt}
                onChange={e => setSystemPrompt(e.target.value)}
                disabled={isConnected || isConnecting}
                rows={4}
                className="w-full border border-[#111111]/10 bg-white px-4 py-3 text-sm outline-none rounded-2xl resize-none"
              />
            </label>
          </div>
        </Card>

        <Card className="flex flex-col items-center justify-center p-6 rounded-[28px] text-center">
          <div className="mb-8">
            <div className={`mx-auto flex h-24 w-24 items-center justify-center rounded-full transition-all ${isConnected ? "bg-emerald-500/10 text-emerald-500 shadow-[0_0_40px_rgba(16,185,129,0.3)]" : "bg-[#111111]/5 text-[#838282]"}`}>
              {isConnecting ? (
                <Loader2 size={40} className="animate-spin" />
              ) : isConnected ? (
                isMuted ? <MicOff size={40} /> : <Mic size={40} />
              ) : (
                <Square size={40} />
              )}
            </div>
            <p className="mt-4 font-bold uppercase tracking-[0.2em] text-sm text-[#838282]">
              {isConnecting ? "Connecting..." : isConnected ? (isMuted ? "Muted" : "Listening...") : "Ready to connect"}
            </p>
          </div>

          <div className="flex flex-wrap justify-center gap-4">
            {!isConnected && !isConnecting ? (
              <PillButton onClick={connect} className="flex items-center gap-2">
                <Play size={16} /> <span>Connect</span>
              </PillButton>
            ) : (
              <>
                <PillButton
                  onClick={() => setIsMuted(!isMuted)}
                  variant={isMuted ? "solid" : "default"}
                  className="flex items-center gap-2"
                >
                  {isMuted ? <MicOff size={16} /> : <Mic size={16} />}
                  <span>{isMuted ? "Unmute" : "Mute"}</span>
                </PillButton>

                <PillButton
                  onClick={disconnect}
                  className="flex items-center gap-2 !border-red-500 !text-red-500 hover:!bg-red-500 hover:!text-white"
                >
                  <Square size={16} /> <span>Disconnect</span>
                </PillButton>
              </>
            )}
          </div>
        </Card>
      </div>
    </div>
  );
}
