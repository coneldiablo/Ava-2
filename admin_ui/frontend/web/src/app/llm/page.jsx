import { AppShell } from "@/components/layout/AppShell";
import { SectionJsonPage } from "@/components/config/SectionJsonPage";

export default function LLMPage() {
  return (
    <AppShell>
      <SectionJsonPage
        eyebrow="Global LLM Defaults"
        title="LLM Defaults"
        description="Edit the default greeting and global LLM prompt settings used across the system."
        sections={[
          {
            key: "llm",
            label: "llm",
            description: "Top-level LLM defaults from config YAML.",
            rows: 18,
          },
        ]}
      />
    </AppShell>
  );
}
