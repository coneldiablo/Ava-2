import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

vi.mock("@/components/config/JsonObjectModal", () => ({
  JsonObjectModal: () => null,
}));

vi.mock("@/components/ui/core", () => ({
  Card: ({ children }) => <section>{children}</section>,
  PillButton: ({ children, onClick, variant }) => (
    <button data-variant={variant || "outline"} onClick={onClick}>
      {children}
    </button>
  ),
}));

vi.mock("@/components/ui/shell", () => ({
  Banner: ({ children }) => <aside>{children}</aside>,
  EmptyState: ({ title }) => <div>{title}</div>,
  LoadingBlock: ({ label }) => <div>{label}</div>,
  PageHeader: ({ title, actions }) => (
    <header>
      <h1>{title}</h1>
      {actions}
    </header>
  ),
}));

vi.mock("@/hooks/useConfigDocument", () => ({
  useConfigDocument: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    post: vi.fn(),
  },
}));

import ProvidersPage from "./ProvidersPage.jsx";
import { useConfigDocument } from "@/hooks/useConfigDocument";

describe("providers page OpenAI Realtime settings", () => {
  it("saves the selected OpenAI Realtime voice without touching other providers", async () => {
    const save = vi.fn().mockResolvedValue(true);
    const refetch = vi.fn().mockResolvedValue(undefined);
    const config = {
      default_provider: "google_live",
      providers: {
        google_live: {
          enabled: true,
          type: "full",
          voice: "Aoede",
          capabilities: ["stt", "llm", "tts"],
        },
        openai_realtime: {
          enabled: true,
          type: "openai_realtime",
          model: "gpt-realtime-2",
          voice: "alloy",
          speed: 1,
          capabilities: ["stt", "llm", "tts"],
        },
      },
    };
    useConfigDocument.mockReturnValue({
      config,
      setConfig: vi.fn(),
      save,
      isLoading: false,
      refetch,
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<ProvidersPage />);
    });

    const voiceSelect = [...container.querySelectorAll("select")].find((select) =>
      [...select.options].some((option) => option.value === "cedar"),
    );
    expect(voiceSelect).toBeTruthy();
    expect([...voiceSelect.options].map((option) => option.value)).toContain("marin");

    await act(async () => {
      voiceSelect.value = "cedar";
      voiceSelect.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    try {
      expect(save).toHaveBeenCalledTimes(1);
      const [nextConfig] = save.mock.calls[0];
      expect(nextConfig.providers.openai_realtime.voice).toBe("cedar");
      expect(nextConfig.providers.google_live.voice).toBe("Aoede");
      expect(nextConfig.default_provider).toBe("google_live");
      expect(refetch).toHaveBeenCalledTimes(1);
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });
});
