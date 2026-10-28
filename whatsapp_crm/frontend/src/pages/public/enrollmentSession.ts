// Persist the verified account binding, never its password or one-time code.
const key = 'ava:public-enrolled-account';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function enrollmentLoginUrl(): string {
    try {
        const value = JSON.parse(sessionStorage.getItem(key) || 'null');
        if (value && typeof value.userId === 'string' && uuid.test(value.userId) && Number.isFinite(value.at) && Date.now() - value.at < 3600000 && value.at <= Date.now()) {
            return `/api/auth/sso/start?enrolled_user=${encodeURIComponent(value.userId)}`;
        }
    } catch { /* Storage is optional. */ }
    return '';
}
export function saveEnrolledAccount(userId: string) {
    try { if (uuid.test(userId)) sessionStorage.setItem(key, JSON.stringify({userId,at:Date.now()})); } catch { /* Storage is optional. */ }
}
export function clearEnrolledAccount() { try { sessionStorage.removeItem(key); } catch { /* Storage is optional. */ } }
