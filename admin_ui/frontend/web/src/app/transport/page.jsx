import { AppShell } from "@/components/layout/AppShell";
import { SectionJsonPage } from "@/components/config/SectionJsonPage";

export default function TransportPage() {
  return (
    <AppShell>
      <SectionJsonPage
        eyebrow="Audio Transport Mode"
        title="Audio Transport"
        description="Control the transport mode and its related AudioSocket / ExternalMedia sections without leaving the new interface."
        sections={[
          {
            key: "transport-mode",
            label: "audio_transport",
            description: "Selected transport mode.",
            get: (config) => ({ audio_transport: config.audio_transport }),
            set: (config, value) => {
              config.audio_transport = value.audio_transport;
            },
            rows: 8,
          },
          {
            key: "audiosocket",
            label: "audiosocket",
            description: "AudioSocket transport options.",
            rows: 14,
          },
          {
            key: "external_media",
            label: "external_media",
            description: "ExternalMedia RTP transport options.",
            rows: 18,
          },
          {
            key: "asterisk-transport",
            label: "asterisk",
            description: "Asterisk transport-related section.",
            get: (config) => config.asterisk || {},
            set: (config, value) => {
              config.asterisk = value;
            },
            rows: 12,
          },
        ]}
      />
    </AppShell>
  );
}
