import { AppShell } from "@/components/layout/AppShell";
import { SectionJsonPage } from "@/components/config/SectionJsonPage";

export default function BargeInPage() {
  return (
    <AppShell>
      <SectionJsonPage
        eyebrow="Interrupt Handling"
        title="Barge In"
        description="Adjust barge-in thresholds, protection windows, provider fallback, and related call interruption settings."
        sections={[
          {
            key: "barge_in",
            label: "barge_in",
            description: "Barge-in configuration from config YAML.",
            rows: 22,
          },
        ]}
      />
    </AppShell>
  );
}
