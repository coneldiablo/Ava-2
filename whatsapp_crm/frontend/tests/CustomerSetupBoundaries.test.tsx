// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import CustomerSetup from '../src/pages/CustomerSetup';

const state = vi.hoisted(() => ({ updated: {} as Record<string, unknown> }));
vi.mock('../src/context/AuthContext', () => ({ useAuth: () => ({ authenticated:true,userId:'owner',loginName:'owner',role:'customer',memberships:[{businessId:7,role:'hotel_owner',capabilities:['business.read','business.manage']}] }) }));
vi.mock('../src/context/InstanceContext', () => ({ useInstance: () => ({ currentInstanceId:7,refreshInstances:async()=>{} }) }));
vi.mock('../src/context/OnboardingContext', () => ({ useOnboarding: () => ({showGuide:false}) }));
vi.mock('../src/components/AiModelSettings', () => ({default:()=>null}));
vi.mock('../src/components/VoiceSettings', () => ({default:()=>null}));
vi.mock('../src/api/telephony', () => ({getTelephony:async()=>({managedMode:true})}));
// Exercise the real parent callback with a confirmed canonical approval result.
// AI/provider requests are outside this narrow reconciliation regression.
vi.mock('../src/pages/AssistantBuilder', () => ({AssistantDraftEditor:({onProfileSaved}:{onProfileSaved:(profile:Record<string,unknown>,fields:string[])=>void})=><button onClick={()=>onProfileSaved(state.updated,['systemPrompt'])}>Подтвердить полученные инструкции</button>}));

const old = {businessId:7,name:'Бизнес',hotelTimezone:'UTC',hotelTone:'Вежливо',hotelWorkingHours:{},systemPrompt:'Старый текст',voiceGreetingTemplate:'Здравствуйте'};
let resolveRead!:(value:Response)=>void;
beforeEach(()=>{
    state.updated={...old,systemPrompt:'Новый подтверждённый текст'};
    vi.stubGlobal('requestAnimationFrame',(fn:FrameRequestCallback)=>{fn(0);return 1;});
    HTMLElement.prototype.scrollIntoView=vi.fn();
    vi.stubGlobal('fetch',vi.fn(()=>new Promise<Response>(resolve=>{resolveRead=resolve;})));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

it('never lets a pre-approval profile read undo the confirmed inline instructions',async()=>{
    render(<MemoryRouter initialEntries={['/integrations#business-autoprompt']}><CustomerSetup/></MemoryRouter>);
    await waitFor(()=>expect(fetch).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole('button',{name:'Подтвердить полученные инструкции'}));
    expect((screen.getByLabelText('Инструкции для ответов клиентам') as HTMLTextAreaElement).value).toBe('Новый подтверждённый текст');
    await act(async()=>resolveRead({ok:true,json:async()=>({success:true,profile:old})} as Response));
    expect((screen.getByLabelText('Инструкции для ответов клиентам') as HTMLTextAreaElement).value).toBe('Новый подтверждённый текст');
    expect(screen.getByText('Инструкции сохранены.')).toBeTruthy();
});
