// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import AmbientSettings from '../src/components/AmbientSettings';
const setting={enabled:true,preset:'office',volume:1};
let stored: null | typeof setting;
let available=true;
let wrongReadback=false;
const fetchMock=vi.fn();
beforeEach(()=>{stored=null;available=true;wrongReadback=false;fetchMock.mockReset();vi.stubGlobal('fetch',fetchMock);fetchMock.mockImplementation(async (input,options)=>{
 const path=String(input);if(path.endsWith('/voice-options'))return {ok:true,json:async()=>({success:true,ambientAudio:{available,presets:[{id:'office',label:'Офис'}],previewAvailable:true,effective:setting}})};
 if(options?.method==='PUT'){stored=JSON.parse(options.body).voiceAmbient;return {ok:true,json:async()=>({success:true})};}
 return {ok:true,json:async()=>({success:true,profile:{businessId:wrongReadback?8:7,voiceAmbient:stored}})};
});});
afterEach(()=>{cleanup();vi.unstubAllGlobals();});
describe('per-business ambient sound',()=>{
 it('shows legacy effective state then saves a scoped explicit override and verifies readback',async()=>{
  render(<AmbientSettings businessId={7} canRead canEdit/>);const toggle=await screen.findByLabelText('Добавить фон офиса');expect((toggle as HTMLInputElement).checked).toBe(true);
  fireEvent.change(screen.getByLabelText(/Громкость фона/),{target:{value:'0.4'}});fireEvent.click(screen.getByRole('button',{name:'Сохранить фон'}));
  expect(await screen.findByText(/Фон сохранён/)).toBeTruthy();expect(stored).toEqual({enabled:true,preset:'office',volume:0.4});
  const mutation=fetchMock.mock.calls.find(([,options])=>options?.method==='PUT');expect(String(mutation?.[0])).toBe('/api/hotel-profiles/7');expect(JSON.parse(mutation?.[1].body)).toEqual({voiceAmbient:stored});
 });
 it('does not confirm a save when readback belongs to another business and keeps edits',async()=>{
  render(<AmbientSettings businessId={7} canRead canEdit/>);fireEvent.click(await screen.findByLabelText('Добавить фон офиса'));wrongReadback=true;fireEvent.click(screen.getByRole('button',{name:'Сохранить фон'}));
  await screen.findByRole('alert');expect(screen.queryByText(/Фон сохранён/)).toBeNull();expect((screen.getByLabelText('Добавить фон офиса') as HTMLInputElement).checked).toBe(false);
 });
 it('allows disabling a legacy background even when the sound asset becomes unavailable',async()=>{
  available=false;render(<AmbientSettings businessId={7} canRead canEdit/>);const toggle=await screen.findByLabelText('Добавить фон офиса');expect((toggle as HTMLInputElement).disabled).toBe(false);fireEvent.click(toggle);fireEvent.click(screen.getByRole('button',{name:'Сохранить фон'}));await screen.findByText(/Фон сохранён/);expect(stored?.enabled).toBe(false);
 });
 it('keeps read-only roles from changing ambient settings',async()=>{
  render(<AmbientSettings businessId={7} canRead canEdit={false}/>);await screen.findByLabelText('Добавить фон офиса');expect((screen.getByLabelText('Добавить фон офиса') as HTMLInputElement).closest('fieldset')?.disabled).toBe(true);expect(fetchMock.mock.calls.some(([,options])=>options?.method==='PUT')).toBe(false);
 });
});
