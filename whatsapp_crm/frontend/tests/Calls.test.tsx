// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Calls from '../src/pages/Calls';

const scope=vi.hoisted(()=>({businessId:1,admin:true}));
vi.mock('../src/permissions', () => ({ useBusinessAccess: () => ({ userId: 'viewer', role: 'observer', isPlatformAdmin: scope.admin }) }));
vi.mock('../src/context/InstanceContext', () => ({ useInstance: () => ({
    currentInstanceId: scope.businessId, currentInstance: { id: scope.businessId, name: 'Тестовый бизнес' },
}) }));

afterEach(() => { cleanup(); scope.admin=true; vi.unstubAllGlobals(); });

describe('Customer call history', () => {
    it('shows the client name and readable outcome, with diagnostics collapsed', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true, status: 200,
            json: async () => ({ success: true, business_id: 1, total: 1, total_pages: 1,
                calls: [{ id: 'record-1', call_id: 'technical-call-id', business_id: 1,
                    caller_name: 'Гость', caller_number: '+79990000000', direction: 'inbound',
                    outcome: 'abandoned', start_time: '2026-09-29T10:00:00Z', duration_seconds: 7,
                    provider_name: 'internal-provider' }] }),
        }));
        render(<MemoryRouter><Calls /></MemoryRouter>);
        expect(await screen.findByText('Гость')).toBeTruthy();
        expect(screen.getByText('+7 (999) 000-00-00')).toBeTruthy();
        expect(screen.getByText('Звонок прервался')).toBeTruthy();
        expect(screen.queryByText('abandoned')).toBeNull();
        const details = screen.getByText('Сведения о звонке').closest('details');
        expect(details?.open).toBe(false);
        fireEvent.click(screen.getByText('Сведения о звонке'));
        expect(details?.open).toBe(true);
        expect(screen.getByText('ID: technical-call-id')).toBeTruthy();
    });
    it('keeps service diagnostics out of the customer call view', async () => {
        scope.businessId=1; scope.admin=false;
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok:true, json:async()=>({success:true,business_id:1,calls:[{id:'record',business_id:1,caller_name:'Гость',call_id:'private-diagnostic',provider_name:'internal'}]}) }));
        render(<MemoryRouter><Calls /></MemoryRouter>);
        await screen.findByText('Гость');
        expect(screen.queryByText('Сведения о звонке')).toBeNull();
        expect(screen.queryByText(/private-diagnostic/)).toBeNull();
    });
    it('plays only the protected same-business recording URL and reports unavailable media',async()=>{
        scope.businessId=1;
        vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({success:true,business_id:1,calls:[
            {id:'record-1',business_id:1,caller_name:'Гость',recording_url:'/api/calls/1/record-1/recording.wav'},
            {id:'foreign',business_id:1,recording_url:'/api/calls/2/foreign/recording.wav'},
            {id:'remote',business_id:1,recording_url:'https://provider.example/secret.wav'},
            {id:'missing',business_id:1,recording_file:'ava-1-missing.wav'}
        ]})}));
        const {container}=render(<MemoryRouter><Calls/></MemoryRouter>);
        const player=await screen.findByLabelText('Запись звонка Гость');
        expect(player.getAttribute('src')).toBe('/api/calls/1/record-1/recording.wav');
        expect(player.getAttribute('preload')).toBe('none');expect(player.hasAttribute('autoplay')).toBe(false);
        expect(container.querySelectorAll('audio')).toHaveLength(1);
        fireEvent.error(player);expect(screen.getByRole('status').textContent).toContain('Запись пока недоступна');
        fireEvent.click(screen.getByRole('button',{name:'Обновить'}));
        const retry=screen.getByLabelText('Запись звонка Гость');
        expect(retry).not.toBe(player);expect(retry.getAttribute('preload')).toBe('none');
        expect(screen.queryByText(/Запись пока недоступна/)).toBeNull();
    });
    it('removes the old player immediately on business change and discards a late history response',async()=>{
        scope.businessId=1;
        let resolve!:(value:unknown)=>void;
        const fetchMock=vi.fn().mockResolvedValueOnce({ok:true,json:async()=>({success:true,business_id:1,calls:[{id:'old',business_id:1,recording_url:'/api/calls/1/old/recording.wav'}]})})
            .mockReturnValueOnce(new Promise(r=>{resolve=r;}))
            .mockResolvedValue({ok:true,json:async()=>({success:true,business_id:2,calls:[]})});
        vi.stubGlobal('fetch',fetchMock);
        const view=render(<MemoryRouter><Calls/></MemoryRouter>);
        await screen.findByLabelText('Запись звонка old');
        fireEvent.click(screen.getByRole('button',{name:'Обновить'}));
        const oldSignal=fetchMock.mock.calls[1][1].signal;
        scope.businessId=2;view.rerender(<MemoryRouter><Calls/></MemoryRouter>);
        expect(view.container.querySelector('audio')).toBeNull();expect(oldSignal.aborted).toBe(true);
        await act(async()=>resolve({ok:true,json:async()=>({success:true,business_id:1,calls:[{id:'late',business_id:1,recording_url:'/api/calls/1/late/recording.wav'}]})}));
        expect(view.container.querySelector('audio')).toBeNull();scope.businessId=1;
    });

});
