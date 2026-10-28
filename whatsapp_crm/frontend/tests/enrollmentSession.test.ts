// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { enrollmentLoginUrl, saveEnrolledAccount, clearEnrolledAccount } from '../src/pages/public/enrollmentSession';
const user = '11111111-1111-4111-8111-111111111111';
afterEach(() => { sessionStorage.clear(); vi.useRealTimers(); });
describe('verified enrollment session', () => {
 it('keeps subject binding across reloads and clears it after login', () => {
  saveEnrolledAccount(user); expect(enrollmentLoginUrl()).toBe(`/api/auth/sso/start?enrolled_user=${user}`);
  clearEnrolledAccount(); expect(enrollmentLoginUrl()).toBe('');
 });
 it('expires the first-login binding after one hour', () => {
  vi.useFakeTimers(); saveEnrolledAccount(user); vi.advanceTimersByTime(3600001); expect(enrollmentLoginUrl()).toBe('');
 });
 it('ignores malformed IDs instead of creating unsafe redirects', () => {
  saveEnrolledAccount('javascript:alert(1)'); expect(enrollmentLoginUrl()).toBe('');
  sessionStorage.setItem('ava:public-enrolled-account', JSON.stringify({userId:'//attacker.test',at:Date.now()})); expect(enrollmentLoginUrl()).toBe('');
 });
});
