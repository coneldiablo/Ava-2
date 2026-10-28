// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import CustomerCalls from "../src/pages/CustomerCalls";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const response = (body: unknown) =>
  Promise.resolve({ ok: true, json: async () => body });
describe("external customer calls", () => {
  it("continues through pages with no matching calls without claiming empty history", async () => {
    const fetch = vi.fn((url: string) =>
      response(
        url.endsWith("page=1")
          ? {
              success: true,
              instanceId: 4,
              calls: [],
              nextPage: 2,
              sourceComplete: false,
            }
          : {
              success: true,
              instanceId: 4,
              calls: [
                {
                  id: "opaque-secret",
                  timestamp: "2026-10-01T10:00:00Z",
                  direction: "inbound",
                  outcome: "answered",
                  durationSeconds: 65,
                },
              ],
              nextPage: null,
              sourceComplete: true,
            },
      ),
    );
    vi.stubGlobal("fetch", fetch);
    render(<CustomerCalls instanceId={4} chatId="fixture" />);
    fireEvent.click(await screen.findByText("Показать более ранние звонки"));
    expect(screen.queryByText("Звонков пока нет.")).toBeNull();
    await screen.findByText("Входящий звонок");
    expect(screen.getByText("Состоялся · 1 мин 5 сек")).toBeTruthy();
    expect(screen.queryByText(/opaque-secret/)).toBeNull();
    expect(fetch.mock.calls.map((c) => c[0])).toEqual([
      "/api/clients/4/fixture/calls?page=1",
      "/api/clients/4/fixture/calls?page=2",
    ]);
  });
  it("rejects another business response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        response({
          success: true,
          instanceId: 19,
          calls: [{ id: "x", direction: "outbound", outcome: "answered" }],
          nextPage: null,
          sourceComplete: true,
        }),
      ),
    );
    render(<CustomerCalls instanceId={4} chatId="fixture" />);
    await screen.findByRole("alert");
    expect(screen.queryByText("Исходящий звонок")).toBeNull();
    expect(screen.queryByText("Звонков пока нет.")).toBeNull();
  });
});
