import { describe, it, expect } from 'vitest';
import {channelLabel,messageChannelLabels} from '../src/channelNames';
describe('Existing router channel labels',()=>{
 it('labels Avito and Instagram consistently for messages and preferred-channel filters',()=>{
  expect(messageChannelLabels.avito).toBe('Авито');expect(messageChannelLabels.instagram).toBe('Instagram');
  expect(channelLabel('AVITO')).toBe('Авито');expect(channelLabel('instagram')).toBe('Instagram');
 });
 it('keeps calls and unknown channels readable without exposing provider codes',()=>{
  expect(channelLabel('voice')).toBe('Звонок');expect(channelLabel('sip')).toBe('Звонок');expect(channelLabel('unrecognized_provider')).toBe('Другой канал');expect(channelLabel(null)).toBe('Канал не указан');
 });
});
