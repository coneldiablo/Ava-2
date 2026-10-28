// @vitest-environment jsdom
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
  act,
} from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import OutboundCampaigns from "../src/pages/OutboundCampaigns";
import * as api from "../src/api/outbound";
import { getTelephony } from "../src/api/telephony";
const fixture = vi.hoisted(() => ({ businessId: 7, role: "hotel_owner",canManage:true }));
vi.mock("../src/context/InstanceContext", () => ({
  useInstance: () => ({
    currentInstanceId: fixture.businessId,
    currentInstance: { id: fixture.businessId, name: "Test" },
  }),
}));
vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({
    userId: "owner",
    memberships: [{ businessId: fixture.businessId, role: fixture.role,capabilities:fixture.canManage?["business.manage"]:[] }],
  }),
}));
vi.mock("../src/api/telephony", () => ({ getTelephony: vi.fn() }));
vi.mock("../src/api/outbound", () => ({
  listCampaigns: vi.fn(),
  previewCampaign: vi.fn(),
  createCampaign: vi.fn(),
  commandCampaign: vi.fn(),
  reconcileCampaign: vi.fn(),
  syncCrmCampaign: vi.fn(),
}));
const campaign = (id = 7) => ({
  campaignId: `c-${id}`,
  businessId: id,
  name: `Кампания ${id}`,
  timezone: "Europe/Moscow",
  callWindow: { start: "09:00", end: "18:00" },
  maxAttempts: 1,
  sourceNumberId: null,
  counts: { pending: 3, blocked: 1 },
  audienceSize: 3,
  status: "draft",
  command: null,
});
const sources = {
  managedMode: true,
  numbers: [
    {
      id: "not-ready",
      number: "74950000000",
      state: "active",
      outboundReady: 0,
    },
    {
      id: "primary",
      number: "74950000001",
      state: "active",
      outboundReady: 1,
      isPrimary: 1,
    },
    {
      id: "other",
      number: "74950000002",
      state: "active",
      outboundReady: 1,
      isPrimary: 0,
    },
  ],
};
const mount = () =>
  render(
    <MemoryRouter>
      <OutboundCampaigns />
    </MemoryRouter>,
  );
beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
  fixture.businessId = 7;
  fixture.role = "hotel_owner";fixture.canManage=true;
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
  vi.mocked(getTelephony).mockResolvedValue(sources as never);
  vi.mocked(api.listCampaigns).mockImplementation(async (id) => ({
    success: true,
    campaigns: [campaign(id)],
  }));
  vi.mocked(api.commandCampaign).mockImplementation(async (id, c, body) => ({
    success: true,
    campaign: {
      ...campaign(id),
      command: { id: "cmd", action: body.action, state: "succeeded" },
    },
  }));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe("Durable campaign customer path", () => {
  it("prepares without real start and passes the selected ready source and unique key", async () => {
    mount();
    const select = await screen.findByRole("combobox", {
      name: "Номер для кампании «Кампания 7»",
    });
    expect(screen.queryByRole("option", { name: /74950000000/ })).toBeNull();
    fireEvent.change(select, { target: { value: "other" } });
    fireEvent.click(screen.getByRole("button", { name: "Подготовить в AVA" }));
    await waitFor(() =>
      expect(api.commandCampaign).toHaveBeenCalledWith(
        7,
        "c-7",
        { action: "prepare", sourceNumberId: "other" },
        expect.any(String),
        expect.any(AbortSignal),
      ),
    );
    expect(window.confirm).not.toHaveBeenCalled();
  });
  it("requires a real call confirmation containing exact current audience", async () => {
    mount();
    await screen.findByText("Кампания 7");
    vi.mocked(window.confirm).mockReturnValue(false);
    fireEvent.click(screen.getByRole("button", { name: "Запустить звонки" }));
    expect(api.commandCampaign).not.toHaveBeenCalled();
    vi.mocked(window.confirm).mockReturnValue(true);
    fireEvent.click(screen.getByRole("button", { name: "Запустить звонки" }));
    await waitFor(() =>
      expect(api.commandCampaign).toHaveBeenCalledWith(
        7,
        "c-7",
        { action: "start", confirmAudience: 3, sourceNumberId: "primary" },
        expect.any(String),
        expect.any(AbortSignal),
      ),
    );
    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining("3 контактов"),
    );
  });
  it("blocks unknown outcome across reload and reconciles without dispatching another call", async () => {
    const c = {
      ...campaign(),
      command: { id: "unknown", action: "start", state: "unknown" as const },
    };
    vi.mocked(api.listCampaigns).mockResolvedValue({
      success: true,
      campaigns: [c],
    });
    vi.mocked(api.reconcileCampaign).mockResolvedValue({
      success: true,
      campaign: {
        ...c,
        status: "running",
        command: { ...c.command, state: "succeeded" },
      },
    });
    const view = mount();
    await screen.findByRole("button", { name: "Уточнить состояние" });
    expect(
      screen.queryByRole("button", { name: "Запустить звонки" }),
    ).toBeNull();
    view.unmount();
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Уточнить состояние" }),
    );
    await screen.findByRole("button", { name: "Пауза" });
    expect(api.commandCampaign).not.toHaveBeenCalled();
    expect(api.reconcileCampaign).toHaveBeenCalledWith(
      7,
      "c-7",
      expect.any(AbortSignal),
    );
  });
  it("keeps a lost acknowledgement locked even if local GET is stale", async () => {
    vi.mocked(api.commandCampaign).mockRejectedValue({
      response: {
        status: 409,
        data: { code: "TELEPHONY_CAMPAIGN_OUTCOME_UNKNOWN" },
      },
    });
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Запустить звонки" }),
    );
    await screen.findByRole("button", { name: "Уточнить состояние" });
    expect(
      screen.queryByRole("button", { name: "Запустить звонки" }),
    ).toBeNull();
    expect(api.commandCampaign).toHaveBeenCalledTimes(1);
  });
  it("does not allow duplicate click while a command is pending", async () => {
    let resolve!: (value: never) => void;
    vi.mocked(api.commandCampaign).mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    mount();
    const b = await screen.findByRole("button", { name: "Запустить звонки" });
    fireEvent.click(b);
    fireEvent.click(b);
    expect(api.commandCampaign).toHaveBeenCalledTimes(1);
    await act(async () =>
      resolve({
        success: true,
        campaign: {
          ...campaign(),
          command: { id: "x", action: "start", state: "succeeded" },
        },
      } as never),
    );
  });
  it("blocks launch when source lookup fails and recovers on refresh", async () => {
    vi.mocked(getTelephony).mockRejectedValueOnce(new Error());
    mount();
    await screen.findByText(/Не удалось проверить исходящие/);
    expect(
      (
        screen.getByRole("button", {
          name: "Запустить звонки",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Обновить" }));
    await screen.findByRole("combobox");
    expect(
      (
        screen.getByRole("button", {
          name: "Запустить звонки",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });
  it("does not silently substitute an inactive stored source", async () => {
    vi.mocked(api.listCampaigns).mockResolvedValue({
      success: true,
      campaigns: [{ ...campaign(), sourceNumberId: "inactive" }],
    });
    mount();
    const start = await screen.findByRole("button", {
      name: "Запустить звонки",
    });
    expect((start as HTMLButtonElement).disabled).toBe(true);
  });
  it("allows correction after the server rejects an unavailable source before dispatch", async () => {
    vi.mocked(api.commandCampaign).mockRejectedValue({
      response: { status: 409, data: { code: "TELEPHONY_SOURCE_UNAVAILABLE" } },
    });
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Запустить звонки" }),
    );
    await screen.findByRole("alert");
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Запустить звонки",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    expect(
      screen.queryByRole("button", { name: "Уточнить состояние" }),
    ).toBeNull();
  });
  it("preserves legacy configured routing without a managed source", async () => {
    vi.mocked(getTelephony).mockResolvedValue({
      managedMode: false,
      numbers: [],
    } as never);
    mount();
    fireEvent.click(
      await screen.findByRole("button", { name: "Подготовить в AVA" }),
    );
    await waitFor(() =>
      expect(api.commandCampaign).toHaveBeenCalledWith(
        7,
        "c-7",
        { action: "prepare", sourceNumberId: null },
        expect.any(String),
        expect.any(AbortSignal),
      ),
    );
  });
  it('does not infer manage permission from owner role alone',async()=>{
    fixture.canManage=false;mount();await screen.findByText('Кампания 7');expect(screen.queryByRole('button',{name:'Новая кампания'})).toBeNull();expect(screen.queryByRole('button',{name:'Запустить звонки'})).toBeNull();
  });
  it("keeps managers read-only", async () => {
    fixture.role = "manager";
    mount();
    await screen.findByText("Кампания 7");
    expect(screen.queryByRole("button", { name: "Новая кампания" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Запустить звонки" }),
    ).toBeNull();
  });
  it("validates CSV and needs opt-in for invalid rows before creating a draft", async () => {
    vi.mocked(api.previewCampaign).mockResolvedValue({
      success: true,
      importId: "import",
      expiresAt: Date.now() + 60000,
      counts: { total: 2, accepted: 1, invalid: 1, duplicates: 0 },
      rows: [{ name: "Анна", phone: "79990000000" }],
      errors: [{ row: 3, code: "INVALID_PHONE" }],
      duplicates: [],
    });
    vi.mocked(api.createCampaign).mockResolvedValue({
      success: true,
      campaign: campaign(),
    });
    mount();
    await screen.findByText("Кампания 7");
    fireEvent.click(screen.getByRole("button", { name: "Новая кампания" }));
    fireEvent.change(screen.getByLabelText("Или вставьте CSV"), {
      target: { value: "phone;name\n79990000000;Анна" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Проверить контакты" }));
    await screen.findByText(/Готово к добавлению: 1/);
    fireEvent.change(screen.getByLabelText("Название кампании"), {
      target: { value: "Импорт" },
    });
    expect(
      (
        screen.getByRole("button", {
          name: "Сохранить черновик",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByLabelText(/Добавить только подходящие/));
    fireEvent.click(screen.getByRole("button", { name: "Сохранить черновик" }));
    await waitFor(() =>
      expect(api.createCampaign).toHaveBeenCalledWith(
        7,
        {
          name: "Импорт",
          importId: "import",
          sourceNumberId: "primary",
          timezone: "Europe/Moscow",
          callWindow: { start: "09:00", end: "18:00" },
          maxAttempts: 1,
          retryIntervalMinutes: 1,
        },
        expect.any(String),
        expect.any(AbortSignal),
      ),
    );
    expect(api.commandCampaign).not.toHaveBeenCalled();
  });
  it('preserves CRM filters through the same preview and empty-state contract',async()=>{
    vi.mocked(api.previewCampaign).mockResolvedValue({success:true,importId:'empty',expiresAt:Date.now()+60000,counts:{total:0,accepted:0,invalid:0,duplicates:0},rows:[],errors:[],duplicates:[]});
    mount();await screen.findByText('Кампания 7');fireEvent.click(screen.getByRole('button',{name:'Новая кампания'}));fireEvent.click(screen.getByRole('button',{name:'Клиенты AVA'}));
    fireEvent.change(screen.getByLabelText('Без общения не менее дней'),{target:{value:'7'}});
    fireEvent.click(screen.getByRole('button',{name:'Проверить контакты'}));await screen.findByText(/По выбранным условиям нет контактов/);
    expect(api.previewCampaign).toHaveBeenCalledWith(7,{sourceFilter:{statuses:['new','qualified'],tags:[],exclude_tags:['do_not_call','no_call','отказ'],silentDays:7}},expect.any(AbortSignal));
    expect((screen.getByRole('button',{name:'Сохранить черновик'}) as HTMLButtonElement).disabled).toBe(true);
    expect(api.createCampaign).not.toHaveBeenCalled();
  });
  it('preserves safe list refresh only for legacy CRM drafts without a command',async()=>{
    vi.mocked(api.listCampaigns).mockResolvedValue({success:true,campaigns:[{...campaign(),audienceSource:'crm'}]});vi.mocked(api.syncCrmCampaign).mockResolvedValue({success:true,accepted:3,blocked:1});
    mount();fireEvent.click(await screen.findByRole('button',{name:'Обновить список клиентов'}));await screen.findByText(/Список клиентов обновлён: 3/);expect(api.syncCrmCampaign).toHaveBeenCalledWith('c-7',expect.any(AbortSignal));expect(api.commandCampaign).not.toHaveBeenCalled();
    vi.mocked(api.listCampaigns).mockResolvedValue({success:true,campaigns:[{...campaign(),audienceSource:'import'}]});fireEvent.click(screen.getByRole('button',{name:'Обновить'}));await waitFor(()=>expect(screen.queryByRole('button',{name:'Обновить список клиентов'})).toBeNull());
  });
  it("discards late responses after changing business", async () => {
    let resolve!: (value: never) => void;
    vi.mocked(api.listCampaigns).mockReturnValueOnce(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const view = mount();
    fixture.businessId = 8;
    view.rerender(
      <MemoryRouter>
        <OutboundCampaigns />
      </MemoryRouter>,
    );
    await screen.findByText("Кампания 8");
    await act(async () =>
      resolve({ success: true, campaigns: [campaign(7)] } as never),
    );
    expect(screen.queryByText("Кампания 7")).toBeNull();
  });
});
