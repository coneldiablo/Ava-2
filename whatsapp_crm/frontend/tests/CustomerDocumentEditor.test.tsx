// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import CustomerDocumentEditor from '../src/components/knowledge/CustomerDocumentEditor';
import { getCustomerKnowledgeChunks, updateCustomerKnowledgeChunk } from '../src/api';
vi.mock('../src/api', () => ({ getCustomerKnowledgeChunks: vi.fn(), updateCustomerKnowledgeChunk: vi.fn() }));
const data = (text='Сохранённый текст') => ({ success: true as const, businessId: 7, documentId: 2, chunks: [{ id: 3, text, section: null }] });
const onSaved=vi.fn(), onClose=vi.fn();
const show=()=>render(<CustomerDocumentEditor businessId={7} documentId={2} name="Условия.txt" onSaved={onSaved} onClose={onClose}/>);
afterEach(cleanup);
beforeEach(()=>{vi.resetAllMocks();vi.mocked(getCustomerKnowledgeChunks).mockResolvedValue(data());vi.mocked(updateCustomerKnowledgeChunk).mockResolvedValue({success:true,businessId:7,documentId:2});});
describe('CustomerDocumentEditor',()=>{
 it('confirms save only after scoped GET readback',async()=>{
  show();fireEvent.change(await screen.findByLabelText('Текст документа'),{target:{value:'Новое условие'}});vi.mocked(getCustomerKnowledgeChunks).mockResolvedValue(data('Новое условие'));
  fireEvent.click(screen.getByRole('button',{name:'Сохранить текст'}));await screen.findByText(/Текст сохранён/);expect(onSaved).toHaveBeenCalledOnce();expect(updateCustomerKnowledgeChunk).toHaveBeenCalledWith(7,2,3,{text:'Новое условие',section:null},expect.any(AbortSignal));
 });
 it('preserves input after network failure and supports retry',async()=>{
  show();const input=await screen.findByLabelText('Текст документа');fireEvent.change(input,{target:{value:'Важное изменение'}});vi.mocked(updateCustomerKnowledgeChunk).mockRejectedValueOnce(new Error('offline'));
  fireEvent.click(screen.getByRole('button',{name:'Сохранить текст'}));await screen.findByRole('alert');expect((input as HTMLTextAreaElement).value).toBe('Важное изменение');expect(onSaved).not.toHaveBeenCalled();
  vi.mocked(getCustomerKnowledgeChunks).mockResolvedValue(data('Важное изменение'));fireEvent.click(screen.getByRole('button',{name:'Сохранить текст'}));await screen.findByText(/Текст сохранён/);
 });
 it('rejects differing readback',async()=>{
  show();fireEvent.change(await screen.findByLabelText('Текст документа'),{target:{value:'Новая редакция'}});fireEvent.click(screen.getByRole('button',{name:'Сохранить текст'}));await screen.findByRole('alert');expect(onSaved).not.toHaveBeenCalled();expect((screen.getByLabelText('Текст документа') as HTMLTextAreaElement).value).toBe('Новая редакция');
 });
 it('blocks duplicate submit while saving',async()=>{
  vi.mocked(updateCustomerKnowledgeChunk).mockImplementation(()=>new Promise(()=>{}));show();await screen.findByLabelText('Текст документа');const form=screen.getByRole('button',{name:'Сохранить текст'}).closest('form')!;fireEvent.submit(form);fireEvent.submit(form);
  await waitFor(()=>expect(updateCustomerKnowledgeChunk).toHaveBeenCalledOnce());expect(screen.getByRole('button',{name:'Закрыть редактор'}).hasAttribute('disabled')).toBe(true);
 });
 it('retries load and aborts on unmount',async()=>{
  vi.mocked(getCustomerKnowledgeChunks).mockRejectedValueOnce(new Error('offline'));const view=show();await screen.findByRole('alert');fireEvent.click(screen.getByRole('button',{name:'Повторить загрузку текста'}));await screen.findByLabelText('Текст документа');const signal=vi.mocked(getCustomerKnowledgeChunks).mock.calls.at(-1)![2]!;view.unmount();expect(signal.aborted).toBe(true);
 });
 it('passes the server hash and blocks overwrite after a conflict',async()=>{
  vi.mocked(getCustomerKnowledgeChunks).mockResolvedValue({...data(),hash:'a'.repeat(64)});
  vi.mocked(updateCustomerKnowledgeChunk).mockRejectedValue({response:{data:{code:'DOCUMENT_REVISION_CONFLICT'}}});
  show();fireEvent.change(await screen.findByLabelText('Текст документа'),{target:{value:'Мои правки'}});fireEvent.click(screen.getByRole('button',{name:'Сохранить текст'}));
  await screen.findByText(/Документ уже изменил другой сотрудник/);expect(updateCustomerKnowledgeChunk).toHaveBeenCalledWith(7,2,3,{text:'Мои правки',section:null,expectedHash:'a'.repeat(64)},expect.any(AbortSignal));
  expect((screen.getByLabelText('Текст документа') as HTMLTextAreaElement).value).toBe('Мои правки');expect(screen.getByRole('button',{name:'Сохранить текст'}).hasAttribute('disabled')).toBe(true);
 });

});
