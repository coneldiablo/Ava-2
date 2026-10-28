// @vitest-environment jsdom
import { afterEach, describe, it, expect, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import CallResultPanel from "../src/components/CallResultPanel";
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("Call result references", () => {
  it("requests runtime call ID for result and record ID for transcript and opens canonical client/task", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async (url) => ({
        ok: true,
        json: async () =>
          String(url).includes("/records/")
            ? {
                success: true,
                businessId: 7,
                recordId: "record-22",
                callId: "runtime-11",
                turns: [{ role: "user", text: "Пришлите предложение" }],
              }
            : {
                success: true,
                businessId: 7,
                callId: "runtime-11",
                postProcessing: "saved",
                summary: "Клиент ждёт предложение",
                client: { chatId: "anna", name: "Анна" },
                tasks: [
                  {
                    taskId: "task",
                    summary: "Отправить предложение",
                    status: "new",
                  },
                ],
                followups: [
                  { draftId: "draft", taskId: "task", state: "draft" },
                ],
              },
      }));
    vi.stubGlobal("fetch", fetchMock);
    render(
      <MemoryRouter>
        <CallResultPanel
          businessId={7}
          recordId="record-22"
          callId="runtime-11"
        />
      </MemoryRouter>,
    );
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Итог и расшифровка" }));
    await screen.findByText("Клиент ждёт предложение");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/businesses/7/telephony/calls/runtime-11/result",
      expect.any(Object),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/businesses/7/telephony/records/record-22/transcript",
      expect.any(Object),
    );
    expect(screen.getByText("Пришлите предложение")).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: "Проверить сообщение" })
        .getAttribute("href"),
    ).toContain("/customers/anna?followup=draft");
  });
  it("rejects a mismatched business or transcript record without exposing text", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue({
          ok: true,
          json: async () => ({
            success: true,
            businessId: 8,
            callId: "runtime",
            recordId: "record",
            summary: "Чужие данные",
            tasks: [],
            followups: [],
            turns: [{ role: "user", text: "Чужие данные" }],
          }),
        }),
    );
    render(
      <MemoryRouter>
        <CallResultPanel businessId={7} recordId="record" callId="runtime" />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Итог и расшифровка" }));
    await screen.findByRole("alert");
    expect(screen.queryByText("Чужие данные")).toBeNull();
  });
});
