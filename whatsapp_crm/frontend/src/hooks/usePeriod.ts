import { useSearchParams } from 'react-router-dom';
export type PeriodDays = 7 | 30 | 90;
export function usePeriod(): [PeriodDays, (days: number) => void] {
    const [params, setParams] = useSearchParams();
    const requested = Number(params.get('days'));
    const days = ([7, 30, 90].includes(requested) ? requested : 30) as PeriodDays;
    return [days, value => setParams(previous => { const next = new URLSearchParams(previous); next.set('days', String([7, 30, 90].includes(value) ? value : 30)); return next; }, { replace: true })];
}
