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
import ExternalIntegrationPanel from "../src/components/ExternalIntegrationPanel";
import { api } from "../src/api";
vi.mock("../src/api", () => ({
  api: { get: vi.fn(), put: vi.fn(), post: vi.fn(), delete: vi.fn() },
}));
// The catalog has its own acceptance suite; these cases exercise the OAuth form.
vi.mock("../src/components/AmoCatalogImport", () => ({ default: () => null }));
const integration = (provider = "avito") => ({
  provider,
  status: "configured",
  configured: true,
  account: null,
  config: {
    clientId: "app-id",
    domain: "company.amocrm.ru",
    redirectUri:
      "http://localhost:3000/api/external-integrations/callback/amocrm",
  },
  capabilities: { read: true, send: "unverified" },
  mapping: {},
  lastSuccessAt: null,
  error: null,
});
const mount = (provider: "avito" | "amocrm" = "avito", canManage = true) =>
  render(
    <MemoryRouter>
      <ExternalIntegrationPanel
        businessId={7}
        provider={provider}
        canManage={canManage}
      />
    </MemoryRouter>,
  );
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(api.get).mockResolvedValue({
    data: { success: true, integration: integration() },
  });
});
afterEach(cleanup);
describe("Customer external integrations", () => {
  it("connects Avito with one action and keeps the secret write-only", async () => {
    vi.mocked(api.get).mockResolvedValue({data:{success:true,integration:{...integration(),configured:false,status:'not_configured'}}});
    vi.mocked(api.post).mockResolvedValue({data:{success:true,integration:{...integration(),status:'connected',account:{name:'Магазин'}}}});
    mount(); await screen.findByDisplayValue('app-id');
    fireEvent.change(screen.getByLabelText('Секрет приложения'),{target:{value:'test-secret'}});
    fireEvent.click(screen.getByRole('button',{name:'Подключить Авито'}));
    await screen.findByRole('link',{name:'Открыть диалоги Авито'});
    expect(api.post).toHaveBeenCalledTimes(1);
    expect(api.post).toHaveBeenCalledWith('/external-integrations/7/avito/connect',{clientId:'app-id',clientSecret:'test-secret'},expect.objectContaining({timeout:60000}));
    expect(api.put).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Секрет приложения') as HTMLInputElement).value).toBe('');
  });
  it("opens shared conversations instead of a separate Avito inbox", async () => {
    vi.mocked(api.get).mockResolvedValue({data:{success:true,integration:{...integration(),status:'connected',account:{name:'Магазин'}}}});
    mount(); const link=await screen.findByRole('link',{name:'Открыть диалоги Авито'});
    expect(link.getAttribute('href')).toBe('/today?channel=avito');
    for(const name of ['Сохранить настройки','Проверить подключение','Синхронизировать','Получать обновления автоматически','Показать диалоги Авито']) expect(screen.queryByRole('button',{name})).toBeNull();
    const settings=screen.getByText('Настройки подключения').closest('details');
    expect(settings?.hasAttribute('open')).toBe(false);
    expect(api.post).not.toHaveBeenCalled();
  });
  it("shows the failed setup state and restores it with one retry", async () => {
    const failed={...integration(),status:'access_denied'};
    vi.mocked(api.get).mockResolvedValue({data:{success:true,integration:failed}});
    vi.mocked(api.post).mockRejectedValueOnce({response:{data:{code:'EXTERNAL_ACCESS_DENIED'}}}).mockResolvedValueOnce({data:{success:true,integration:{...integration(),status:'connected',account:{name:'Магазин'}}}});
    mount(); fireEvent.click(await screen.findByRole('button',{name:'Восстановить подключение'}));
    expect((await screen.findByRole('alert')).textContent).toContain('нет доступа');
    await waitFor(()=>expect((screen.getByRole('button',{name:'Восстановить подключение'}) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole('button',{name:'Восстановить подключение'}));
    await screen.findByRole('link',{name:'Открыть диалоги Авито'});
    expect(screen.queryByRole('alert')).toBeNull();
  });
  it("preserves manual auth code on OAuth failure and shows a readable error", async () => {
    vi.mocked(api.get).mockResolvedValue({
      data: { success: true, integration: integration("amocrm") },
    });
    vi.mocked(api.post).mockRejectedValue({
      response: { data: { code: "EXTERNAL_AUTH_REQUIRED" } },
    });
    mount("amocrm");
    await screen.findByDisplayValue("app-id");
    fireEvent.click(screen.getByText("У меня есть код подключения"));
    fireEvent.change(screen.getByLabelText("Код авторизации"), {
      target: { value: "code-value" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Подключить по коду" }));
    await screen.findByRole("alert");
    expect(
      (screen.getByLabelText("Код авторизации") as HTMLInputElement).value,
    ).toBe("code-value");
    expect(screen.getByRole("alert").textContent).toContain(
      "Авторизация истекла",
    );
  });
  it("shows state but no credentials or mutation controls to managers", async () => {
    mount("avito", false);
    await screen.findByText("Нужно восстановить подключение");
    expect(screen.queryByLabelText("Секрет приложения")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Синхронизировать" }),
    ).toBeNull();
    expect(api.post).not.toHaveBeenCalled();
  });
});

describe('Avito provider access notice',()=>{
  it('keeps available chats connected and explains a provider subscription restriction',async()=>{
    vi.mocked(api.get).mockResolvedValue({data:{success:true,integration:{...integration(),status:'connected',account:{name:'Магазин'},exchange:{historyRestrictedChats:1}}}});
    mount();await screen.findByRole('link',{name:'Открыть диалоги Авито'});
    expect(screen.getByText(/Для них нужна подписка с API мессенджера/)).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
