import { useEffect, useState } from "react";
import { Download, Save, Upload } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/layout/AppShell";
import { Card, PillButton } from "@/components/ui/core";
import { Banner, LoadingBlock, PageHeader } from "@/components/ui/shell";
import { api, downloadBlob } from "@/lib/api";
import { downloadBrowserFile } from "@/lib/formatters";

export default function RawYamlPage() {
  const [content, setContent] = useState("");
  const [yamlError, setYamlError] = useState(null);
  const [loading, setLoading] = useState(true);

  async function loadYaml() {
    setLoading(true);
    try {
      const response = await api.get("/api/config/yaml");
      setContent(response.data?.content || "");
      setYamlError(response.data?.yaml_error || null);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to load YAML.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadYaml();
  }, []);

  async function saveYaml() {
    try {
      await api.post("/api/config/yaml", { content });
      toast.success("YAML saved.");
      loadYaml();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to save YAML.");
    }
  }

  async function exportConfig() {
    try {
      const response = await downloadBlob("/api/config/export");
      const disposition = response.headers["content-disposition"] || "";
      const filename =
        disposition.match(/filename=([^;]+)/)?.[1]?.replace(/"/g, "") ||
        "ava-config-export.zip";
      downloadBrowserFile(response.data, filename);
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to export config.");
    }
  }

  async function importConfig(event) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }
    if (!window.confirm("Importing will replace current config files. Continue?")) {
      return;
    }
    try {
      const formData = new FormData();
      formData.append("file", file);
      await api.post("/api/config/import", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      toast.success("Config import completed.");
      loadYaml();
    } catch (err) {
      toast.error(err?.response?.data?.detail || "Failed to import config.");
    } finally {
      event.target.value = "";
    }
  }

  if (loading) {
    return (
      <AppShell>
        <LoadingBlock label="Loading Raw YAML" />
      </AppShell>
    );
  }

  return (
    <AppShell>
      <div className="space-y-8">
        <PageHeader
          eyebrow="Direct Configuration Editing"
          title="Raw YAML"
          description="Edit the merged YAML config directly, export a backup zip, or import a previously exported bundle."
          actions={
            <>
              <label className="cursor-pointer">
                <input type="file" accept=".zip" className="hidden" onChange={importConfig} />
                <PillButton>
                  <span className="flex items-center gap-2">
                    <Upload size={14} />
                    Import
                  </span>
                </PillButton>
              </label>
              <PillButton onClick={exportConfig}>
                <span className="flex items-center gap-2">
                  <Download size={14} />
                  Export
                </span>
              </PillButton>
              <PillButton variant="solid" onClick={saveYaml}>
                <span className="flex items-center gap-2">
                  <Save size={14} />
                  Save Changes
                </span>
              </PillButton>
            </>
          }
        />

        {yamlError ? (
          <Banner tone="warning">
            Invalid YAML at line {yamlError.line || "?"}, column {yamlError.column || "?"}:{" "}
            {yamlError.message || "Unknown YAML error"}
          </Banner>
        ) : null}

        <Card className="rounded-[32px] p-8">
          <textarea
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={36}
            className="min-h-[70vh] w-full border border-[#111111]/10 bg-white px-4 py-3 font-mono text-xs outline-none transition-all focus:border-[#111111]"
          />
        </Card>
      </div>
    </AppShell>
  );
}
