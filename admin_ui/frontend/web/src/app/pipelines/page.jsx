import { useMemo, useState } from "react";
import { GitBranch, Play, Plus, Settings, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/layout/AppShell";
import { JsonObjectModal } from "@/components/config/JsonObjectModal";
import { Card, PillButton } from "@/components/ui/core";
import { Banner, EmptyState, LoadingBlock, PageHeader } from "@/components/ui/shell";
import { useConfigDocument } from "@/hooks/useConfigDocument";
import { api } from "@/lib/api";

export default function PipelinesPage() {
  const { config, isLoading, save } = useConfigDocument();
  const [modalState, setModalState] = useState({ open: false, name: "", value: {}, lockName: false });

  const pipelines = useMemo(
    () => Object.entries(config?.pipelines || {}).map(([name, value]) => ({ name, value })),
    [config],
  );

  async function persist(nextConfig, message) {
    await save(nextConfig, message);
  }

  async function restartEngine() {
    try {
      await api.post("/api/system/containers/ai_engine/restart?force=false");
      toast.success("AI Engine restart requested.");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to restart AI Engine.");
    }
  }

  async function setActive(name) {
    const nextConfig = structuredClone(config || {});
    nextConfig.active_pipeline = name;
    await persist(nextConfig, `Active pipeline set to ${name}.`);
  }

  async function savePipeline(name, value) {
    const nextConfig = structuredClone(config || {});
    nextConfig.pipelines = nextConfig.pipelines || {};
    nextConfig.pipelines[name] = value;
    await persist(nextConfig, `Pipeline ${name} saved.`);
    setModalState({ open: false, name: "", value: {}, lockName: false });
  }

  async function deletePipeline(name) {
    if (!window.confirm(`Delete pipeline "${name}"?`)) {
      return;
    }
    const nextConfig = structuredClone(config || {});
    delete nextConfig.pipelines?.[name];
    if (nextConfig.active_pipeline === name) {
      nextConfig.active_pipeline = null;
    }
    await persist(nextConfig, `Pipeline ${name} deleted.`);
  }

  if (isLoading || !config) {
    return (
      <AppShell>
        <LoadingBlock label="Loading Pipelines" />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="space-y-8">
        <PageHeader
          eyebrow="Modular AI Workflows"
          title="Pipelines"
          description="Compose modular STT, LLM, and TTS chains from the live YAML configuration and switch the active pipeline used by the backend."
          actions={
            <>
              <PillButton onClick={restartEngine}>Reload AI Engine</PillButton>
              <PillButton
                variant="solid"
                onClick={() =>
                  setModalState({
                    open: true,
                    name: "",
                    value: { stt: "", llm: "", tts: "", options: {} },
                    lockName: false,
                  })
                }
              >
                <span className="flex items-center gap-2">
                  <Plus size={14} />
                  Add Pipeline
                </span>
              </PillButton>
            </>
          }
        />

        <Banner tone="warning" action={<PillButton onClick={restartEngine}>Restart</PillButton>}>
          Pipelines are read directly from `config.pipelines`; after changing the chain or options, reload the AI Engine so new calls use the updated routing.
        </Banner>

        {pipelines.length ? (
          <section className="grid gap-6 lg:grid-cols-2">
            {pipelines.map((pipeline) => (
              <Card key={pipeline.name} className="rounded-[32px] p-8">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-[10px] font-bold uppercase tracking-[0.3em] text-[#838282]">
                      Pipeline
                    </p>
                    <h3 className="mt-3 font-clash-display text-3xl font-bold uppercase">
                      {pipeline.name}
                    </h3>
                  </div>
                  {config.active_pipeline === pipeline.name ? (
                    <span className="rounded-full bg-emerald-100 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-emerald-700">
                      Active
                    </span>
                  ) : null}
                </div>

                <div className="mt-8 space-y-4">
                  {[
                    ["STT", pipeline.value?.stt],
                    ["LLM", pipeline.value?.llm],
                    ["TTS", pipeline.value?.tts],
                  ].map(([label, value]) => (
                    <div
                      key={label}
                      className="flex items-center justify-between rounded-[24px] border border-[#111111]/10 px-5 py-4"
                    >
                      <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#111111] text-white">
                          <GitBranch size={16} />
                        </div>
                        <div>
                          <p className="text-[10px] font-bold uppercase tracking-[0.25em] text-[#838282]">
                            {label}
                          </p>
                          <p className="text-sm font-bold">{value || "Not set"}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>

                <pre className="mt-6 overflow-x-auto rounded-[24px] bg-[#111111]/5 p-4 text-xs text-[#555555]">
                  {JSON.stringify(pipeline.value?.options || {}, null, 2)}
                </pre>

                <div className="mt-6 grid grid-cols-3 gap-2">
                  <ActionButton onClick={() => setActive(pipeline.name)}>
                    <Play size={14} />
                    Set Active
                  </ActionButton>
                  <ActionButton
                    onClick={() =>
                      setModalState({
                        open: true,
                        name: pipeline.name,
                        value: pipeline.value,
                        lockName: true,
                      })
                    }
                  >
                    <Settings size={14} />
                    Edit
                  </ActionButton>
                  <ActionButton
                    onClick={() => deletePipeline(pipeline.name)}
                    className="hover:bg-red-500 hover:text-white"
                  >
                    <Trash2 size={14} />
                    Delete
                  </ActionButton>
                </div>
              </Card>
            ))}
          </section>
        ) : (
          <EmptyState
            title="No Pipelines Configured"
            description="Create a pipeline to combine STT, LLM, and TTS providers from the backend config."
            actionLabel="Add Pipeline"
            onAction={() =>
              setModalState({
                open: true,
                name: "",
                value: { stt: "", llm: "", tts: "", options: {} },
                lockName: false,
              })
            }
          />
        )}
      </div>

      <JsonObjectModal
        isOpen={modalState.open}
        onClose={() => setModalState({ open: false, name: "", value: {}, lockName: false })}
        title={modalState.lockName ? "Edit Pipeline" : "Add Pipeline"}
        initialName={modalState.name}
        initialValue={modalState.value}
        lockName={modalState.lockName}
        onSave={savePipeline}
      />
    </AppShell>
  );
}

function ActionButton({ children, onClick, className = "" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex items-center justify-center gap-2 rounded-full border border-[#111111]/10 px-4 py-3 text-[10px] font-bold uppercase tracking-[0.18em] transition-all hover:bg-[#111111] hover:text-white ${className}`}
    >
      {children}
    </button>
  );
}
