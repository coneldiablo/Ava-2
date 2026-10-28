// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import CustomerFollowups from "../src/pages/CustomerFollowups";
import CustomerIdentities from "../src/pages/CustomerIdentities";
vi.mock('../src/permissions', () => ({ useBusinessAccess: () => ({
  role: 'manager', userId: 'manager-id', can: (capability: string) => ['sales.write', 'messages.send', 'tasks.claim'].includes(capability),
}) }));
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => store.set(key, value),
    removeItem: (key: string) => store.delete(key),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const response = (body: unknown, status = 200) =>
  Promise.resolve({ ok: status < 400, status, json: async () => body });
describe("customer actions", () => {
  it("persists edited text before explicit send and never calls pending sent", async () => {
    let savedText = "Draft";
    let savedChannel = '';
    let savedRecipient = '';
    let assigned = false;
    const fetch = vi.fn((url: string, options?: RequestInit) => {
      if (url.endsWith("followup-drafts"))
        return response({
          success: true,
          drafts: [{ draft_id: "fixture", text: savedText, status: "draft", channel: savedChannel, recipient: savedRecipient, assigneeUserId: assigned ? "manager-id" : null }],
        });
      if (url.endsWith("followup-channels"))
        return response({
          success: true,
          channels: [
            { channel: "telegram", recipient: "42", label: "Telegram" },
          ],
        });
      if (url.endsWith("/claim")) {
        assigned = true;
        return response({
          success: true,
          draft: {
            draft_id: "fixture",
            text: "Draft",
            status: "draft",
            assigneeUserId: "manager-id",
          },
        });
      }
      if (options?.method === "PATCH") { const saved = JSON.parse(String(options.body)); savedText = saved.text; savedChannel = saved.channel; savedRecipient = saved.recipient; return response({ success: true }); }
      return response({ success: true, status: "pending" });
    });
    vi.stubGlobal("fetch", fetch);
    render(<CustomerFollowups instanceId={4} chatId="fixture" />);
    fireEvent.click(await screen.findByText("Взять задачу"));
    await screen.findByLabelText("Сообщение клиенту");
    fireEvent.change(screen.getByLabelText("Сообщение клиенту"), {
      target: { value: "Edited" },
    });
    expect(localStorage.getItem("ava-followup:4:manager-id:fixture")).toBe("Edited");
    fireEvent.change(screen.getByLabelText("Связанный канал"), {
      target: { value: "0" },
    });
    fireEvent.click(screen.getByText("Отправить клиенту"));
    expect(fetch.mock.calls.filter(call => call[1]?.method === 'PATCH')).toHaveLength(0);
    fireEvent.click(screen.getByLabelText('Я проверил адресата и текст сообщения'));
    fireEvent.click(screen.getByText('Подтвердить отправку'));
    await screen.findByText(
      "Отправка ожидает подтверждения. Повторная отправка пока недоступна.",
    );
    expect(screen.queryByText("Сообщение отправлено.")).toBeNull();
    const calls = fetch.mock.calls.filter((call) => call[1]?.method);
    expect(calls.map((call) => call[1]?.method)).toEqual([
      "POST",
      "PATCH",
      "POST",
    ]);
    expect(JSON.parse(String(calls[1][1]?.body))).toEqual({
      instanceId: 4,
      text: "Edited",
      channel: "telegram",
      recipient: "42",
    });
  });
  it("requires reviewing conflicting card and explicit confirmation before merge", async () => {
    const fetch = vi.fn((_url: string, options?: RequestInit) =>
      options?.method === "POST"
        ? response({ success: false, conflictingChatId: "other" }, 409)
        : response({
            success: true,
            aliases: [],
            clients: [
              {
                instanceId: 4,
                chatId: "tg_42",
                senderName: "Selected client",
                lastMessage: "Hello",
              },
              { instanceId: 19, chatId: "tg_99", senderName: "Other tenant" },
            ],
          }),
    );
    vi.stubGlobal("fetch", fetch);
    render(
      <CustomerIdentities
        assigneeUserId="manager-id"
        instanceId={4}
        chatId="fixture"
        onLinked={() => {}}
      />,
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    await screen.findByText("Selected client · Telegram · Hello");
    expect(screen.queryByText(/Other tenant/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Диалог клиента"), {
      target: { value: "42" },
    });
    fireEvent.click(screen.getByText("Привязать контакт"));
    expect(fetch.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(0);
    fireEvent.click(screen.getByLabelText('Я проверил контакт и подтверждаю, что он принадлежит этому клиенту'));
    fireEvent.click(screen.getByText('Подтвердить привязку'));
    expect(
      await screen.findByText("Открыть карточку для проверки"),
    ).toBeTruthy();
    const merge = screen.getByText(
      "Объединить и привязать",
    ) as HTMLButtonElement;
    expect(merge.disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox"));
    expect(merge.disabled).toBe(false);
    fireEvent.click(merge);
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(4));
    expect(JSON.parse(String(fetch.mock.calls[3][1]?.body))).toEqual({
      kind: "telegram",
      value: "42",
      mergeChatId: "other",
      confirmMerge: true,
    });
  });
});
it("keeps edited text when durable save fails and makes no send request", async () => {
  const fetch = vi.fn((url: string, _options?: RequestInit) => {
    if (url.endsWith("followup-drafts"))
      return response({
        success: true,
        drafts: [{ draft_id: "failed", text: "Original", status: "draft", assigneeUserId: null }],
      });
    if (url.endsWith("followup-channels"))
      return response({
        success: true,
        channels: [{ channel: "telegram", recipient: "42", label: "Telegram" }],
      });
    if (url.endsWith("/claim"))
      return response({
        success: true,
        draft: {
          draft_id: "failed",
          text: "Original",
          status: "draft",
          assigneeUserId: "manager-id",
        },
      });
    return response({ success: false }, 500);
  });
  vi.stubGlobal("fetch", fetch);
  render(<CustomerFollowups instanceId={4} chatId="fixture" />);
  fireEvent.click(await screen.findByText("Взять задачу"));
  await screen.findByLabelText("Сообщение клиенту");
  fireEvent.change(screen.getByLabelText("Сообщение клиенту"), {
    target: { value: "Kept after error" },
  });
  fireEvent.change(screen.getByLabelText("Связанный канал"), {
    target: { value: "0" },
  });
  fireEvent.click(screen.getByText("Отправить клиенту"));
  fireEvent.click(screen.getByLabelText('Я проверил адресата и текст сообщения'));
  fireEvent.click(screen.getByText('Подтвердить отправку'));
  await screen.findByRole("alert");
  expect(
    (screen.getByLabelText("Сообщение клиенту") as HTMLTextAreaElement).value,
  ).toBe("Kept after error");
  expect(localStorage.getItem("ava-followup:4:manager-id:failed")).toBe(
    "Kept after error",
  );
  expect(
    fetch.mock.calls.filter(
      (call) =>
        call[1]?.method === "POST" && !String(call[0]).endsWith("/claim"),
    ),
  ).toHaveLength(0);
});
it("does not offer unlinking the primary contact", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() =>
      response({
        success: true,
        aliases: [{ id: null, primary: true, kind: "telegram", value: "42" }],
      }),
    ),
  );
  render(
    <CustomerIdentities assigneeUserId="manager-id" instanceId={4} chatId="fixture" onLinked={() => {}} />,
  );
  await screen.findByText("Telegram · Связан");
  expect(screen.queryByText("Отвязать")).toBeNull();
});
it("does not open a task claimed by another manager", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      url.endsWith("followup-drafts")
        ? response({
            success: true,
            drafts: [
              {
                draft_id: "taken",
                text: "Draft",
                status: "draft",
                assigneeUserId: "someone",
              },
            ],
          })
        : url.endsWith("followup-channels")
          ? response({ success: true, channels: [] })
          : response({ success: false }, 409),
    ),
  );
  render(<CustomerFollowups instanceId={4} chatId="fixture" />);
  await screen.findByText("Draft");
  expect(screen.queryByText("Открыть задачу")).toBeNull();
  expect(screen.queryByText("Взять задачу")).toBeNull();
  expect(screen.queryByLabelText("Сообщение клиенту")).toBeNull();
});
