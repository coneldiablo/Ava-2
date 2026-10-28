import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("@/components/layout/AppShell", () => ({
  AppShell: ({ children }) => <div>{children}</div>,
}));

vi.mock("@/components/config/JsonObjectModal", () => ({
  JsonObjectModal: () => null,
}));

vi.mock("@/components/ui/core", () => ({
  Card: ({ children }) => <section>{children}</section>,
  PillButton: ({ children, onClick }) => <button onClick={onClick}>{children}</button>,
}));

vi.mock("@/components/ui/shell", () => ({
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

import ContextsPage, {
  getSwitchableContextProviders,
  setContextProviderOverride,
} from "./page.jsx";
import { useConfigDocument } from "@/hooks/useConfigDocument";

describe("context provider switching", () => {
  it("lists only enabled full-agent providers with readable labels", () => {
    const providers = getSwitchableContextProviders({
      openai_realtime: {
        enabled: true,
        type: "openai_realtime",
        model: "gpt-realtime-2",
        capabilities: ["stt", "llm", "tts"],
      },
      google_live: {
        enabled: true,
        type: "full",
        capabilities: ["stt", "llm", "tts"],
      },
      openai_llm: {
        enabled: true,
        type: "openai",
        capabilities: ["llm"],
      },
      deepgram: {
        enabled: false,
        type: "full",
        capabilities: ["stt", "llm", "tts"],
      },
    });

    expect(providers.map((provider) => [provider.name, provider.label])).toEqual([
      ["google_live", "Gemini Live"],
      ["openai_realtime", "GPT Realtime 2"],
    ]);
  });

  it("updates only the selected context provider", async () => {
    const save = vi.fn().mockResolvedValue(true);
    const config = {
      default_provider: "local_hybrid",
      providers: {
        openai_realtime: {
          enabled: true,
          type: "openai_realtime",
          model: "gpt-realtime-2",
          capabilities: ["stt", "llm", "tts"],
        },
        google_live: {
          enabled: true,
          type: "full",
          capabilities: ["stt", "llm", "tts"],
        },
      },
      contexts: {
        unified_sales_agent: {
          provider: "openai_realtime",
          profile: "telephony_ulaw_8k",
          greeting: "Hello",
        },
        another_business: {
          provider: "openai_realtime",
          profile: "telephony_ulaw_8k",
        },
      },
    };
    useConfigDocument.mockReturnValue({
      config,
      isLoading: false,
      save,
    });

    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<ContextsPage />);
    });

    const select = container.querySelector('[aria-label="Provider for unified_sales_agent"]');
    expect(select).not.toBeNull();

    await act(async () => {
      select.value = "google_live";
      select.dispatchEvent(new Event("change", { bubbles: true }));
      await Promise.resolve();
    });

    try {
      expect(save).toHaveBeenCalledTimes(1);
      const [nextConfig] = save.mock.calls[0];
      expect(nextConfig.contexts.unified_sales_agent.provider).toBe("google_live");
      expect(nextConfig.contexts.another_business.provider).toBe("openai_realtime");
      expect(nextConfig.default_provider).toBe("local_hybrid");
    } finally {
      await act(async () => {
        root.unmount();
      });
      container.remove();
    }
  });

  it("can clear a context provider override", () => {
    const nextConfig = setContextProviderOverride(
      {
        contexts: {
          unified_sales_agent: {
            provider: "openai_realtime",
            profile: "telephony_ulaw_8k",
          },
        },
      },
      "unified_sales_agent",
      "__default__",
    );

    expect(nextConfig.contexts.unified_sales_agent).toEqual({
      profile: "telephony_ulaw_8k",
    });
  });
});
