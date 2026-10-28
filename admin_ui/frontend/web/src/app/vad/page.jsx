import { AppShell } from "@/components/layout/AppShell";
import { SectionJsonPage } from "@/components/config/SectionJsonPage";

export default function VADPage() {
  return (
    <AppShell>
      <SectionJsonPage
        eyebrow="Engine-Side Detection"
        title="Voice Activity Detection"
        description="Tune engine-side VAD, WebRTC fallback, utterance timing, and upstream squelch settings in the same config objects the backend consumes."
        sections={[
          {
            key: "vad",
            label: "vad",
            description: "Voice activity detection section from config YAML.",
            rows: 22,
          },
        ]}
      />
    </AppShell>
  );
}
