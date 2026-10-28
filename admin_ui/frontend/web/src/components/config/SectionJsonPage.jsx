import { useMemo, useState } from "react";
import { RefreshCw, Save } from "lucide-react";
import { toast } from "sonner";
import { Card, PillButton } from "@/components/ui/core";
import { Banner, LoadingBlock, PageHeader } from "@/components/ui/shell";
import { useConfigDocument } from "@/hooks/useConfigDocument";
import { api } from "@/lib/api";

export function SectionJsonPage({
  eyebrow,
  title,
  description,
  sections,
  restartMessage = "Changes on this page require an AI Engine restart.",
}) {
  const { config, isLoading, save } = useConfigDocument();
  const [drafts, setDrafts] = useState({});

  const sectionValues = useMemo(() => {
    if (!config) {
      return {};
    }
    const next = {};
    sections.forEach((section) => {
      next[section.key] = section.get
        ? section.get(config)
        : config[section.key];
    });
    return next;
  }, [config, sections]);

  function currentText(section) {
    if (drafts[section.key] !== undefined) {
      return drafts[section.key];
    }
    return JSON.stringify(sectionValues[section.key] ?? {}, null, 2);
  }

  async function handleSave() {
    try {
      const nextConfig = structuredClone(config || {});
      sections.forEach((section) => {
        const text = currentText(section);
        const parsed = JSON.parse(text || "{}");
        if (section.set) {
          section.set(nextConfig, parsed);
        } else {
          nextConfig[section.key] = parsed;
        }
      });
      await save(nextConfig, `${title} configuration saved.`);
    } catch (err) {
      toast.error(err?.message || "Invalid JSON in one of the sections.");
    }
  }

  async function restartEngine() {
    try {
      await api.post("/api/system/containers/ai_engine/restart?force=false");
      toast.success("AI Engine restart requested.");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to restart AI Engine.");
    }
  }

  if (isLoading || !config) {
    return <LoadingBlock label={`Loading ${title}`} />;
  }

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow={eyebrow}
        title={title}
        description={description}
        actions={
          <>
            <PillButton onClick={restartEngine}>
              <span className="flex items-center gap-2">
                <RefreshCw size={14} />
                Reload AI Engine
              </span>
            </PillButton>
            <PillButton variant="solid" onClick={handleSave}>
              <span className="flex items-center gap-2">
                <Save size={14} />
                Save Changes
              </span>
            </PillButton>
          </>
        }
      />

      <Banner tone="warning" action={<PillButton onClick={restartEngine}>Restart</PillButton>}>
        {restartMessage}
      </Banner>

      <div className="space-y-6">
        {sections.map((section) => (
          <Card key={section.key} className="rounded-[32px] p-8">
            <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
              {section.label}
            </p>
            {section.description ? (
              <p className="mt-3 text-sm text-[#666666]">{section.description}</p>
            ) : null}
            <textarea
              value={currentText(section)}
              onChange={(event) =>
                setDrafts((prev) => ({ ...prev, [section.key]: event.target.value }))
              }
              rows={section.rows || 16}
              className="mt-6 min-h-[260px] w-full border border-[#111111]/10 bg-white px-4 py-3 font-mono text-xs outline-none transition-all focus:border-[#111111]"
            />
          </Card>
        ))}
      </div>
    </div>
  );
}
