// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import Conversations from './Conversations';
import QuickReplies from './QuickReplies';
import Studio from './Studio';
import Activity from './Activity';
import { clearWorkspaceDrafts } from '../hooks/useScopedDraft';

const shared=vi.hoisted(()=>({businessId:7,role:'hotel_owner',assignee:'user-1',templates:vi.fn(),send:vi.fn(),clients:vi.fn()}));
const caps=['business.read','business.manage','sales.read','sales.write','messages.send','ai.use'];
vi.mock('../context/AuthContext',()=>({useAuth:()=>({authenticated:true,role:'customer',userId:'user-1',loginName:'fixture',permissionsLoading:false,
    memberships:[7,8].map(businessId=>({businessId,role:shared.role,capabilities:shared.role==='observer'?['business.read','sales.read']:caps}))})}));
vi.mock('../context/InstanceContext',()=>({useInstance:()=>({currentInstanceId:shared.businessId,currentInstance:{id:shared.businessId,name:'Тестовый бизнес'}})}));
vi.mock('../components/CommercialDocuments',()=>({default:()=>null}));
vi.mock('../api',()=>({getClients:(...args:unknown[])=>shared.clients(...args),getMessages:async()=>({success:true,messages:[]}),
    getTemplates:(...args:unknown[])=>shared.templates(...args),sendMessageToClient:(...args:unknown[])=>shared.send(...args),
    getAiNextStep:vi.fn(),getAiSummary:vi.fn(),createTemplate:vi.fn(),deleteTemplate:vi.fn()}));
const client=(businessId=7)=>({id:1,instanceId:businessId,chatId:'fixture-chat',assigneeUserId:shared.assignee,senderName:'Анна Сценарий',leadStatus:'new',lastMessage:'Здравствуйте',lastMessageTime:new Date().toISOString(),channels:['whatsapp']});
const template=(businessId=7,text='Проверенный шаблон')=>({id:5,instanceId:businessId,label:'Приветствие',text});
function Location(){const value=useLocation();return <output data-testid="location">{value.pathname+value.search}</output>;}
const mount=(component:React.ReactNode,url='/conversations?chat=fixture-chat')=>render(<MemoryRouter initialEntries={[url]}>{component}<Location/></MemoryRouter>);

describe('product journeys — exact component actions, no provider delivery claim',()=>{
    beforeEach(()=>{
        shared.businessId=7;shared.role='hotel_owner';shared.assignee='user-1';shared.templates.mockReset();shared.send.mockReset();shared.clients.mockReset();
        shared.templates.mockImplementation(async businessId=>({success:true,templates:[template(businessId)]}));
        shared.clients.mockImplementation(async businessId=>({success:true,clients:[client(businessId)]}));shared.send.mockResolvedValue({success:true});
        clearWorkspaceDrafts();sessionStorage.clear();
        vi.stubGlobal('requestAnimationFrame',(callback:FrameRequestCallback)=>{callback(0);return 1;});
        Element.prototype.scrollIntoView=vi.fn();
        vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,status:200,json:async()=>({success:true,business_id:shared.businessId,deals:[]})})));
    });
    afterEach(()=>{cleanup();clearWorkspaceDrafts();vi.unstubAllGlobals();});
    it('quick reply targets a compatible dialogue route and includes both client aliases plus business scope',async()=>{
        mount(<QuickReplies/>,'/quick-replies?client=fixture-chat');
        const link=await screen.findByRole('link',{name:/Вставить в разговор/});const url=new URL(link.getAttribute('href')!,'http://localhost');
        expect(url.pathname).toBe('/conversations');expect(url.searchParams.get('chat')).toBe('fixture-chat');expect(url.searchParams.get('client')).toBe('fixture-chat');
        expect(url.searchParams.get('businessId')).toBe('7');expect(url.searchParams.get('template')).toBe('5');
    });
    it('legacy composer inserts once, preserves existing scoped text, URL and refresh draft, never sends automatically',async()=>{
        const first=mount(<Conversations/>);const draft=await screen.findByLabelText('Ваш ответ');fireEvent.change(draft,{target:{value:'Мой черновик'}});first.unmount();
        const second=mount(<Conversations/>,'/conversations?client=fixture-chat&chat=fixture-chat&template=5&businessId=7&q=keep');
        await waitFor(()=>expect((screen.getByLabelText('Ваш ответ') as HTMLTextAreaElement).value).toBe('Мой черновик\nПроверенный шаблон'));
        const path=screen.getByTestId('location').textContent!;expect(path).toContain('chat=fixture-chat');expect(path).toContain('q=keep');await waitFor(()=>expect(screen.getByTestId('location').textContent).not.toContain('template='));
        expect(shared.send).not.toHaveBeenCalled();second.unmount();mount(<Conversations/>,path);
        expect((await screen.findByLabelText('Ваш ответ') as HTMLTextAreaElement).value).toBe('Мой черновик\nПроверенный шаблон');expect(shared.send).not.toHaveBeenCalled();
    });
    it('without a selected recipient waits for the client choice and then inserts into that dialogue only',async()=>{
        mount(<Conversations/>,'/conversations?template=5&businessId=7');await screen.findByRole('heading',{name:'Выберите диалог'});
        expect(screen.queryByLabelText('Ваш ответ')).toBeNull();fireEvent.click(await screen.findByRole('button',{name:/Анна Сценарий/}));
        await waitFor(()=>expect((screen.getByLabelText('Ваш ответ') as HTMLTextAreaElement).value).toBe('Проверенный шаблон'));
        expect(screen.getByTestId('location').textContent).toContain('chat=fixture-chat');expect(shared.send).not.toHaveBeenCalled();
    });
    it('manager cannot insert or send into another managers dialogue',async()=>{
        shared.role='manager';shared.assignee='other-user';mount(<Conversations/>,'/conversations?chat=fixture-chat&template=5&businessId=7');
        await screen.findByText('У вас нет права отвечать в этом диалоге. Шаблон не вставлен.');expect(screen.queryByLabelText('Ваш ответ')).toBeNull();
        expect(shared.templates).not.toHaveBeenCalled();expect(shared.send).not.toHaveBeenCalled();expect(screen.getByTestId('location').textContent).toContain('template=5');
    });
    it('foreign business URL retains an error and never inserts even an identically numbered template',async()=>{
        mount(<Conversations/>,'/conversations?chat=fixture-chat&template=5&businessId=8');await screen.findByText(/Этот шаблон относится к другому бизнесу/);
        expect((await screen.findByLabelText('Ваш ответ') as HTMLTextAreaElement).value).toBe('');expect(shared.send).not.toHaveBeenCalled();
    });
    it('foreign API template data is rejected and explicit retry can load the current business template',async()=>{
        shared.templates.mockResolvedValueOnce({success:true,templates:[template(8,'Чужой текст')]});mount(<Conversations/>,'/conversations?chat=fixture-chat&template=5&businessId=7');
        fireEvent.click(await screen.findByRole('button',{name:'Повторить загрузку шаблонов'}));
        await waitFor(()=>expect((screen.getByLabelText('Ваш ответ') as HTMLTextAreaElement).value).toBe('Проверенный шаблон'));
        expect(screen.queryByText('Чужой текст')).toBeNull();expect(shared.send).not.toHaveBeenCalled();
    });
    it('late template response after business switch cannot populate another business draft',async()=>{
        let finish!:(value:unknown)=>void;shared.templates.mockImplementation(businessId=>businessId===7?new Promise(resolve=>{finish=resolve;}):Promise.resolve({success:true,templates:[template(8)]}));
        const view=mount(<Conversations/>,'/conversations?chat=fixture-chat&template=5&businessId=7');await waitFor(()=>expect(shared.templates).toHaveBeenCalledWith(7));
        shared.businessId=8;view.rerender(<MemoryRouter><Conversations/><Location/></MemoryRouter>);
        await act(async()=>finish({success:true,templates:[template(7,'Просроченный чужой ответ')]}));
        await screen.findByText(/Этот шаблон относится к другому бизнесу/);expect((await screen.findByLabelText('Ваш ответ') as HTMLTextAreaElement).value).toBe('');
        expect(shared.send).not.toHaveBeenCalled();
    });
    it('Studio manager sees only accessible tool destinations',async()=>{
        shared.role='manager';mount(<Studio/>,'/studio');expect(screen.getByRole('heading',{name:'Предложения и документы',level:1})).toBeTruthy();expect(screen.queryByRole('link',{name:/Отчёты по CRM/})).toBeNull();
        expect(screen.getByRole('link',{name:/Знания бизнеса/}).getAttribute('href')).toBe('/knowledge-base');expect(screen.getByRole('link',{name:/Быстрые ответы/}).getAttribute('href')).toBe('/quick-replies');
    });
    it.each(['manager','observer'])('Activity %s has useful accessible destinations without a denied analytics link',async role=>{
        shared.role=role;mount(<Activity/>,'/activity');
        expect(screen.queryByRole('link',{name:/^Аналитика$/})).toBeNull();
        expect(screen.getByRole('link',{name:'Журнал звонков'}).getAttribute('href')).toBe('/calls');
        expect(screen.getByRole('link',{name:'Диалоги'}).getAttribute('href')).toBe('/conversations');
    });
    it('Activity owner retains analytics',async()=>{
        mount(<Activity/>,'/activity');expect(screen.getByRole('link',{name:/^Аналитика$/}).getAttribute('href')).toBe('/analytics');
    });
    it('Studio owner keeps the existing analytics link',async()=>{
        mount(<Studio/>,'/studio');expect(screen.getByRole('link',{name:/Отчёты по CRM/}).getAttribute('href')).toBe('/analytics');
    });
});
