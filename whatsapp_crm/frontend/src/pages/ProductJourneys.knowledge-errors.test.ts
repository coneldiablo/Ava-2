import {describe,expect,it} from 'vitest';
import {customerKnowledgeUploadError} from './KnowledgeBase';
describe('knowledge upload errors describe validation and preserve uncertain upload outcomes',()=>{
 it('explains an empty source without suggesting a broken connection',()=>{const message=customerKnowledgeUploadError({response:{status:400,data:{results:[{code:'KNOWLEDGE_TEXT_EMPTY'}]}}});expect(message).toMatch(/нет текста/);expect(message).not.toMatch(/соединение/);});
 it('offers the short-note path for short non-text documents',()=>{expect(customerKnowledgeUploadError({response:{status:400,data:{results:[{code:'KNOWLEDGE_DOCUMENT_TOO_SHORT'}]}}})).toMatch(/Добавить текст/);});
 it('does not display arbitrary backend errors or sensitive payloads',()=>{expect(customerKnowledgeUploadError({response:{status:400,data:{results:[{error:'SECRET_SERVER_DETAIL'}]}}})).toBe('Файл не принят. Проверьте его содержимое и формат и повторите загрузку.');});
 it('asks for readback when an upload outcome was not confirmed',()=>{expect(customerKnowledgeUploadError(new Error('Network Error'))).toMatch(/Обновите список документов/);});
 it('shows the actual size limit for a rejected large file',()=>{expect(customerKnowledgeUploadError({response:{status:413}})).toMatch(/20 МБ/);});
});
