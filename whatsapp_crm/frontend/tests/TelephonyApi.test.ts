// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from 'vitest';
import { api } from '../src/api';
import { buyPhone, findPhones, getPhoneOperation, releasePhone, getExistingPhones, importExistingPhone, getManualPhones } from '../src/api/telephony';
vi.mock('../src/api',()=>({api:{get:vi.fn(),post:vi.fn(),put:vi.fn()}}));
beforeEach(()=>{vi.resetAllMocks();vi.mocked(api.post).mockResolvedValue({data:{operation:{id:'op'}}});vi.mocked(api.get).mockResolvedValue({data:{operation:{id:'op'}}});});
it('sends the exact reviewed quote and stable key on every retry with cancellation and a bounded timeout',async()=>{
    const signal=new AbortController().signal;
    await buyPhone(7,'quote-1','stable-key',signal);
    await buyPhone(7,'quote-1','stable-key',signal);
    expect(api.post).toHaveBeenNthCalledWith(1,'/businesses/7/telephony/orders',{quoteId:'quote-1'},
        {signal,timeout:15000,headers:{'Idempotency-Key':'stable-key'}});
    expect(vi.mocked(api.post).mock.calls[1]).toEqual(vi.mocked(api.post).mock.calls[0]);
});
it('scopes quote and operation requests to the business without changing the selected number type',async()=>{
    const signal=new AbortController().signal;
    await findPhones(7,1105,77,signal);await getPhoneOperation(8,'operation/1',signal);
    expect(api.post).toHaveBeenCalledWith('/businesses/7/telephony/quotes',{typeId:1105,regionId:77},{signal,timeout:15000});
    expect(api.get).toHaveBeenCalledWith('/businesses/8/telephony/orders/operation%2F1',{signal,timeout:15000});
});
it('addresses release and cancellation on the exact phone resource',async()=>{
    await releasePhone(7,'phone/1');await releasePhone(7,'phone/1',true);
    expect(api.post).toHaveBeenCalledWith('/businesses/7/telephony/numbers/phone%2F1/release',{},expect.objectContaining({timeout:15000}));
    expect(api.post).toHaveBeenCalledWith('/businesses/7/telephony/numbers/phone%2F1/cancel-release',{},expect.objectContaining({timeout:15000}));
});

it('uses actual business routes and the exact confirmed import with a stable key',async()=>{
    const signal=new AbortController().signal;
    await getExistingPhones(7,signal);
    await importExistingPhone(7,{number:'74950000009',mode:'inbound_only',confirmUnused:true},'import-key',signal);
    expect(api.get).toHaveBeenCalledWith('/businesses/7/telephony/existing',{signal,timeout:15000});
    expect(api.post).toHaveBeenCalledWith('/businesses/7/telephony/imports',{number:'74950000009',mode:'inbound_only',confirmUnused:true},
        {signal,timeout:15000,headers:{'Idempotency-Key':'import-key'}});
});
it('reads only phone-shaped manual values and does not return credentials',async()=>{
    vi.mocked(api.get).mockResolvedValue({data:{success:true,profile:{sipAliases:['74950000009','bad-alias',123],sipCallerId:'+74950000008',sipPassword:'secret'}}});
    expect(await getManualPhones(7)).toEqual({inboundNumbers:['74950000009'],outboundNumber:'+74950000008'});
    vi.mocked(api.get).mockResolvedValue({data:{success:false}});await expect(getManualPhones(7)).rejects.toThrow();
});
