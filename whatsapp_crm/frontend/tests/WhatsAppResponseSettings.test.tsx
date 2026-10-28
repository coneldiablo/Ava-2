// @vitest-environment jsdom
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import {
  cleanup,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import WhatsAppResponseSettings from "../src/components/WhatsAppResponseSettings";
import { api } from "../src/api";
vi.mock("../src/api", () => ({ api: { get: vi.fn(), put: vi.fn() } }));
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.get).mockResolvedValue({
    data: {
      success: true,
      settings: { delaySeconds: 0, revision: 1, maxDelaySeconds: 300 },
    },
  });
});
afterEach(cleanup);
describe("WhatsApp response delay", () => {
  it("defaults to immediate and saves delay with revision/readback", async () => {
    render(<WhatsAppResponseSettings businessId={7} canManage />);
    const select = await screen.findByLabelText("Пауза перед ответом WhatsApp");
    expect((select as HTMLSelectElement).value).toBe("immediate");
    fireEvent.change(select, { target: { value: "delay" } });
    fireEvent.change(screen.getByLabelText("Секунд ожидания"), {
      target: { value: "15" },
    });
    vi.mocked(api.put).mockResolvedValue({
      data: {
        success: true,
        settings: { delaySeconds: 15, revision: 2, maxDelaySeconds: 300 },
      },
    });
    vi.mocked(api.get).mockResolvedValue({
      data: {
        success: true,
        settings: { delaySeconds: 15, revision: 2, maxDelaySeconds: 300 },
      },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Сохранить время ответа" }),
    );
    await screen.findByText(/Время ожидания сохранено/);
    expect(api.put).toHaveBeenCalledWith(
      "/businesses/7/whatsapp/response-settings",
      { delaySeconds: 15, revision: 1 },
      expect.any(Object),
    );
  });
  it("preserves local choice on conflict and explicit refresh does not overwrite it", async () => {
    vi.mocked(api.put).mockRejectedValue({ response: { status: 409 } });
    render(<WhatsAppResponseSettings businessId={7} canManage />);
    fireEvent.change(
      await screen.findByLabelText("Пауза перед ответом WhatsApp"),
      { target: { value: "delay" } },
    );
    fireEvent.change(screen.getByLabelText("Секунд ожидания"), {
      target: { value: "22" },
    });
    fireEvent.click(
      screen.getByRole("button", { name: "Сохранить время ответа" }),
    );
    await screen.findByRole("alert");
    fireEvent.click(
      screen.getByRole("button", { name: "Обновить сохранённую настройку" }),
    );
    await screen.findByText(/Ваш выбор оставлен/);
    expect(
      (screen.getByLabelText("Секунд ожидания") as HTMLInputElement).value,
    ).toBe("22");
  });
  it("keeps manager settings read-only", async () => {
    render(<WhatsAppResponseSettings businessId={7} canManage={false} />);
    expect(
      (
        (await screen.findByLabelText(
          "Пауза перед ответом WhatsApp",
        )) as HTMLSelectElement
      ).disabled,
    ).toBe(true);
    expect(
      screen.queryByRole("button", { name: "Сохранить время ответа" }),
    ).toBeNull();
  });
});

it("saves opt-in OpenWA typing and confirms canonical readback", async () => {
  render(<WhatsAppResponseSettings businessId={7} canManage typingAvailable />);
  const checkbox = await screen.findByRole('checkbox', { name: 'Показывать «печатает», пока помощник готовит ответ' });
  expect((checkbox as HTMLInputElement).checked).toBe(false); fireEvent.click(checkbox);
  vi.mocked(api.put).mockResolvedValue({ data: { success: true, settings: { delaySeconds: 0, revision: 2, maxDelaySeconds: 300, typingEnabled: true } } });
  vi.mocked(api.get).mockResolvedValue({ data: { success: true, settings: { delaySeconds: 0, revision: 2, maxDelaySeconds: 300, typingEnabled: true } } });
  fireEvent.click(screen.getByRole('button', { name: 'Сохранить время ответа' }));
  await screen.findByText(/Сохранено. AVA отвечает/);
  expect(api.put).toHaveBeenCalledWith('/businesses/7/whatsapp/response-settings', { delaySeconds: 0, revision: 1, typingEnabled: true }, expect.any(Object));
});
it("hides typing configuration outside OpenWA and preserves legacy delay payload", async () => {
  render(<WhatsAppResponseSettings businessId={7} canManage />);
  await screen.findByLabelText('Пауза перед ответом WhatsApp'); expect(screen.queryByRole('checkbox')).toBeNull();
});
