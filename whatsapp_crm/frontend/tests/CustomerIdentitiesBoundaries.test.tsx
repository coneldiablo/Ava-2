// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import CustomerIdentities from '../src/pages/CustomerIdentities';
const access=vi.hoisted(()=>({role:'manager',userId:'m1',can:()=>true}));
vi.mock('../src/permissions',()=>({useBusinessAccess:()=>access}));
const linked=vi.fn();let writes:Record<string,unknown>[];
beforeEach(()=>{
    writes=[];linked.mockReset();
    vi.stubGlobal('fetch',vi.fn(async(input:RequestInfo|URL,options?:RequestInit)=>{
        const url=String(input);let data:unknown={success:true,aliases:[]};
        if(options?.method==='POST'){writes.push(JSON.parse(String(options.body)));data={success:true,canonicalChatId:'caller',aliases:[{id:1,...writes.at(-1)}]};}
        else if(url==='/api/clients/7')data={success:true,clients:[
            {instanceId:7,chatId:'email_existing',senderName:'Почтовый диалог',emailAddress:'Guest@EXAMPLE.test'},
            {instanceId:7,chatId:'vk_123',senderName:'Диалог ВКонтакте',vkUserId:'123'},
            {instanceId:7,chatId:'max_456',senderName:'Диалог MAX',maxUserId:'456'},
            {instanceId:8,chatId:'email_foreign',senderName:'Чужой бизнес',emailAddress:'foreign@example.test'},
        ]};
        return {ok:true,status:200,json:async()=>data} as Response;
    }));
});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});

it.each([['email','guest@example.test','Почтовый диалог'],['vk','123','Диалог ВКонтакте'],['max','user:456','Диалог MAX']])('binds the confirmed existing %s contact for an assigned manager',async(kind,value,name)=>{
    render(<CustomerIdentities instanceId={7} chatId="caller" assigneeUserId="m1" onLinked={linked}/>);
    fireEvent.change(screen.getByRole('combobox',{name:'Канал'}),{target:{value:kind}});
    await screen.findByRole('option',{name:new RegExp(name)});
    expect(screen.queryByRole('option',{name:/Чужой бизнес/})).toBeNull();
    fireEvent.change(screen.getByRole('combobox',{name:'Диалог клиента'}),{target:{value}});
    fireEvent.click(screen.getByRole('button',{name:'Привязать контакт'}));
    expect(writes).toHaveLength(0);
    expect(screen.getByRole('region',{name:'Проверка контакта перед привязкой'})).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox',{name:'Я проверил контакт и подтверждаю, что он принадлежит этому клиенту'}));
    fireEvent.click(screen.getByRole('button',{name:'Подтвердить привязку'}));
    await waitFor(()=>expect(linked).toHaveBeenCalledTimes(1));
    expect(writes).toEqual([{kind,value}]);
    expect(vi.mocked(fetch).mock.calls.find(([,options])=>options?.method==='POST')?.[0]).toBe('/api/clients/7/caller/identities');
});

it('never offers contact writes to a manager assigned to a different customer',async()=>{
    render(<CustomerIdentities instanceId={7} chatId="caller" assigneeUserId="another-manager" onLinked={linked}/>);
    await waitFor(()=>expect(fetch).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('combobox',{name:'Канал'})).toBeNull();
    expect(screen.queryByRole('button',{name:'Привязать контакт'})).toBeNull();
    expect(writes).toHaveLength(0);
});
