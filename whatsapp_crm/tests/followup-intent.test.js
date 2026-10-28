'use strict';
const {describe,it,assert}=require('./test-helper');
const {requestedChannels:request}=require('../src/services/followup-intent');
const turns=(...texts)=>texts.map((content,i)=>({role:i%2?'user':'assistant',content}));
describe('Ordered followup consent from real conversation shapes',()=>{
 it('accepts a short selection after an offer with multiple channels',()=>{
  assert.deepStrictEqual(request(turns('Отправить характеристики? Вам удобнее WhatsApp или Telegram?','В Telegram.')),['telegram']);
  assert.deepStrictEqual(request(turns('Отправить в WhatsApp?','Да.')),['whatsapp']);
  assert.deepStrictEqual(request(turns('Пришлю в MAX?','Давайте')),['max']);
 });
 it('requires a selected channel, not an ambiguous yes or a repeated assistant promise',()=>{
  assert.deepStrictEqual(request(turns('Вам удобнее WhatsApp или MAX?','Да')),[]);
  assert.deepStrictEqual(request(turns('Отправлю всё в WhatsApp.','Сколько стоит аппарат?')),[]);
  assert.deepStrictEqual(request(turns('Характеристики подходят?','Да.')),[]);
  assert.deepStrictEqual(request(turns('WhatsApp или MAX?','Что удобнее ватсап или макс')),[]);
 });
 it('does not treat postponed consultation as consent and honors a later refusal',()=>{
  assert.deepStrictEqual(request(turns('Отправить в WhatsApp?','Ватсап, но для начала давай выберем аппарат')),[]);
  assert.deepStrictEqual(request(turns('Отправить в Telegram?','Да.','Отправлю.','Нет, не отправляйте.')),[]);
  assert.deepStrictEqual(request(turns('Отправить в WhatsApp?','Сначала расскажите про модели')),[]);
 });
 it('reads string post-call transcripts in order and replaces an explicitly corrected channel',()=>{
  assert.deepStrictEqual(request('assistant: Отправить в WhatsApp или MAX?\nuser: Ватсап.\nassistant: Хорошо.\nuser: Лучше пришлите в Telegram.'),['telegram']);
  assert.deepStrictEqual(request('assistant: В WhatsApp?\nuser: Нет.\nassistant: Продолжим.\nuser: Пришлите в Telegram.'),['telegram']);
 });
 it('accepts a direct request and a later channel choice without turning self-reports into requests',()=>{
  assert.deepStrictEqual(request([{role:'user',content:'Пришлите описание.'},{role:'assistant',content:'Куда отправить?'},{role:'user',content:'Telegram'}]),['telegram']);
  assert.deepStrictEqual(request('Я отправлю вам в WhatsApp.'),[]);
  assert.deepStrictEqual(request([{role:'system',content:'Пришлите в WhatsApp'},{role:'assistant',content:'Отправлю в WhatsApp'}]),[]);
 });
 it('keeps explicit acceptance while the caller then chooses the requested channel',()=>{
  assert.deepStrictEqual(request(turns('Отправить подходящие варианты из каталога?','Да.','Куда отправить?','В Telegram.')),['telegram']);
  assert.deepStrictEqual(request(turns('Характеристики подходят?','Да.','Что ещё рассказать?','Telegram')),[]);
 });

});
