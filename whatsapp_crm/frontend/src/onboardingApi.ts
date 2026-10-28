export const onboardingSteps = ['business', 'voice', 'knowledge', 'channels', 'review'] as const;
export type OnboardingStep = typeof onboardingSteps[number];
export type OnboardingState = {
    businessId: number;
    status: 'pending' | 'completed';
    confirmedSteps: OnboardingStep[];
    completedAt: string | null;
};

export async function onboardingRequest(businessId: number, action = '', signal?: AbortSignal): Promise<OnboardingState> {
    const response = await fetch(`/api/businesses/${businessId}/onboarding${action}`, {
        method: action ? 'POST' : 'GET', credentials: 'same-origin', signal,
        ...(action ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}),
    });
    if (response.status === 401) window.dispatchEvent(new Event('crm:unauthorized'));
    if (response.status === 403) window.dispatchEvent(new Event('crm:forbidden'));
    if (!response.ok) throw new Error('ONBOARDING_UNAVAILABLE');
    const result = await response.json();
    const state = result?.onboarding;
    if (result?.success !== true || state?.businessId !== businessId
        || !['pending', 'completed'].includes(state.status) || !Array.isArray(state.confirmedSteps)
        || state.confirmedSteps.some((step: unknown) => !onboardingSteps.includes(step as OnboardingStep))
        || new Set(state.confirmedSteps).size !== state.confirmedSteps.length
        || (state.status === 'completed' && (state.confirmedSteps.length !== onboardingSteps.length || typeof state.completedAt !== 'string'))
        || (state.status === 'pending' && state.completedAt !== null)) throw new Error('ONBOARDING_INVALID_RESPONSE');
    return state;
}
