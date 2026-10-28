import { useMemo, useState } from "react";
import { AudioLines, CheckCircle2, Plus, Settings, Trash2 } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { JsonObjectModal } from "@/components/config/JsonObjectModal";
import { Card, PillButton } from "@/components/ui/core";
import { EmptyState, LoadingBlock, PageHeader } from "@/components/ui/shell";
import { useConfigDocument } from "@/hooks/useConfigDocument";

export default function ProfilesPage() {
  const { config, isLoading, save } = useConfigDocument();
  const [modalState, setModalState] = useState({ open: false, name: "", value: {}, lockName: false });

  const profiles = useMemo(
    () =>
      Object.entries(config?.profiles || {})
        .filter(([name]) => name !== "default")
        .map(([name, value]) => ({ name, value })),
    [config],
  );

  async function persist(nextConfig, message) {
    await save(nextConfig, message);
  }

  async function saveProfile(name, value) {
    const nextConfig = structuredClone(config || {});
    nextConfig.profiles = nextConfig.profiles || {};
    nextConfig.profiles[name] = value;
    await persist(nextConfig, `Profile ${name} saved.`);
    setModalState({ open: false, name: "", value: {}, lockName: false });
  }

  async function setDefault(name) {
    const nextConfig = structuredClone(config || {});
    nextConfig.profiles.default = name;
    await persist(nextConfig, `Default profile set to ${name}.`);
  }

  async function deleteProfile(name) {
    if (!window.confirm(`Delete profile "${name}"?`)) {
      return;
    }
    const nextConfig = structuredClone(config || {});
    delete nextConfig.profiles?.[name];
    if (nextConfig.profiles?.default === name) {
      nextConfig.profiles.default = Object.keys(nextConfig.profiles).find((key) => key !== "default") || "default";
    }
    await persist(nextConfig, `Profile ${name} deleted.`);
  }

  if (isLoading || !config) {
    return (
      <AppShell>
        <LoadingBlock label="Loading Profiles" />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="space-y-8">
        <PageHeader
          eyebrow="Audio Configuration"
          title="Audio Profiles"
          description="Edit transport and provider audio profile objects directly from the live config while preserving your new shell and navigation."
          actions={
            <PillButton
              variant="solid"
              onClick={() =>
                setModalState({
                  open: true,
                  name: "",
                  value: {
                    chunk_ms: 20,
                    idle_cutoff_ms: 800,
                    internal_rate_hz: 8000,
                    provider_pref: {},
                    transport_out: {},
                  },
                  lockName: false,
                })
              }
            >
              <span className="flex items-center gap-2">
                <Plus size={14} />
                Add Profile
              </span>
            </PillButton>
          }
        />

        {profiles.length ? (
          <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
            {profiles.map((profile) => (
              <Card key={profile.name} className="rounded-[32px] p-8">
                <div className="mb-6 flex items-start justify-between gap-3">
                  <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#111111] text-white">
                    <AudioLines size={20} />
                  </div>
                  {config.profiles?.default === profile.name ? (
                    <span className="rounded-full bg-emerald-100 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-emerald-700">
                      Default
                    </span>
                  ) : null}
                </div>
                <h3 className="font-clash-display text-3xl font-bold uppercase">
                  {profile.name}
                </h3>
                <p className="mt-3 text-sm text-[#666666]">
                  Internal rate {profile.value?.internal_rate_hz || "—"} • chunk {profile.value?.chunk_ms || "—"}
                </p>
                <pre className="mt-6 overflow-x-auto rounded-[24px] bg-[#111111]/5 p-4 text-xs text-[#555555]">
                  {JSON.stringify(profile.value, null, 2)}
                </pre>
                <div className="mt-6 grid grid-cols-3 gap-2">
                  <ActionButton onClick={() => setDefault(profile.name)}>
                    <CheckCircle2 size={14} />
                    Default
                  </ActionButton>
                  <ActionButton
                    onClick={() =>
                      setModalState({
                        open: true,
                        name: profile.name,
                        value: profile.value,
                        lockName: true,
                      })
                    }
                  >
                    <Settings size={14} />
                    Edit
                  </ActionButton>
                  <ActionButton
                    onClick={() => deleteProfile(profile.name)}
                    className="hover:bg-red-500 hover:text-white"
                  >
                    <Trash2 size={14} />
                    Delete
                  </ActionButton>
                </div>
              </Card>
            ))}
          </div>
        ) : (
          <EmptyState
            title="No Audio Profiles"
            description="Add a profile to control chunking, sample rates, and transport output."
            actionLabel="Add Profile"
            onAction={() =>
              setModalState({
                open: true,
                name: "",
                value: {
                  chunk_ms: 20,
                  idle_cutoff_ms: 800,
                  internal_rate_hz: 8000,
                  provider_pref: {},
                  transport_out: {},
                },
                lockName: false,
              })
            }
          />
        )}
      </div>

      <JsonObjectModal
        isOpen={modalState.open}
        onClose={() => setModalState({ open: false, name: "", value: {}, lockName: false })}
        title={modalState.lockName ? "Edit Profile" : "Add Profile"}
        initialName={modalState.name}
        initialValue={modalState.value}
        lockName={modalState.lockName}
        onSave={saveProfile}
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
