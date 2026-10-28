import { AppShell } from "@/components/layout/AppShell";
import { SectionJsonPage } from "@/components/config/SectionJsonPage";

export default function StreamingPage() {
  return (
    <AppShell>
      <SectionJsonPage
        eyebrow="Real-Time Audio Delivery"
        title="Streaming"
        description="Edit stream buffering, keepalive, jitter, audio diagnostics, and normalizer settings from the active backend configuration."
        sections={[
          {
            key: "streaming",
            label: "streaming",
            description: "Audio streaming and playback configuration.",
            rows: 24,
          },
        ]}
      />
    </AppShell>
  );
}
