import { useEffect, useMemo, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Cloud,
  Monitor,
  Rocket,
  ShieldCheck,
  SkipForward,
  Zap,
} from "lucide-react";
import { toast } from "sonner";
import { useNavigate } from "react-router";
import { EchoStack, PillButton, Card } from "@/components/ui/core";
import { api } from "@/lib/api";
import { formatDateTime } from "@/lib/formatters";

const STEPS = ["Welcome", "Provider", "API Keys", "Agent Config", "Ready"];
const PROVIDERS = [
  { id: "openai_realtime", name: "OpenAI Realtime", icon: Cloud },
  { id: "local_hybrid", name: "Local Hybrid", icon: Monitor },
  { id: "deepgram", name: "Deepgram", icon: Rocket },
  { id: "google_live", name: "Google Live", icon: Zap },
  { id: "elevenlabs_agent", name: "ElevenLabs Agent", icon: ShieldCheck },
  { id: "local", name: "Local", icon: Monitor },
];

const DEFAULT_CONFIG = {
  provider: "openai_realtime",
  asterisk_host: "127.0.0.1",
  asterisk_username: "asterisk",
  asterisk_password: "",
  asterisk_port: 8088,
  asterisk_scheme: "http",
  asterisk_app: "asterisk-ai-voice-agent",
  asterisk_ssl_verify: true,
  openai_key: "",
  groq_key: "",
  deepgram_key: "",
  google_key: "",
  elevenlabs_key: "",
  elevenlabs_agent_id: "",
  greeting: "Hello, how can I help you today?",
  ai_name: "Asterisk Agent",
  ai_role: "Helpful Assistant",
  hybrid_llm_provider: "groq",
};

export default function SetupWizard() {
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [saving, setSaving] = useState(false);
  const [engineStatus, setEngineStatus] = useState(null);
  const [validation, setValidation] = useState({});

  useEffect(() => {
    api
      .get("/api/wizard/load-config")
      .then((response) => {
        setConfig((prev) => ({ ...prev, ...(response.data || {}) }));
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (step === 4) {
      api
        .get("/api/wizard/engine-status")
        .then((response) => setEngineStatus(response.data))
        .catch(() => setEngineStatus(null));
    }
  }, [step]);

  const requiredKeys = useMemo(() => {
    switch (config.provider) {
      case "openai_realtime":
        return [["openai_key", "OpenAI API Key", "openai"]];
      case "deepgram":
        return [
          ["deepgram_key", "Deepgram API Key", "deepgram"],
          ["openai_key", "OpenAI API Key", "openai"],
        ];
      case "google_live":
        return [["google_key", "Google API Key", "google"]];
      case "elevenlabs_agent":
        return [
          ["elevenlabs_agent_id", "Agent ID", null],
          ["elevenlabs_key", "ElevenLabs API Key", "elevenlabs"],
        ];
      case "local_hybrid":
        return config.hybrid_llm_provider === "openai"
          ? [["openai_key", "OpenAI API Key", "openai"]]
          : [["groq_key", "Groq API Key", "groq"]];
      default:
        return [];
    }
  }, [config.hybrid_llm_provider, config.provider]);

  async function validateProviderKey(provider, apiKey, agentId) {
    try {
      const response = await api.post("/api/wizard/validate-key", {
        provider,
        api_key: apiKey,
        agent_id: agentId,
      });
      setValidation((prev) => ({
        ...prev,
        [provider]: response.data,
      }));
      if (response.data?.valid) {
        toast.success(response.data.message || "API key validated.");
      } else {
        toast.error(response.data?.error || "API key validation failed.");
      }
    } catch (err) {
      toast.error(err?.response?.data?.detail || "API key validation failed.");
    }
  }

  async function validateConnection() {
    try {
      const response = await api.post("/api/wizard/validate-connection", {
        host: config.asterisk_host,
        username: config.asterisk_username,
        password: config.asterisk_password,
        port: config.asterisk_port,
        scheme: config.asterisk_scheme,
        ssl_verify: config.asterisk_ssl_verify,
        app: config.asterisk_app,
      });
      if (response.data?.valid) {
        toast.success(response.data.message || "Asterisk connection validated.");
      } else {
        toast.error(response.data?.error || "Asterisk validation failed.");
      }
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Asterisk validation failed.");
    }
  }

  async function saveWizard() {
    setSaving(true);
    try {
      await api.post("/api/wizard/save", config);
      toast.success("Wizard configuration saved.");
      setStep(4);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to save setup.");
    } finally {
      setSaving(false);
    }
  }

  async function startEngine() {
    try {
      await api.post("/api/wizard/start-engine");
      toast.success("AI Engine start requested.");
      const response = await api.get("/api/wizard/engine-status");
      setEngineStatus(response.data);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to start AI Engine.");
    }
  }

  async function skipSetup() {
    try {
      await api.post("/api/wizard/skip");
      navigate("/");
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to skip setup.");
    }
  }

  function nextStep() {
    if (step === 3) {
      saveWizard();
      return;
    }
    setStep((current) => Math.min(current + 1, STEPS.length - 1));
  }

  return (
    <div className="flex min-h-screen flex-col bg-[#f2f2f2]">
      <header className="flex items-center justify-between p-8">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 items-center justify-center rounded-sm bg-[#111111] text-white">
            <span className="font-clash-display font-bold">A</span>
          </div>
          <h1 className="font-clash-display text-xl font-bold uppercase">
            AVA Setup
          </h1>
        </div>

        <div className="hidden items-center gap-8 md:flex">
          {STEPS.map((label, index) => (
            <div key={label} className="flex items-center gap-3">
              <div
                className={`flex h-7 w-7 items-center justify-center rounded-full border text-[10px] font-bold ${index <= step ? "border-[#111111] bg-[#111111] text-white" : "border-[#bfbfbf] text-[#bfbfbf]"}`}
              >
                {index < step ? <CheckCircle2 size={12} /> : index + 1}
              </div>
              <span className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#838282]">
                {label}
              </span>
            </div>
          ))}
        </div>

        <PillButton onClick={skipSetup}>
          <span className="flex items-center gap-2">
            <SkipForward size={14} />
            Skip Setup
          </span>
        </PillButton>
      </header>

      <main className="flex flex-1 items-center justify-center p-8">
        <div className="w-full max-w-5xl">
          {step === 0 ? (
            <WelcomeStep />
          ) : null}
          {step === 1 ? (
            <ProviderStep value={config.provider} onChange={(provider) => setConfig((prev) => ({ ...prev, provider }))} />
          ) : null}
          {step === 2 ? (
            <KeysStep
              config={config}
              setConfig={setConfig}
              requiredKeys={requiredKeys}
              validation={validation}
              onValidate={validateProviderKey}
            />
          ) : null}
          {step === 3 ? (
            <AgentConfigStep config={config} setConfig={setConfig} onValidateConnection={validateConnection} />
          ) : null}
          {step === 4 ? (
            <DoneStep
              provider={config.provider}
              engineStatus={engineStatus}
              onStartEngine={startEngine}
            />
          ) : null}
        </div>
      </main>

      <footer className="flex items-center justify-between border-t border-[#111111]/10 bg-white/50 px-8 py-6">
        <PillButton onClick={() => setStep((current) => Math.max(0, current - 1))} disabled={step === 0 || saving}>
          <span className="flex items-center gap-2">
            <ArrowLeft size={14} />
            Back
          </span>
        </PillButton>
        <p className="text-[10px] font-bold uppercase tracking-[0.35em] text-[#838282]">
          Step {step + 1} of {STEPS.length}
        </p>
        <PillButton variant="solid" onClick={step === 4 ? () => window.location.href = "/" : nextStep} disabled={saving}>
          <span className="flex items-center gap-2">
            {step === 4 ? "Go to Dashboard" : step === 3 ? (saving ? "Saving..." : "Finish Setup") : "Continue"}
            <ArrowRight size={14} />
          </span>
        </PillButton>
      </footer>
    </div>
  );
}

function WelcomeStep() {
  return (
    <div className="space-y-8 text-center">
      <p className="text-[10px] font-bold uppercase tracking-[0.4em] text-[#838282]">
        Initialization
      </p>
      <EchoStack text="WELCOME TO AVA" className="text-6xl md:text-8xl" />
      <p className="mx-auto max-w-3xl text-lg leading-8 text-[#666666]">
        This wizard saves your provider choice, API keys, and Asterisk connection
        details into the backend config so the rest of the new Admin UI works
        against real data immediately.
      </p>
    </div>
  );
}

function ProviderStep({ value, onChange }) {
  return (
    <div className="space-y-8">
      <div className="text-center">
        <h2 className="font-clash-display text-5xl font-bold uppercase">Select Provider</h2>
        <p className="mt-3 text-sm text-[#666666]">
          Choose the primary voice stack you want the wizard to configure.
        </p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {PROVIDERS.map((provider) => (
          <button
            key={provider.id}
            type="button"
            onClick={() => onChange(provider.id)}
            className={`rounded-[28px] border p-8 text-left transition-all ${value === provider.id ? "border-[#111111] bg-[#111111] text-white" : "border-[#111111]/10 bg-white hover:border-[#111111]/30"}`}
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-white/10">
              <provider.icon size={20} />
            </div>
            <h3 className="mt-8 font-clash-display text-3xl font-bold uppercase">
              {provider.name}
            </h3>
          </button>
        ))}
      </div>
    </div>
  );
}

function KeysStep({ config, setConfig, requiredKeys, validation, onValidate }) {
  return (
    <div className="space-y-8">
      <div className="text-center">
        <h2 className="font-clash-display text-5xl font-bold uppercase">API Keys</h2>
        <p className="mt-3 text-sm text-[#666666]">
          Enter only the keys required by the selected provider.
        </p>
      </div>

      <div className="space-y-4">
        {config.provider === "local_hybrid" ? (
          <label className="block space-y-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#838282]">
              Hybrid LLM Provider
            </span>
            <select
              value={config.hybrid_llm_provider}
              onChange={(event) =>
                setConfig((prev) => ({ ...prev, hybrid_llm_provider: event.target.value }))
              }
              className="w-full border border-[#111111]/10 bg-white px-4 py-3 text-sm outline-none"
            >
              <option value="groq">Groq</option>
              <option value="openai">OpenAI</option>
            </select>
          </label>
        ) : null}

        {requiredKeys.map(([key, label, provider]) => (
          <Card key={key} className="rounded-[28px] p-6">
            <label className="block space-y-2">
              <span className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#838282]">
                {label}
              </span>
              <input
                type="password"
                value={config[key] || ""}
                onChange={(event) =>
                  setConfig((prev) => ({ ...prev, [key]: event.target.value }))
                }
                className="w-full border border-[#111111]/10 bg-white px-4 py-3 text-sm outline-none"
              />
            </label>

            {key === "elevenlabs_agent_id" ? (
              <label className="mt-4 block space-y-2">
                <span className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#838282]">
                  Agent ID
                </span>
                <input
                  value={config.elevenlabs_agent_id || ""}
                  onChange={(event) =>
                    setConfig((prev) => ({
                      ...prev,
                      elevenlabs_agent_id: event.target.value,
                    }))
                  }
                  className="w-full border border-[#111111]/10 bg-white px-4 py-3 text-sm outline-none"
                />
              </label>
            ) : null}

            {provider ? (
              <div className="mt-4 flex items-center justify-between gap-4">
                <PillButton
                  onClick={() =>
                    onValidate(
                      provider,
                      config[key],
                      provider === "elevenlabs" ? config.elevenlabs_agent_id : undefined,
                    )
                  }
                >
                  Validate Key
                </PillButton>
                <span className="text-sm text-[#666666]">
                  {validation[provider]?.message ||
                    validation[provider]?.error ||
                    "Not validated yet"}
                </span>
              </div>
            ) : null}
          </Card>
        ))}
      </div>
    </div>
  );
}

function AgentConfigStep({ config, setConfig, onValidateConnection }) {
  return (
    <div className="space-y-8">
      <div className="text-center">
        <h2 className="font-clash-display text-5xl font-bold uppercase">
          Agent Configuration
        </h2>
        <p className="mt-3 text-sm text-[#666666]">
          Save the Asterisk connection plus your greeting and agent identity.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        {[
          ["asterisk_host", "Asterisk Host"],
          ["asterisk_username", "ARI Username"],
          ["asterisk_password", "ARI Password", "password"],
          ["asterisk_port", "ARI Port", "number"],
          ["asterisk_scheme", "ARI Scheme"],
          ["asterisk_app", "Stasis App Name"],
          ["ai_name", "AI Name"],
          ["ai_role", "AI Role"],
        ].map(([key, label, type]) => (
          <label key={key} className="space-y-2">
            <span className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#838282]">
              {label}
            </span>
            <input
              type={type || "text"}
              value={config[key] || ""}
              onChange={(event) =>
                setConfig((prev) => ({
                  ...prev,
                  [key]: type === "number" ? Number(event.target.value) : event.target.value,
                }))
              }
              className="w-full border border-[#111111]/10 bg-white px-4 py-3 text-sm outline-none"
            />
          </label>
        ))}
      </div>

      <label className="block space-y-2">
        <span className="text-[10px] font-bold uppercase tracking-[0.28em] text-[#838282]">
          Greeting Message
        </span>
        <textarea
          value={config.greeting}
          onChange={(event) =>
            setConfig((prev) => ({ ...prev, greeting: event.target.value }))
          }
          rows={6}
          className="w-full border border-[#111111]/10 bg-white px-4 py-3 text-sm outline-none"
        />
      </label>

      <div className="flex justify-end">
        <PillButton onClick={onValidateConnection}>Test Connection</PillButton>
      </div>
    </div>
  );
}

function DoneStep({ provider, engineStatus, onStartEngine }) {
  return (
    <div className="space-y-8 text-center">
      <div>
        <p className="text-[10px] font-bold uppercase tracking-[0.4em] text-[#838282]">
          Ready
        </p>
        <EchoStack text="SYSTEM READY" className="text-6xl md:text-8xl" />
        <p className="mx-auto mt-6 max-w-3xl text-lg leading-8 text-[#666666]">
          Provider <strong>{provider}</strong> has been saved. You can now start
          the AI Engine and continue in the main Admin UI.
        </p>
      </div>

      <Card className="rounded-[32px] p-8 text-left">
        <pre className="overflow-x-auto rounded-[24px] bg-[#111111]/5 p-4 text-xs text-[#555555]">
          {JSON.stringify(engineStatus || { running: false }, null, 2)}
        </pre>
        <p className="mt-4 text-sm text-[#666666]">
          Last checked: {formatDateTime(new Date().toISOString())}
        </p>
      </Card>

      <div className="flex justify-center gap-3">
        <PillButton onClick={onStartEngine}>Start AI Engine</PillButton>
        <PillButton variant="solid" onClick={() => (window.location.href = "/")}>
          Open Dashboard
        </PillButton>
      </div>
    </div>
  );
}
