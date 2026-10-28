// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import CustomerSetup from '../src/pages/CustomerSetup';

vi.mock('../src/context/AuthContext', () => ({useAuth:()=>({authenticated:true,userId:'owner',loginName:'owner',role:'customer',memberships:[{businessId:7,role:'hotel_owner',capabilities:['business.read','business.manage']}]})}));
vi.mock('../src/context/InstanceContext', () => ({useInstance:()=>({currentInstanceId:7,refreshInstances:async()=>{}})}));
vi.mock('../src/context/OnboardingContext', () => ({useOnboarding:()=>({showGuide:false})}));
vi.mock('../src/components/AiModelSettings', () => ({default:()=>null}));
vi.mock('../src/components/VoiceSettings', () => ({default:()=>null}));
vi.mock('../src/api/telephony', () => ({getTelephony:async()=>({managedMode:true})}));
const initial={businessId:7,name:'Бизнес',hotelTimezone:'UTC',hotelTone:'Вежливо',hotelWorkingHours:{},systemPrompt:'Старый текст',voiceGreetingTemplate:'Здравствуйте',outboundOpenerTemplate:''};
const draft={id:'draft',status:'draft',links:[],supplement:'Бизнес',systemPrompt:'Новый подтверждённый текст',sources:[]};
let profile:Record<string,unknown>,writes:{url:string;body:Record<string,unknown>}[],pause:(()=>void)|null,held:'manual'|'approval';
const response=(data:unknown)=>({ok:true,json:async()=>structuredClone(data)} as Response);
beforeEach(()=>{
    profile={...initial};writes=[];pause=null;sessionStorage.clear();
    vi.stubGlobal('requestAnimationFrame',(fn:FrameRequestCallback)=>{fn(0);return 1;});HTMLElement.prototype.scrollIntoView=vi.fn();
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,options?:RequestInit)=>{
        const url=String(input);
        if(url.endsWith('/onboarding/preparation'))return response({success:true,businessId:7,preparation:{businessId:7,revision:0,links:[],supplement:''}});
        if(url.endsWith('/assistant-draft'))return response({success:true,businessId:7,draft});
        if(options?.method==='PUT'||url.endsWith('/assistant-draft/approve')){
            const body=JSON.parse(String(options?.body));writes.push({url,body});
            const approval=url.endsWith('/approve');
            if((approval&&held==='approval')||(!approval&&held==='manual'))await new Promise<void>(resolve=>{pause=resolve;});
            profile={...profile,...(approval?{systemPrompt:body.systemPrompt,...body.settings}:body)};
            return response({success:true,businessId:7,profile,...(approval?{draft:{...draft,status:'approved',systemPrompt:body.systemPrompt}}:{})});
        }
        return response({success:true,profile});
    }));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

it.each(['manual','approval'] as const)('serializes %s-first writes between profile and embedded prompt editor',async first=>{
    held=first;
    render(<MemoryRouter initialEntries={['/integrations#business-autoprompt']}><CustomerSetup/></MemoryRouter>);
    await screen.findByLabelText('Инструкции ассистента');
    const manual=screen.getByLabelText('Инструкции для ответов клиентам');
    fireEvent.change(manual,{target:{value:'Несохранённый ручной текст'}});
    const save=screen.getByRole('button',{name:'Сохранить настройки'}),approve=screen.getByRole('button',{name:'Подтвердить и сохранить'});
    fireEvent.click(first==='manual'?save:approve);
    await waitFor(()=>expect(writes).toHaveLength(1));
    fireEvent.click(first==='manual'?approve:save);
    expect(writes).toHaveLength(1);
    await act(async()=>{pause!();});
    if(first==='manual'){
        await screen.findByText('Настройки сохранены. Они применятся к новым разговорам.');
        fireEvent.click(screen.getByRole('button',{name:'Подтвердить и сохранить'}));
        await waitFor(()=>expect(writes).toHaveLength(2));
    }
    await waitFor(()=>expect(profile.systemPrompt).toBe('Новый подтверждённый текст'));
    await waitFor(()=>expect((screen.getByLabelText('Инструкции для ответов клиентам') as HTMLTextAreaElement).value).toBe('Новый подтверждённый текст'));
    expect(writes.filter(write=>write.url.endsWith('/approve'))).toHaveLength(1);
    expect(writes.filter(write=>!write.url.endsWith('/approve'))).toHaveLength(first==='manual'?1:0);
});

it('still loads the parent settings after an early inline approval fails',async()=>{
    const fetchMock=vi.mocked(fetch),normal=fetchMock.getMockImplementation()!;
    let finishRead!:(value:Response)=>void;
    fetchMock.mockImplementation(async(input,options)=>{
        const url=String(input);
        if(url==='/api/hotel-profiles/7'&&!options?.method)return new Promise<Response>(resolve=>{finishRead=resolve;});
        if(url.endsWith('/assistant-draft/approve'))return {ok:false,json:async()=>({success:false})} as Response;
        return normal(input,options);
    });
    render(<MemoryRouter initialEntries={['/integrations#business-autoprompt']}><CustomerSetup/></MemoryRouter>);
    await screen.findByLabelText('Инструкции ассистента');
    expect(screen.queryByLabelText('Инструкции для ответов клиентам')).toBeNull();
    fireEvent.click(screen.getByRole('button',{name:'Подтвердить и сохранить'}));
    await screen.findByText(/Сохранение не подтверждено. Ваш текст остался в форме/);
    await act(async()=>finishRead(response({success:true,profile:initial})));
    expect((await screen.findByLabelText('Инструкции для ответов клиентам') as HTMLTextAreaElement).value).toBe('Старый текст');
});
