// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import OutboundCampaigns from './OutboundCampaigns';
import { createCampaign, updateCampaignRetrySettings, listCampaigns, reconcileCampaign, commandCampaign } from '../api/outbound';
import { getTelephony } from '../api/telephony';
const shared=vi.hoisted(()=>({role:'hotel_owner'}));
vi.mock('../context/InstanceContext',()=>({useInstance:()=>({currentInstanceId:1,currentInstance:{name:'Business'}})}));
vi.mock('../context/AuthContext',()=>({useAuth:()=>({userId:'owner',permissionsLoading:false,memberships:[{businessId:1,role:shared.role,capabilities:['business.manage']}]})}));
vi.mock('../businessProfiles',()=>({getPipeline:()=>[]}));
vi.mock('../api/telephony',()=>({getTelephony:vi.fn(async()=>({managedMode:false,numbers:[]}))}));
vi.mock('../api/outbound',()=>({
 listCampaigns:vi.fn(async()=>({success:true,campaigns:[{campaignId:'campaign-one',businessId:1,name:'Existing',status:'draft',callWindow:{start:'09:00',end:'18:00'},timezone:'Europe/Moscow',maxAttempts:4,retryIntervalMinutes:15,retryBackoffMultiplier:2,counts:{pending:1},audienceSize:1,sourceNumberId:null,command:null}]})),
 previewCampaign:vi.fn(async()=>({success:true,importId:'preview-one',expiresAt:Date.now()+600000,counts:{accepted:1,invalid:0,duplicates:0,total:1},rows:[{phone:'79990000002',name:'Test'}],errors:[],duplicates:[]})),
 createCampaign:vi.fn(async()=>({success:true,campaign:{campaignId:'campaign-new',businessId:1,name:'New',counts:{pending:1},audienceSize:1}})),
 updateCampaignRetrySettings:vi.fn(async()=>({success:true,campaign:{campaignId:'campaign-one',businessId:1,name:'Existing',status:'draft',callWindow:{},maxAttempts:3,retryIntervalMinutes:20,counts:{pending:1},audienceSize:1,sourceNumberId:null,command:null}})),
 commandCampaign:vi.fn(),reconcileCampaign:vi.fn(),syncCrmCampaign:vi.fn(),
}));
const show=()=>render(<MemoryRouter><OutboundCampaigns/></MemoryRouter>);
beforeEach(()=>{vi.clearAllMocks();shared.role='hotel_owner';sessionStorage.clear();});
afterEach(()=>cleanup());
it('sends the selected attempt count and interval when creating a campaign',async()=>{
 show();fireEvent.click(await screen.findByRole('button',{name:'Новая кампания'}));
 fireEvent.change(screen.getByLabelText('Название кампании'),{target:{value:'New'}});
 fireEvent.change(screen.getByLabelText('Или вставьте CSV'),{target:{value:'phone;name\n79990000002;Test'}});
 fireEvent.click(screen.getByRole('button',{name:'Проверить контакты'}));
 await screen.findByText(/Готово к добавлению/);
 const form=within(screen.getByRole('region',{name:'Новая кампания'}));
 fireEvent.change(form.getByLabelText('Попыток на контакт'),{target:{value:'3'}});
 fireEvent.change(form.getByLabelText('Интервал между попытками, мин'),{target:{value:'0'}});
 expect(screen.getByRole('button',{name:'Сохранить черновик'}).hasAttribute('disabled')).toBe(true);
 fireEvent.change(form.getByLabelText('Интервал между попытками, мин'),{target:{value:'17'}});
 fireEvent.click(screen.getByRole('button',{name:'Сохранить черновик'}));
 await waitFor(()=>expect(createCampaign).toHaveBeenCalled());
 expect(vi.mocked(createCampaign).mock.calls[0][1]).toMatchObject({maxAttempts:3,retryIntervalMinutes:17});
});
it('keeps legacy backoff when only attempt count changes',async()=>{
 show();await screen.findByText('Existing');
 fireEvent.click(screen.getByText('Настроить повторные звонки'));
 fireEvent.change(screen.getByLabelText('Попыток на контакт'),{target:{value:'3'}});
 fireEvent.click(screen.getByRole('button',{name:'Сохранить повторы'}));
 await waitFor(()=>expect(updateCampaignRetrySettings).toHaveBeenCalled());
 expect(vi.mocked(updateCampaignRetrySettings).mock.calls[0][2]).toEqual({maxAttempts:3});
});
it('managers can read saved attempt settings without changing campaign policy',async()=>{
 shared.role='manager';show();await screen.findByText('Existing');
 expect(screen.getByText(/Попыток на контакт: 4/)).toBeTruthy();
 expect(screen.queryByText('Настроить повторные звонки')).toBeNull();
 expect(screen.queryByRole('button',{name:'Новая кампания'})).toBeNull();
});
it('refreshes stale running state to draft and restores Start without dispatching a call',async()=>{
 const campaign={campaignId:'campaign-stale',businessId:1,name:'Stale',status:'running',callWindow:{start:'09:00',end:'18:00'},timezone:'Europe/Moscow',maxAttempts:1,retryIntervalMinutes:1,retryBackoffMultiplier:1,counts:{pending:1},audienceSize:1,sourceNumberId:null,command:null};
 vi.mocked(listCampaigns).mockResolvedValueOnce({success:true,campaigns:[campaign]});
 vi.mocked(reconcileCampaign).mockResolvedValueOnce({success:true,campaign:{...campaign,status:'draft'},runtimeStateConfirmed:true});
 show();await screen.findByText('Stale');expect(screen.queryByRole('button',{name:'Запустить звонки'})).toBeNull();
 fireEvent.click(screen.getByRole('button',{name:'Проверить состояние'}));
 await screen.findByText('Состояние подтверждено.');expect(screen.getByRole('button',{name:'Запустить звонки'})).toBeTruthy();
 expect(reconcileCampaign).toHaveBeenCalledTimes(1);expect(commandCampaign).not.toHaveBeenCalled();
});
it('explains missing contacts and a legacy outgoing connection beside the blocked start',async()=>{
 vi.mocked(listCampaigns).mockResolvedValueOnce({success:true,campaigns:[{campaignId:'empty',businessId:1,name:'Empty',status:'draft',callWindow:{},timezone:'Europe/Moscow',maxAttempts:1,counts:{},audienceSize:0,audienceSource:'crm',sourceNumberId:null,command:null}]});
 vi.mocked(getTelephony).mockResolvedValueOnce({success:true,managedMode:false,numbers:[],connections:[],canManage:true,canPurchase:false,pilotEnabled:false,balanceReady:false,orders:[],remainingSeconds:0,limits:{numbers:0,dailySeconds:0},notices:[]});
 show();await screen.findByText('Empty');
 expect(screen.getByText('Нет контактов для звонка. Обновите список клиентов.')).toBeTruthy();
 expect(screen.getByRole('link',{name:'Открыть телефонию'}).getAttribute('href')).toBe('/channels?channel=telephony');
 expect(screen.getByRole('button',{name:'Запустить звонки'}).getAttribute('aria-describedby')).toBe('campaign-audience-empty');
 expect(screen.getByRole('button',{name:'Запустить звонки'}).hasAttribute('disabled')).toBe(true);
 expect(commandCampaign).not.toHaveBeenCalled();
});
