// @vitest-environment jsdom
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import CommercialDocuments from "../src/components/CommercialDocuments";
import { api } from "../src/api";
vi.mock("../src/api", () => ({ api: { get: vi.fn(), post: vi.fn() } }));
const props = {
  businessId: 7,
  dealId: "deal",
  materialRevision: 1,
  clientChatId: "anna",
  canWrite: true,
  canSend: true,
  changed: false,
  storageScope: "7:owner",
};
let invoices: Record<string, unknown>[] = [];
const metadata = () => ({
  success: true,
  businessId: 7,
  dealId: "deal",
  materialVersions: [{ revision: 1, createdAt: "2026-10-18T10:00:00Z" }],
  invoiceVersions: invoices,
});
const mount = (overrides = {}) =>
  render(
    <MemoryRouter>
      <CommercialDocuments {...props} {...overrides} />
    </MemoryRouter>,
  );
beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  invoices = [];
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  vi.mocked(api.get).mockImplementation(async (url) => ({
    data: String(url).endsWith("/anna")
      ? {
          success: true,
          businessId: 7,
          client: { chatId: "anna", name: "Анна" },
          dialogueRevision: "5",
        }
      : String(url).includes("reply-status")
        ? { success: true, businessId: 7, status: "unknown" }
        : metadata(),
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function fillInvoice() {
  fireEvent.change(screen.getByLabelText("Номер счёта"), {
    target: { value: "АВА-001" },
  });
  const fields: Record<string, string> = {
    "Юридическое имя": "Поставщик",
    ИНН: "7701234567",
    Адрес: "Москва",
    "Название банка": "Банк",
    БИК: "044525225",
    "Расчётный счёт": "40702810900000000001",
  };
  Object.entries(fields).forEach(([key, value]) =>
    fireEvent.change(screen.getByLabelText(`Поставщик: ${key}`), {
      target: { value },
    }),
  );
  fireEvent.change(
    screen.getByLabelText("Плательщик: Имя или название плательщика"),
    { target: { value: "Анна" } },
  );
  fireEvent.click(
    screen.getByLabelText("Реквизиты, позиции и сумма проверены"),
  );
}
describe("Versioned commercial documents", () => {
  it("shows real server PDF actions only after saved version metadata and keeps payment distinct", async () => {
    invoices = [
      {
        revision: 1,
        materialRevision: 1,
        number: "АВА-1",
        totalMinor: 10000,
        currency: "RUB",
        paymentStatus: "not_recorded",
        fiscalReceipt: false,
      },
    ];
    mount();
    await screen.findByLabelText("Версия предложения PDF");
    expect(screen.getAllByRole("button", { name: "Скачать PDF" })).toHaveLength(
      2,
    );
    expect(screen.getByText(/Оплата пока не зафиксирована/)).toBeTruthy();
    expect(api.post).not.toHaveBeenCalled();
  });
  it("issues a version with confirmation, stable retry key and readback", async () => {
    vi.mocked(api.post).mockImplementation(async (url, body) => {
      const b = body as Record<string, unknown>;
      const invoice = {
        ...b,
        revision: 1,
        paymentStatus: "not_recorded",
        fiscalReceipt: false,
        totalMinor: 10000,
        currency: "RUB",
      };
      invoices = [invoice];
      return {
        data: { success: true, businessId: 7, dealId: "deal", invoice },
      };
    });
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Выставить счёт" }),
    );
    fillInvoice();
    fireEvent.click(screen.getByRole("button", { name: "Выпустить счёт" }));
    await screen.findByText(/Счёт выпущен/);
    const body = vi.mocked(api.post).mock.calls[0][1] as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      revision: 0,
      materialRevision: 1,
      requisitesConfirmed: true,
      number: "АВА-001",
    });
    expect(body).not.toHaveProperty("totalMinor");
    expect(body.idempotencyKey).toEqual(expect.any(String));
    expect(api.get).toHaveBeenCalledTimes(2);
  });
  it("preserves requisites and exact key after lost save acknowledgement and reload", async () => {
    vi.mocked(api.post).mockRejectedValue(new Error("timeout"));
    const view = mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Выставить счёт" }),
    );
    fillInvoice();
    fireEvent.click(screen.getByRole("button", { name: "Выпустить счёт" }));
    await screen.findByRole("alert");
    const first = vi.mocked(api.post).mock.calls[0][1];
    view.unmount();
    mount();
    await screen.findByLabelText("Номер счёта");
    expect(
      (screen.getByLabelText("Номер счёта") as HTMLInputElement).value,
    ).toBe("АВА-001");
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Выпустить счёт",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Выпустить счёт" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.post).mock.calls[1][1]).toEqual(first);
  });
  it("requires recipient confirmation and passes the read dialogue revision", async () => {
    vi.mocked(api.post).mockResolvedValue({
      data: { success: true, businessId: 7, status: "sent" },
    });
    mount();
    const button = await screen.findByRole("button", {
      name: "Отправить PDF в WhatsApp",
    });
    vi.mocked(window.confirm).mockReturnValue(false);
    fireEvent.click(button);
    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    expect(api.post).not.toHaveBeenCalled();
    vi.mocked(window.confirm).mockReturnValue(true);
    fireEvent.click(button);
    await screen.findByText(/Документ принят WhatsApp/);
    expect(api.post).toHaveBeenCalledWith(
      "/businesses/7/studio/proposals/deal/documents/send",
      { kind: "proposal", revision: 1, expectedDialogueRevision: "5" },
      expect.any(Object),
    );
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining("Анна"),
    );
  });
  it("blocks repeated unknown send across reload and checks status without another dispatch", async () => {
    vi.mocked(api.post).mockResolvedValue({
      data: { success: true, businessId: 7, status: "unknown" },
    });
    const view = mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Отправить PDF в WhatsApp" }),
    );
    await screen.findByRole("button", { name: "Проверить отправку" });
    view.unmount();
    mount();
    await screen.findByRole("button", { name: "Проверить отправку" });
    expect(
      (
        screen.getByRole("button", {
          name: "Отправить PDF в WhatsApp",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Проверить отправку" }));
    await waitFor(() =>
      expect(api.get).toHaveBeenCalledWith(
        expect.stringContaining("reply-status"),
        expect.objectContaining({
          params: { idempotencyKey: "commercial:7:deal:proposal:1" },
        }),
      ),
    );
    expect(api.post).toHaveBeenCalledTimes(1);
  });
  it("does not lock PDF sending after a confirmed pre-dispatch rejection", async () => {
    vi.mocked(api.post).mockRejectedValue({
      response: { status: 409, data: { code: "WORKSPACE_DIALOGUE_CHANGED" } },
    });
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Отправить PDF в WhatsApp" }),
    );
    await screen.findByRole("alert");
    expect(
      screen.queryByRole("button", { name: "Проверить отправку" }),
    ).toBeNull();
    expect(
      (
        screen.getByRole("button", {
          name: "Отправить PDF в WhatsApp",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
  it("does not expose invoice editing or sending to read-only roles", async () => {
    mount({ canWrite: false, canSend: false });
    await screen.findByLabelText("Версия предложения PDF");
    expect(screen.queryByRole("button", { name: "Выставить счёт" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Отправить PDF в WhatsApp" }),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "Скачать PDF" })).toBeTruthy();
  });
  it("rejects wrong-business metadata and preserves pending edits on conflict", async () => {
    vi.mocked(api.get).mockResolvedValue({
      data: { ...metadata(), businessId: 8 },
    });
    mount();
    await screen.findByRole("alert");
    expect(screen.queryByRole("button", { name: "Скачать PDF" })).toBeNull();
  });
});
