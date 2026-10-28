import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Plus, Power, Server, Settings, Trash2, Zap } from "lucide-react";
import { toast } from "sonner";
import { Card, PillButton } from "@/components/ui/core";
import { JsonObjectModal } from "@/components/config/JsonObjectModal";
import { Banner, EmptyState, LoadingBlock, PageHeader } from "@/components/ui/shell";
import { useConfigDocument } from "@/hooks/useConfigDocument";
import { api } from "@/lib/api";

const OPENAI_REALTIME_MODELS = [
  { id: "gpt-realtime-2", label: "GPT Realtime 2" },
  { id: "gpt-realtime-1.5", label: "GPT Realtime 1.5" },
  { id: "gpt-realtime", label: "GPT Realtime" },
];

const OPENAI_REALTIME_VOICES = [
  { id: "alloy", label: "Alloy" },
  { id: "ash", label: "Ash" },
  { id: "ballad", label: "Ballad" },
  { id: "coral", label: "Coral" },
  { id: "echo", label: "Echo" },
  { id: "sage", label: "Sage" },
  { id: "shimmer", label: "Shimmer" },
  { id: "verse", label: "Verse" },
  { id: "marin", label: "Marin", recommended: true },
  { id: "cedar", label: "Cedar", recommended: true },
];

const OPENAI_REALTIME_REASONING = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
];

const OPENAI_REALTIME_DEFAULTS = {
  api_version: "ga",
  model: "gpt-realtime-2",
  voice: "alloy",
  speed: 1,
  reasoning_effort: "low",
  max_output_tokens: 4096,
  parallel_tool_calls: false,
  proxy_url: "${AI_PROVIDER_PROXY_URL:-}",
};

const controlClass =
  "w-full rounded-2xl border border-[#111111]/10 bg-white px-3 py-2 text-sm text-[#111111] outline-none transition focus:border-[#111111]/50";

function clampNumber(value, fallback, { min, max, integer = false } = {}) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  const normalized = integer ? Math.round(parsed) : parsed;
  return Math.min(max, Math.max(min, normalized));
}

function getMaxOutputTokens(provider) {
  return provider?.max_output_tokens ?? provider?.max_response_output_tokens ?? OPENAI_REALTIME_DEFAULTS.max_output_tokens;
}

export default function ProvidersPage() {
  const { config, setConfig, save, isLoading, refetch } = useConfigDocument();
  const [modalState, setModalState] = useState({ open: false, name: "", value: {}, lockName: false });

  const providers = useMemo(() => {
    const items = Object.entries(config?.providers || {}).map(([name, value]) => ({
      name,
      value,
    }));
    return items.sort((left, right) => left.name.localeCompare(right.name));
  }, [config]);

  const defaultProvider = config?.default_provider || "";

  function openCreateModal() {
    setModalState({
      open: true,
      name: "",
      value: { enabled: true, type: "openai", capabilities: ["llm"] },
      lockName: false,
    });
  }

  function openEditModal(provider) {
    setModalState({
      open: true,
      name: provider.name,
      value: provider.value,
      lockName: true,
    });
  }

  async function persist(nextConfig, message) {
    const success = await save(nextConfig, message);
    if (success) {
      await refetch();
    }
  }

  async function saveProvider(name, value) {
    if (!name) {
      toast.error("Provider name is required.");
      return;
    }
    const nextConfig = structuredClone(config || {});
    nextConfig.providers = nextConfig.providers || {};
    nextConfig.providers[name] = value;
    if (!nextConfig.default_provider) {
      nextConfig.default_provider = name;
    }
    await persist(nextConfig, `Provider ${name} saved.`);
    setModalState({ open: false, name: "", value: {}, lockName: false });
  }

  async function updateProviderField(name, field, value) {
    const nextConfig = structuredClone(config || {});
    nextConfig.providers = nextConfig.providers || {};
    nextConfig.providers[name] = {
      ...(nextConfig.providers[name] || {}),
      [field]: value,
    };
    await persist(nextConfig, `Provider ${name} updated.`);
  }

  async function deleteProvider(name) {
    if (name === defaultProvider) {
      toast.error("Default provider cannot be deleted.");
      return;
    }
    if (!window.confirm(`Delete provider "${name}"?`)) {
      return;
    }
    const nextConfig = structuredClone(config || {});
    delete nextConfig.providers?.[name];
    await persist(nextConfig, `Provider ${name} deleted.`);
  }

  async function setDefault(name) {
    const nextConfig = structuredClone(config || {});
    nextConfig.default_provider = name;
    await persist(nextConfig, `Default provider set to ${name}.`);
  }

  async function toggleEnabled(name) {
    const nextConfig = structuredClone(config || {});
    nextConfig.providers[name] = {
      ...nextConfig.providers[name],
      enabled: !nextConfig.providers[name]?.enabled,
    };
    await persist(nextConfig, `Provider ${name} updated.`);
  }

  async function testProvider(name, providerConfig) {
    try {
      const response = await api.post("/api/config/providers/test", {
        name,
        config: providerConfig,
      });
      toast.success(response.data?.message || `Provider ${name} test completed.`);
    } catch (err) {
      toast.error(err?.response?.data?.detail || `Provider ${name} test failed.`);
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
    return <LoadingBlock label="Loading Providers" />;
  }

  return (
    <div className="space-y-8">
      <PageHeader
        eyebrow="AI Backbone & Connectivity"
        title="Providers"
        description="Manage full-agent and modular providers backed by the real YAML config. Add, edit, test, enable, disable, and switch the default provider from the new interface."
        actions={
          <>
            <PillButton onClick={restartEngine}>Restart AI Engine</PillButton>
            <PillButton variant="solid" onClick={openCreateModal}>
              <span className="flex items-center gap-2">
                <Plus size={14} />
                Add Provider
              </span>
            </PillButton>
          </>
        }
      />

      <Banner tone="warning" action={<PillButton onClick={restartEngine}>Restart</PillButton>}>
        Changes to providers require a full AI Engine restart to take effect, especially when you add, remove, or rewire capabilities used by active pipelines.
      </Banner>

      {providers.length ? (
        <section className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
          {providers.map((provider) => (
            <Card key={provider.name} className="flex h-full flex-col justify-between rounded-[32px] p-8">
              <div>
                <div className="mb-8 flex items-start justify-between gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#111111] text-white">
                    <Server size={20} />
                  </div>
                  <div className="flex items-center gap-2">
                    {provider.name === defaultProvider ? (
                      <span className="rounded-full bg-emerald-100 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-emerald-700">
                        Default
                      </span>
                    ) : null}
                    {!provider.value?.enabled ? (
                      <span className="rounded-full bg-[#111111]/5 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-[#666666]">
                        Disabled
                      </span>
                    ) : null}
                  </div>
                </div>

                <h3 className="font-clash-display text-3xl font-bold uppercase">
                  {provider.name}
                </h3>
                <p className="mt-3 text-sm text-[#666666]">
                  Type: {provider.value?.type || "unknown"} • Capabilities:{" "}
                  {(provider.value?.capabilities || []).join(", ") || "none"}
                </p>
                {provider.name === "openai_realtime" ? (
                  <OpenAIRealtimeSettings
                    provider={provider.value}
                    onChange={(field, value) => updateProviderField(provider.name, field, value)}
                  />
                ) : null}
                <pre className="mt-6 overflow-x-auto rounded-[24px] bg-[#111111]/5 p-4 text-xs text-[#555555]">
                  {JSON.stringify(provider.value, null, 2)}
                </pre>
              </div>

              <div className="mt-8 grid grid-cols-2 gap-2">
                <ActionButton onClick={() => setDefault(provider.name)}>
                  <CheckCircle2 size={14} />
                  Default
                </ActionButton>
                <ActionButton onClick={() => testProvider(provider.name, provider.value)}>
                  <Zap size={14} />
                  Test
                </ActionButton>
                <ActionButton onClick={() => toggleEnabled(provider.name)}>
                  <Power size={14} />
                  {provider.value?.enabled ? "Disable" : "Enable"}
                </ActionButton>
                <ActionButton onClick={() => openEditModal(provider)}>
                  <Settings size={14} />
                  Edit
                </ActionButton>
                <ActionButton
                  className="col-span-2 hover:bg-red-500 hover:text-white"
                  onClick={() => deleteProvider(provider.name)}
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
          title="No Providers Configured"
          description="Add a provider to begin wiring speech, LLM, or full-agent execution into the backend."
          actionLabel="Add Provider"
          onAction={openCreateModal}
        />
      )}

      <JsonObjectModal
        isOpen={modalState.open}
        onClose={() => setModalState({ open: false, name: "", value: {}, lockName: false })}
        title={modalState.lockName ? "Edit Provider" : "Add Provider"}
        initialName={modalState.name}
        initialValue={modalState.value}
        lockName={modalState.lockName}
        subtitle="The modal stores the provider object directly into config.providers so nothing is lost between edits."
        onSave={saveProvider}
      />
    </div>
  );
}

function OpenAIRealtimeSettings({ provider, onChange }) {
  const [draft, setDraft] = useState(() => ({
    speed: String(provider?.speed ?? OPENAI_REALTIME_DEFAULTS.speed),
    max_output_tokens: String(getMaxOutputTokens(provider)),
    proxy_url: provider?.proxy_url ?? OPENAI_REALTIME_DEFAULTS.proxy_url,
  }));

  useEffect(() => {
    setDraft({
      speed: String(provider?.speed ?? OPENAI_REALTIME_DEFAULTS.speed),
      max_output_tokens: String(getMaxOutputTokens(provider)),
      proxy_url: provider?.proxy_url ?? OPENAI_REALTIME_DEFAULTS.proxy_url,
    });
  }, [provider?.speed, provider?.max_output_tokens, provider?.max_response_output_tokens, provider?.proxy_url]);

  const apiVersion = provider?.api_version || OPENAI_REALTIME_DEFAULTS.api_version;
  const model = provider?.model || OPENAI_REALTIME_DEFAULTS.model;
  const voice = provider?.voice || OPENAI_REALTIME_DEFAULTS.voice;
  const speed = clampNumber(draft.speed, OPENAI_REALTIME_DEFAULTS.speed, {
    min: 0.25,
    max: 1.5,
  });
  const reasoning = provider?.reasoning_effort || OPENAI_REALTIME_DEFAULTS.reasoning_effort;
  const parallelToolCalls = Boolean(provider?.parallel_tool_calls ?? OPENAI_REALTIME_DEFAULTS.parallel_tool_calls);

  function commitSpeed(value) {
    const nextValue = clampNumber(value, OPENAI_REALTIME_DEFAULTS.speed, { min: 0.25, max: 1.5 });
    setDraft((current) => ({ ...current, speed: String(nextValue) }));
    onChange("speed", nextValue);
  }

  function commitMaxOutputTokens(value) {
    const nextValue = clampNumber(value, OPENAI_REALTIME_DEFAULTS.max_output_tokens, {
      min: 1,
      max: 4096,
      integer: true,
    });
    setDraft((current) => ({ ...current, max_output_tokens: String(nextValue) }));
    onChange("max_output_tokens", nextValue);
  }

  function commitProxyUrl(value) {
    const nextValue = value.trim();
    setDraft((current) => ({ ...current, proxy_url: nextValue }));
    onChange("proxy_url", nextValue);
  }

  return (
    <div className="mt-6 rounded-[24px] border border-[#111111]/10 bg-white/70 p-4">
      <div className="flex items-center justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#777777]">
            OpenAI Realtime
          </p>
          <p className="mt-1 text-sm font-semibold text-[#111111]">Voice session settings</p>
        </div>
        <span className="rounded-full bg-[#111111] px-3 py-1 text-[10px] font-bold uppercase tracking-[0.16em] text-white">
          GPT
        </span>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-2">
        <Field label="API Version">
          <select className={controlClass} value={apiVersion} onChange={(event) => onChange("api_version", event.target.value)}>
            <option value="ga">GA</option>
            <option value="beta">Beta</option>
          </select>
        </Field>

        <Field label="Model">
          <select className={controlClass} value={model} onChange={(event) => onChange("model", event.target.value)}>
            {OPENAI_REALTIME_MODELS.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Voice">
          <select className={controlClass} value={voice} onChange={(event) => onChange("voice", event.target.value)}>
            {OPENAI_REALTIME_VOICES.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}{item.recommended ? " (recommended)" : ""}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Reasoning">
          <select
            className={controlClass}
            value={reasoning}
            onChange={(event) => onChange("reasoning_effort", event.target.value)}
          >
            {OPENAI_REALTIME_REASONING.map((item) => (
              <option key={item.id} value={item.id}>
                {item.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label={`Speed ${speed.toFixed(2)}x`}>
          <input
            className="w-full accent-[#111111]"
            type="range"
            min="0.25"
            max="1.5"
            step="0.05"
            value={speed}
            onChange={(event) => {
              setDraft((current) => ({ ...current, speed: event.target.value }));
            }}
            onMouseUp={(event) => commitSpeed(event.currentTarget.value)}
            onTouchEnd={(event) => commitSpeed(event.currentTarget.value)}
          />
          <input
            className={`${controlClass} mt-2`}
            type="number"
            min="0.25"
            max="1.5"
            step="0.05"
            value={draft.speed}
            onChange={(event) => setDraft((current) => ({ ...current, speed: event.target.value }))}
            onBlur={(event) => commitSpeed(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
          />
        </Field>

        <Field label="Max Output Tokens">
          <input
            className={controlClass}
            type="number"
            min="1"
            max="4096"
            step="1"
            value={draft.max_output_tokens}
            onChange={(event) => setDraft((current) => ({ ...current, max_output_tokens: event.target.value }))}
            onBlur={(event) => commitMaxOutputTokens(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
          />
        </Field>

        <label className="flex items-center gap-3 rounded-2xl border border-[#111111]/10 bg-white px-3 py-3 text-xs font-bold uppercase tracking-[0.16em] text-[#555555]">
          <input
            className="h-4 w-4 accent-[#111111]"
            type="checkbox"
            checked={parallelToolCalls}
            onChange={(event) => onChange("parallel_tool_calls", event.target.checked)}
          />
          Parallel Tools
        </label>

        <Field label="Proxy / VPN URL" className="lg:col-span-2">
          <input
            className={controlClass}
            type="text"
            value={draft.proxy_url}
            placeholder="${AI_PROVIDER_PROXY_URL:-}"
            onChange={(event) => setDraft((current) => ({ ...current, proxy_url: event.target.value }))}
            onBlur={(event) => commitProxyUrl(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
          />
        </Field>
      </div>
    </div>
  );
}

function Field({ label, children, className = "" }) {
  return (
    <label className={`space-y-2 text-xs font-bold uppercase tracking-[0.16em] text-[#555555] ${className}`}>
      <span>{label}</span>
      {children}
    </label>
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
