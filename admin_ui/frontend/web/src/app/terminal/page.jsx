import { useEffect, useRef, useState } from "react";
import { Send, Terminal as TerminalIcon } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { PageHeader } from "@/components/ui/shell";
import { api } from "@/lib/api";

export default function TerminalPage() {
  const [history, setHistory] = useState([
    "AVA Web Terminal",
    'Type "help" to see available commands.',
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const endRef = useRef(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [history]);

  async function executeCommand(commandLine) {
    const [command, ...rest] = commandLine.trim().split(/\s+/);
    const args = rest;

    switch ((command || "").toLowerCase()) {
      case "help":
        return [
          "Available commands:",
          "  status",
          "  restart <service>",
          "  logs <container> <lines>",
          "  version",
          "  clear",
        ];
      case "status":
        return [JSON.stringify((await api.get("/api/system/health")).data, null, 2)];
      case "restart":
        if (!args[0]) return ['Usage: restart <service>'];
        if (args[0] === "all") {
          await api.post("/api/system/containers/restart-all");
        } else {
          await api.post(`/api/system/containers/${args[0]}/restart`);
        }
        return [`Restart requested for ${args[0]}.`];
      case "logs": {
        const container = args[0] || "ai_engine";
        const tail = args[1] || "20";
        const response = await api.get(`/api/logs/${container}?tail=${tail}`);
        return [`--- ${container} ---`, response.data?.logs || "No logs."];
      }
      case "version":
        return ["Asterisk AI Voice Agent Admin UI"];
      case "clear":
        setHistory([]);
        return [];
      default:
        return [`Command not found: ${command || ""}`];
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();
    if (!input.trim() || loading) {
      return;
    }
    const commandLine = input.trim();
    setHistory((prev) => [...prev, `$ ${commandLine}`]);
    setInput("");
    setLoading(true);
    try {
      const output = await executeCommand(commandLine);
      if (output.length) {
        setHistory((prev) => [...prev, ...output]);
      }
    } catch (err) {
      setHistory((prev) => [
        ...prev,
        err?.response?.data?.detail || err?.message || "Command failed.",
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AppShell>
      <div className="space-y-8">
        <PageHeader
          eyebrow="API Command Wrapper"
          title="Terminal"
          description="A safe terminal-like wrapper over predefined Admin UI commands. This is not a full shell; it routes commands to backend APIs."
        />

        <div className="flex min-h-[70vh] flex-col overflow-hidden rounded-[32px] border border-[#111111] bg-[#09090b]">
          <div className="flex-1 space-y-1 overflow-auto p-5 font-mono text-sm text-gray-200">
            {history.map((line, index) => (
              <div
                key={`${line}-${index}`}
                className={line.startsWith("$") ? "font-bold text-blue-400" : ""}
              >
                {line}
              </div>
            ))}
            {loading ? <div className="text-yellow-400">Processing...</div> : null}
            <div ref={endRef} />
          </div>
          <form
            onSubmit={handleSubmit}
            className="flex items-center gap-3 border-t border-white/10 px-4 py-3"
          >
            <TerminalIcon size={16} className="text-gray-400" />
            <input
              value={input}
              onChange={(event) => setInput(event.target.value)}
              className="flex-1 bg-transparent text-sm text-white outline-none placeholder:text-gray-500"
              placeholder='Enter command: help, status, logs ai_engine 20...'
            />
            <button
              type="submit"
              disabled={loading}
              className="rounded-full border border-white/10 p-2 text-gray-300 transition-colors hover:bg-white/10"
            >
              <Send size={14} />
            </button>
          </form>
        </div>
      </div>
    </AppShell>
  );
}
