// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {cleanup,fireEvent,render,screen,waitFor} from '@testing-library/react';
import CustomerNameEditor from '../src/components/CustomerNameEditor';
import {renameSalesClient} from '../src/api';
vi.mock('../src/api',()=>({renameSalesClient:vi.fn()}));
afterEach(()=>{cleanup();vi.clearAllMocks();});
function show(canEdit=true,onSaved=vi.fn()) {return render(<CustomerNameEditor businessId={4} chatId="avito:202:chat~one" name="Клиент Авито" heading="h2" canEdit={canEdit} onSaved={onSaved}/>);}
describe('customer name editing',()=>{
    it('saves the exact scoped customer, updates the heading and restores focus',async()=>{
        const done=vi.fn();vi.mocked(renameSalesClient).mockResolvedValue({success:true,businessId:4,client:{chatId:'avito:202:chat~one',name:'Анна'}});
        show(true,done);const trigger=screen.getByRole('button',{name:'Изменить имя'});fireEvent.click(trigger);
        expect(screen.getByLabelText('Имя клиента')).toBe(document.activeElement);
        fireEvent.change(screen.getByLabelText('Имя клиента'),{target:{value:' Анна '}});fireEvent.click(screen.getByRole('button',{name:'Сохранить имя'}));
        await screen.findByRole('heading',{name:'Анна'});expect(screen.getByRole('status').textContent).toBe('Имя сохранено.');expect(done).toHaveBeenCalledWith('Анна');expect(document.activeElement).toBe(trigger);
        expect(renameSalesClient).toHaveBeenCalledWith(4,'avito:202:chat~one','Анна','Клиент Авито',expect.any(AbortSignal));
    });
    it('retains a failed draft, announces recovery and rejects a response for another customer',async()=>{
        const done=vi.fn();vi.mocked(renameSalesClient).mockRejectedValueOnce({response:{data:{code:'SALES_CLIENT_NAME_CHANGED'}}}).mockResolvedValueOnce({success:true,businessId:9,client:{chatId:'other',name:'Анна'}});
        show(true,done);fireEvent.click(screen.getByText('Изменить имя'));fireEvent.change(screen.getByLabelText('Имя клиента'),{target:{value:'Анна'}});fireEvent.click(screen.getByText('Сохранить имя'));
        await screen.findByText('Имя уже изменили. Обновите карточку и повторите изменение.');expect(screen.getByLabelText('Имя клиента')).toHaveProperty('value','Анна');
        fireEvent.click(screen.getByText('Сохранить имя'));await screen.findByText('Не удалось сохранить имя. Проверьте соединение и повторите попытку.');expect(done).not.toHaveBeenCalled();expect(screen.getByRole('heading').textContent).toBe('Клиент Авито');
    });
    it('validates empty input and supports Escape without saving',()=>{
        show();const trigger=screen.getByText('Изменить имя');fireEvent.click(trigger);fireEvent.change(screen.getByLabelText('Имя клиента'),{target:{value:'   '}});fireEvent.click(screen.getByText('Сохранить имя'));
        expect(screen.getByRole('alert').textContent).toContain('Введите имя');expect(renameSalesClient).not.toHaveBeenCalled();
        fireEvent.keyDown(screen.getByLabelText('Имя клиента'),{key:'Escape'});expect(screen.queryByLabelText('Имя клиента')).toBeNull();expect(document.activeElement).toBe(trigger);
    });
    it('hides editing without customer permissions and aborts an unmounted request',async()=>{
        const readOnly=show(false);expect(screen.queryByText('Изменить имя')).toBeNull();readOnly.unmount();
        let signal:AbortSignal|undefined;vi.mocked(renameSalesClient).mockImplementation((_id,_chat,_name,_old,s)=>{signal=s;return new Promise(()=>{});});
        const active=show();fireEvent.click(screen.getByText('Изменить имя'));fireEvent.change(screen.getByLabelText('Имя клиента'),{target:{value:'Анна'}});fireEvent.click(screen.getByText('Сохранить имя'));await waitFor(()=>expect(signal).toBeTruthy());active.unmount();expect(signal!.aborted).toBe(true);
    });
});
