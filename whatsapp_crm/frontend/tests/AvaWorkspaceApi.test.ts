// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { workspaceRequest, searchWorkspace, getStudioHandoff } from '../src/avaWorkspace';
import { api } from '../src/api';
vi.mock('../src/api',()=>({api:{request:vi.fn()}}));
beforeEach(()=>vi.clearAllMocks());
describe('AVA API tenant result validation',()=>{
 it('rejects successful data of a different business',async()=>{vi.mocked(api.request).mockResolvedValueOnce({data:{success:true,businessId:8}});await expect(workspaceRequest(7,'/workspace')).rejects.toMatchObject({code:'WORKSPACE_RESPONSE_INVALID'});});
 it('bounded search path encodes quotes and tenant ID',async()=>{vi.mocked(api.request).mockResolvedValueOnce({data:{success:true,businessId:7,results:[]}});await searchWorkspace(7,'hello " OR *');expect(api.request).toHaveBeenCalledWith(expect.objectContaining({url:'/businesses/7/search?q=hello%20%22%20OR%20*&limit=20',method:'get',timeout:15000}));});
});

describe('Studio handoff validation', () => {
 const handoff = () => ({ success: true, businessId: 7, dealId: 'deal/1', material: { revision: 2, text: 'Сохранённый материал' }, composer: { businessId: 7, chatId: 'card1', text: 'Сохранённый материал', materialRevision: 2, requiresHumanConfirmation: true } });
 it('Studio fetch uses the exact encoded deal, version and abort signal', async () => {
  const signal = new AbortController().signal;
  vi.mocked(api.request).mockResolvedValueOnce({ data: handoff() });
  await getStudioHandoff(7, 'deal/1', 2, 'card1', signal);
  expect(api.request).toHaveBeenCalledWith(expect.objectContaining({ url: '/businesses/7/studio/proposals/deal%2F1/handoff?revision=2', method: 'get', signal, timeout: 15000 }));
 });
 it.each(['tenant', 'composer-tenant', 'customer', 'deal', 'material-version', 'composer-version', 'confirmation', 'text'])('Studio rejects mismatched %s without accepting the material', async mismatch => {
  const value = handoff();
  if (mismatch === 'tenant') value.businessId = 8;
  if (mismatch === 'composer-tenant') value.composer.businessId = 8;
  if (mismatch === 'customer') value.composer.chatId = 'card2';
  if (mismatch === 'deal') value.dealId = 'other';
  if (mismatch === 'material-version') value.material.revision = 3;
  if (mismatch === 'composer-version') value.composer.materialRevision = 3;
  if (mismatch === 'confirmation') value.composer.requiresHumanConfirmation = false;
  if (mismatch === 'text') value.composer.text = 'Другой материал';
  vi.mocked(api.request).mockResolvedValueOnce({ data: value });
  await expect(getStudioHandoff(7, 'deal/1', 2, 'card1')).rejects.toMatchObject({ code: 'WORKSPACE_RESPONSE_INVALID' });
 });
});
