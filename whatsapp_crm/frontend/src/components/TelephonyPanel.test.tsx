// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import TelephonyPanel from './TelephonyPanel';
import * as api from '../api/telephony';
import type { Operation, Phone, Quote, Telephony } from '../api/telephony';
vi.mock('../api/telephony', () => ({ getTelephony:vi.fn(),getPhoneCatalog:vi.fn(),findPhones:vi.fn(),
    getPhoneOperation:vi.fn(),buyPhone:vi.fn(),setPrimaryPhone:vi.fn(),releasePhone:vi.fn(),getExistingPhones:vi.fn(),importExistingPhone:vi.fn(),getExistingPhoneOperation:vi.fn(),getManualPhones:vi.fn() }));
const overview = (extra:Partial<Telephony>={}):Telephony => ({ success:true,canManage:true,canPurchase:true,
    managedMode:false,pilotEnabled:true,balanceReady:true,numbers:[],orders:[],remainingSeconds:1790,
    limits:{numbers:3,dailySeconds:1800},notices:[],...extra });
const operation = (extra:Partial<Operation>={}):Operation => ({ id:'op-1',phoneId:null,kind:'quotes',stage:'done',state:'done',errorCode:null,result:null,...extra });
const phone = (extra:Partial<Phone>={}):Phone => ({ id:'p-1',number:'74950000001',state:'active',isPrimary:0,
    installKopecks:10000,monthlyKopecks:5000,inboundReady:1,outboundReady:1,inboundVerifiedAt:null,
    outboundVerifiedAt:null,releaseAt:null,warningAt:null,...extra });
let quote:Quote;
const deferred = <T,>() => { let resolve!:(value:T)=>void; const promise=new Promise<T>(r=>{resolve=r;}); return {promise,resolve}; };
beforeEach(()=>{
    vi.resetAllMocks();sessionStorage.clear();
    vi.mocked(api.getManualPhones).mockResolvedValue({inboundNumbers:[],outboundNumber:null});
    quote={id:'q-1',number:'74950000001',installKopecks:10000,monthlyKopecks:5000,expiresAt:Date.now()+120000};
    vi.mocked(api.getTelephony).mockResolvedValue(overview());
    vi.mocked(api.getPhoneCatalog).mockResolvedValue({types:[{type_id:1105,type_name:'Городской'}],regions:[{id:77,name:'Москва'}]});
    vi.mocked(api.findPhones).mockImplementation(async()=>operation({result:{quotes:[quote]}}));
    vi.mocked(api.buyPhone).mockResolvedValue(operation({kind:'purchase',state:'pending',stage:'validate'}));
    vi.mocked(api.setPrimaryPhone).mockResolvedValue({} as never);
    vi.mocked(api.releasePhone).mockResolvedValue({} as never);
});
afterEach(()=>{cleanup();vi.useRealTimers();vi.unstubAllGlobals();});
async function offers() {
    fireEvent.click(await screen.findByRole('button',{name:'Купить номер'}));
    fireEvent.click(await screen.findByRole('button',{name:'Найти номера'}));
    return screen.findByRole('radio');
}
async function selectOffer() {fireEvent.click(await offers());return screen.getByRole('button',{name:`Подтвердить покупку +${quote.number}`});}

describe('existing and manual telephony',()=>{
    const candidate={number:'74950000009',modes:['inbound_only'] as const,monthlyKopecks:null,alreadyBound:false,forwardingReady:true,sipAvailable:false};
    async function existing(extra={}) {
        vi.mocked(api.getTelephony).mockResolvedValue(overview({canPurchase:false,canImport:true,...extra}));
        vi.mocked(api.getExistingPhones).mockResolvedValue({success:true,candidates:[{...candidate,modes:['inbound_only']}],updatedAt:Date.now()});
        vi.mocked(api.importExistingPhone).mockResolvedValue(operation({kind:'import',state:'pending'}));
        const view=render(<TelephonyPanel businessId={7}/>);
        fireEvent.click(await screen.findByRole('button',{name:'Показать разрешённые номера'}));
        await screen.findByRole('combobox',{name:'Существующий номер'});
        return view;
    }
    it('requires attestation and sends only the offered inbound mode without purchasing',async()=>{
        await existing();
        const submit=screen.getByRole('button',{name:'Подключить +74950000009 к AVA'});
        expect((submit as HTMLButtonElement).disabled).toBe(true);
        expect(screen.queryByRole('option',{name:'Входящие и исходящие'})).toBeNull();
        expect(screen.getByText(/У номера нет подходящего SIP/)).toBeTruthy();
        fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(submit);fireEvent.click(submit);
        await screen.findByText(/Заявка на привязку принята/);
        expect(api.importExistingPhone).toHaveBeenCalledTimes(1);
        expect(api.importExistingPhone).toHaveBeenCalledWith(7,{number:candidate.number,mode:'inbound_only',confirmUnused:true},expect.any(String),expect.any(AbortSignal));
        expect(api.buyPhone).not.toHaveBeenCalled();expect(api.getPhoneCatalog).not.toHaveBeenCalled();
    });
    it('blocks an unconfirmed forwarding route even after attestation',async()=>{
        await existing();
        vi.mocked(api.getExistingPhones).mockResolvedValue({success:true,candidates:[{...candidate,modes:['inbound_only'],forwardingReady:false}]});
        fireEvent.click(screen.getByRole('button',{name:'Обновить разрешённые номера'}));
        await screen.findByText(/Переадресация входящих звонков на AVA не подтверждена/);
        fireEvent.click(screen.getByRole('checkbox'));
        const button=screen.getByRole('button',{name:'Подключить +74950000009 к AVA'});
        expect((button as HTMLButtonElement).disabled).toBe(true);fireEvent.click(button);
        expect(api.importExistingPhone).not.toHaveBeenCalled();
    });
    it('retries an ambiguous import with its original key across remounts',async()=>{
        vi.mocked(api.importExistingPhone).mockRejectedValueOnce(new Error('lost'));
        const view=await existing();
        // The one-shot failure remains before the default successful response.
        fireEvent.click(screen.getByRole('checkbox'));fireEvent.click(screen.getByRole('button',{name:'Подключить +74950000009 к AVA'}));
        await screen.findByRole('button',{name:'Проверить прежнюю привязку'});
        const first=vi.mocked(api.importExistingPhone).mock.calls[0];view.unmount();
        render(<TelephonyPanel businessId={7}/>);
        fireEvent.click(await screen.findByRole('button',{name:'Проверить прежнюю привязку'}));
        await screen.findByText(/Заявка на привязку принята/);
        expect(vi.mocked(api.importExistingPhone).mock.calls[1].slice(0,3)).toEqual(first.slice(0,3));
        expect(sessionStorage.getItem('ava-telephony-import:7')).toBeNull();
    });
    it('keeps import unavailable without an explicit management grant',async()=>{
        vi.mocked(api.getTelephony).mockResolvedValue(overview({canPurchase:false,canImport:true,canManage:false}));
        render(<TelephonyPanel businessId={7}/>);await screen.findByText(/Управлять номерами может владелец/);
        expect(screen.queryByRole('button',{name:'Показать разрешённые номера'})).toBeNull();expect(api.getExistingPhones).not.toHaveBeenCalled();
    });
    it('polls inventory then refetches actual candidates',async()=>{
        vi.mocked(api.getTelephony).mockResolvedValue(overview({canPurchase:false,canImport:true}));
        vi.mocked(api.getExistingPhones).mockResolvedValueOnce({success:true,candidates:[],operation:operation({state:'pending',kind:'inventory'})})
            .mockResolvedValueOnce({success:true,candidates:[{...candidate,modes:['inbound_only']}]});
        vi.mocked(api.getExistingPhoneOperation).mockResolvedValue(operation({kind:'inventory'}));
        render(<TelephonyPanel businessId={7}/>);fireEvent.click(await screen.findByRole('button',{name:'Показать разрешённые номера'}));
        await screen.findByRole('combobox',{name:'Существующий номер'},{timeout:4000});
        expect(api.getExistingPhoneOperation).toHaveBeenCalledWith(7,'op-1',expect.any(AbortSignal));expect(api.getExistingPhones).toHaveBeenCalledTimes(2);
    });
    it('shows saved manual numbers without claiming operator verification',async()=>{
        vi.mocked(api.getTelephony).mockResolvedValue(overview({canPurchase:false}));
        vi.mocked(api.getManualPhones).mockResolvedValue({inboundNumbers:['74950000009'],outboundNumber:'74950000008'});
        render(<TelephonyPanel businessId={7}/>);
        await screen.findByText('Входящие номера: 74950000009');
        expect(screen.getByText('Номер для исходящих: 74950000008')).toBeTruthy();
        expect(screen.getByText(/Это сохранённые настройки/)).toBeTruthy();
    });
    it('shows an import refusal with no active claim and preserves provider resources on detachment',async()=>{
        vi.stubGlobal('confirm',vi.fn(()=>false));
        vi.mocked(api.getTelephony).mockResolvedValue(overview({canPurchase:false,managedMode:true,
            numbers:[phone({origin:'existing',outboundReady:0})],orders:[operation({kind:'import',state:'manual',errorCode:'TELEPHONY_IMPORT_FORWARDING_REQUIRED'})]}));
        render(<TelephonyPanel businessId={7}/>);
        await screen.findByText(/Переадресация входящих звонков на AVA не подтверждена/);
        expect(screen.getByText('Входящие: настроены · Исходящие: недоступны')).toBeTruthy();
        fireEvent.click(screen.getByRole('button',{name:'Отключить от AVA через 7 дней'}));
        expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining('Номер и SIP сохранятся у оператора'));
        expect(api.releasePhone).not.toHaveBeenCalled();expect(api.getManualPhones).not.toHaveBeenCalled();
    });
});

describe('managed telephony UI',()=>{
    it('shows minutes and direction readiness without claiming real calls',async()=>{
        vi.mocked(api.getTelephony).mockResolvedValue(overview({numbers:[phone()]}));
        render(<TelephonyPanel businessId={7}/>);
        await screen.findByText(/Осталось 29 мин 50 сек/);
        expect(screen.getByText('Входящие: настроены · Исходящие: настроены')).toBeTruthy();
        expect(screen.getByText(/входящий ещё не получен, исходящий ещё не состоялся/)).toBeTruthy();
    });
    it('hides mutations for read-only users even if canPurchase is inconsistent',async()=>{
        vi.mocked(api.getTelephony).mockResolvedValue(overview({canManage:false,numbers:[phone()]}));
        render(<TelephonyPanel businessId={7}/>);
        await screen.findByText('Управлять номерами может владелец бизнеса.');
        expect(screen.queryByRole('button',{name:'Купить номер'})).toBeNull();
        expect(screen.queryByRole('button',{name:'Сделать основным'})).toBeNull();
        expect(screen.queryByRole('button',{name:'Освободить через 7 дней'})).toBeNull();
    });
    it('keeps existing numbers visible with the pilot disabled',async()=>{
        vi.mocked(api.getTelephony).mockResolvedValue(overview({canPurchase:false,pilotEnabled:false,numbers:[phone()]}));
        render(<TelephonyPanel businessId={7}/>);
        await screen.findByText(/Состояние существующих подключений показано ниже/);
        expect(screen.getByText('+74950000001')).toBeTruthy();
        expect(screen.queryByRole('button',{name:'Купить номер'})).toBeNull();
    });
    it('never retries a stored purchase when the server disables purchasing',async()=>{
        sessionStorage.setItem('ava-telephony-purchase:7',JSON.stringify({key:'old-key',quote}));
        vi.mocked(api.getTelephony).mockResolvedValue(overview({canPurchase:false,pilotEnabled:false,numbers:[phone()]}));
        render(<TelephonyPanel businessId={7}/>);
        await screen.findByText(/Покупка новых номеров сейчас недоступна/);
        expect(screen.queryByRole('button',{name:'Купить номер'})).toBeNull();
        expect(screen.queryByRole('button',{name:'Проверить тот же заказ'})).toBeNull();
        expect(api.buyPhone).not.toHaveBeenCalled();
        expect(api.getPhoneCatalog).not.toHaveBeenCalled();
    });
    it('selects the first actual catalog type and explicitly confirms the complete first payment',async()=>{
        render(<TelephonyPanel businessId={7}/>);
        const confirm=await selectOffer();
        expect(api.findPhones).toHaveBeenCalledWith(7,1105,77,expect.any(AbortSignal));
        expect((screen.getByLabelText('Тип номера') as HTMLSelectElement).value).toBe('1105');
        expect(screen.getByText((_,element)=>element?.tagName==='STRONG' && element.textContent?.replace(/\s/g,' ')==='150,00 ₽')).toBeTruthy();
        expect(api.buyPhone).not.toHaveBeenCalled();
        fireEvent.click(confirm);fireEvent.click(confirm);
        await screen.findByText(/Заказ принят/);
        expect(api.buyPhone).toHaveBeenCalledTimes(1);
        expect(sessionStorage.getItem('ava-telephony-purchase:7')).toBeNull();
    });
    it('retries a lost purchase response with the same key after remount and expiry',async()=>{
        vi.mocked(api.buyPhone).mockRejectedValueOnce(new Error('network lost'));
        const view=render(<TelephonyPanel businessId={7}/>);
        fireEvent.click(await selectOffer());
        await screen.findByRole('button',{name:'Проверить тот же заказ'});
        const first=vi.mocked(api.buyPhone).mock.calls[0];
        expect(screen.queryByRole('button',{name:'Найти номера'})).toBeNull();
        view.unmount();
        const saved=JSON.parse(sessionStorage.getItem('ava-telephony-purchase:7')!);
        saved.quote.expiresAt=Date.now()-1;sessionStorage.setItem('ava-telephony-purchase:7',JSON.stringify(saved));
        render(<TelephonyPanel businessId={7}/>);
        fireEvent.click(await screen.findByRole('button',{name:'Проверить тот же заказ'}));
        await screen.findByText(/Заказ принят/);
        expect(vi.mocked(api.buyPhone).mock.calls[1].slice(0,3)).toEqual(first.slice(0,3));
    });
    it('prevents purchase when the selected quote expires',async()=>{
        quote.expiresAt=Date.now()+30000;
        render(<TelephonyPanel businessId={7}/>);
        const confirm=await selectOffer();
        vi.useFakeTimers();vi.setSystemTime(quote.expiresAt+1);
        fireEvent.click(confirm);
        expect(api.buyPhone).not.toHaveBeenCalled();
    });
    it('rejects offers without known prices',async()=>{
        vi.mocked(api.findPhones).mockResolvedValue(operation({result:{quotes:[{...quote,monthlyKopecks:undefined} as unknown as Quote]}}));
        render(<TelephonyPanel businessId={7}/>);
        fireEvent.click(await screen.findByRole('button',{name:'Купить номер'}));
        fireEvent.click(await screen.findByRole('button',{name:'Найти номера'}));
        await screen.findByText(/Подходящих номеров в этом регионе сейчас нет/);
        expect(screen.queryByRole('radio')).toBeNull();
    });
    it('returns to fresh search on a definitive price change',async()=>{
        vi.mocked(api.buyPhone).mockRejectedValue({response:{status:409,data:{code:'TELEPHONY_PRICE_CHANGED'}}});
        render(<TelephonyPanel businessId={7}/>);
        fireEvent.click(await selectOffer());
        await screen.findByText(/Стоимость изменилась/);
        expect(screen.queryByRole('button',{name:'Проверить тот же заказ'})).toBeNull();
        expect(sessionStorage.getItem('ava-telephony-purchase:7')).toBeNull();
        expect(api.buyPhone).toHaveBeenCalledTimes(1);
    });
    it('reports reconciliation and release errors distinctly, hiding canceled operations',async()=>{
        vi.mocked(api.getTelephony).mockResolvedValue(overview({orders:[
            operation({id:'purchase',kind:'purchase',state:'reconciling',stage:'buy_confirm'}),
            operation({id:'release',kind:'release',state:'failed',stage:'delete_number_confirm',errorCode:'TELEPHONY_OPERATION_FAILED'}),
            operation({id:'manual',kind:'purchase',state:'manual',stage:'sip_confirm'}),
            operation({id:'canceled',kind:'purchase',state:'canceled',stage:'locking'})]}));
        render(<TelephonyPanel businessId={7}/>);
        await screen.findByText(/Ожидаем подтверждения оператора; повторное действие не требуется/);
        expect(screen.getByText(/Отключение номера: Операция не завершена/)).toBeTruthy();
        expect(screen.queryByText(/Резервируем номер/)).toBeNull();
        expect(screen.getByText(/Операцию проверяет поддержка AVA/)).toBeTruthy();
    });
    it('changes primary, confirms release and allows canceling the grace period',async()=>{
        vi.stubGlobal('confirm',vi.fn(()=>false));
        vi.mocked(api.getTelephony).mockResolvedValue(overview({numbers:[phone(),phone({id:'p-2',number:'74950000002',state:'grace',releaseAt:Date.now()+700000})],notices:[{code:'TELEPHONY_RELEASE_WARNING',phoneId:'p-2'}]}));
        render(<TelephonyPanel businessId={7}/>);
        fireEvent.click(await screen.findByRole('button',{name:'Сделать основным'}));
        await waitFor(()=>expect(api.setPrimaryPhone).toHaveBeenCalledWith(7,'p-1',expect.any(AbortSignal)));
        await waitFor(()=>expect((screen.getByRole('button',{name:'Освободить через 7 дней'}) as HTMLButtonElement).disabled).toBe(false));
        fireEvent.click(screen.getByRole('button',{name:'Освободить через 7 дней'}));
        expect(api.releasePhone).not.toHaveBeenCalled();
        vi.mocked(window.confirm).mockReturnValue(true);
        fireEvent.click(screen.getByRole('button',{name:'Освободить через 7 дней'}));
        await waitFor(()=>expect(api.releasePhone).toHaveBeenCalledWith(7,'p-1',false,expect.any(AbortSignal)));
        await waitFor(()=>expect((screen.getByRole('button',{name:'Отменить отключение'}) as HTMLButtonElement).disabled).toBe(false));
        fireEvent.click(screen.getByRole('button',{name:'Отменить отключение'}));
        await waitFor(()=>expect(api.releasePhone).toHaveBeenCalledWith(7,'p-2',true,expect.any(AbortSignal)));
        expect(screen.getByText(/не больше трёх дней/)).toBeTruthy();
        expect(screen.getByText(/\(МСК\)/)).toBeTruthy();
    });
    it('discards old catalog responses and aborts them when business changes',async()=>{
        const old=deferred<Awaited<ReturnType<typeof api.getPhoneCatalog>>>();
        vi.mocked(api.getPhoneCatalog).mockReturnValueOnce(old.promise);
        const view=render(<TelephonyPanel businessId={7}/>);
        fireEvent.click(await screen.findByRole('button',{name:'Купить номер'}));
        const signal=vi.mocked(api.getPhoneCatalog).mock.calls[0][1]!;
        view.rerender(<TelephonyPanel businessId={8}/>);
        expect(signal.aborted).toBe(true);
        await act(async()=>old.resolve({types:[{type_id:1105,type_name:'Старый бизнес'}],regions:[{id:77,name:'Москва'}]}));
        expect(screen.queryByLabelText('Тип номера')).toBeNull();
        expect(await screen.findByRole('button',{name:'Купить номер'})).toBeTruthy();
    });
    it('discards an old overview arriving after a business switch',async()=>{
        const old=deferred<Telephony>();
        vi.mocked(api.getTelephony).mockReturnValueOnce(old.promise);
        const view=render(<TelephonyPanel businessId={7}/>);
        view.rerender(<TelephonyPanel businessId={8}/>);
        await screen.findByText(/Подключите номер, чтобы AVA принимала звонки/);
        await act(async()=>old.resolve(overview({numbers:[phone()]})));
        expect(screen.queryByText('+74950000001')).toBeNull();
    });
    it('polls a queued catalog and reports a bounded waiting state without duplicate requests',async()=>{
        vi.useFakeTimers();
        vi.mocked(api.getPhoneCatalog).mockResolvedValue({operation:operation({kind:'catalog',state:'pending'})});
        vi.mocked(api.getPhoneOperation).mockResolvedValue(operation({kind:'catalog',state:'pending'}));
        render(<TelephonyPanel businessId={7}/>);
        await act(async()=>{});
        fireEvent.click(screen.getByRole('button',{name:'Купить номер'}));
        await act(async()=>vi.advanceTimersByTimeAsync(70000));
        expect(screen.getByRole('alert').textContent).toContain('Проверка ещё выполняется');
        expect(api.getPhoneCatalog).toHaveBeenCalledTimes(1);
        expect(api.getPhoneOperation).toHaveBeenCalledTimes(45);
        expect((screen.getByRole('button',{name:'Купить номер'}) as HTMLButtonElement).disabled).toBe(false);
    });
    it('disables expired offers and the confirm button on the next clock tick',async()=>{
        vi.useFakeTimers();quote.expiresAt=Date.now()+2000;
        render(<TelephonyPanel businessId={7}/>);
        await act(async()=>{});
        fireEvent.click(screen.getByRole('button',{name:'Купить номер'}));await act(async()=>{});
        fireEvent.click(screen.getByRole('button',{name:'Найти номера'}));await act(async()=>{});
        fireEvent.click(screen.getByRole('radio'));
        await act(async()=>vi.advanceTimersByTimeAsync(3000));
        expect((screen.getByRole('radio') as HTMLInputElement).disabled).toBe(true);
        expect((screen.getByRole('button',{name:`Подтвердить покупку +${quote.number}`}) as HTMLButtonElement).disabled).toBe(true);
        expect(screen.getByText('Предложение истекло. Найдите номера заново.')).toBeTruthy();
    });
    it('does not expose an unresolved purchase from a different business',async()=>{
        const buy=deferred<Operation>();vi.mocked(api.buyPhone).mockReturnValueOnce(buy.promise);
        const view=render(<TelephonyPanel businessId={7}/>);
        fireEvent.click(await selectOffer());
        expect(sessionStorage.getItem('ava-telephony-purchase:7')).not.toBeNull();
        view.rerender(<TelephonyPanel businessId={8}/>);
        await screen.findByRole('button',{name:'Купить номер'});
        expect(screen.queryByRole('button',{name:'Проверить тот же заказ'})).toBeNull();
        expect(sessionStorage.getItem('ava-telephony-purchase:8')).toBeNull();
        await act(async()=>buy.resolve(operation({kind:'purchase'})));
        expect(screen.queryByText(/Заказ принят/)).toBeNull();
    });
    it('cleans polling timers and does not poll an operation after unmount',async()=>{
        vi.useFakeTimers();
        vi.mocked(api.getPhoneCatalog).mockResolvedValue({operation:operation({state:'pending'})});
        const view=render(<TelephonyPanel businessId={7}/>);
        await act(async()=>{});
        fireEvent.click(screen.getByRole('button',{name:'Купить номер'}));
        await act(async()=>{});
        view.unmount();
        await act(async()=>vi.advanceTimersByTimeAsync(10000));
        expect(api.getPhoneOperation).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });
    it('makes a failed initial load recoverable',async()=>{
        vi.mocked(api.getTelephony).mockRejectedValueOnce(new Error('network'));
        render(<TelephonyPanel businessId={7}/>);
        await screen.findByRole('alert');
        expect(screen.queryByText('Загружаем телефонию…')).toBeNull();
        fireEvent.click(screen.getByRole('button',{name:'Обновить состояние телефонии'}));
        await screen.findByRole('button',{name:'Купить номер'});
        expect(within(screen.getByRole('region',{name:'Телефония'})).getByText(/29 мин 50 сек/)).toBeTruthy();
    });
});
