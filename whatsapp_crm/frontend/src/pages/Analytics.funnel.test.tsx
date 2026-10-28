// @vitest-environment jsdom
import { afterEach, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { SankeyFunnel, MessagesChart } from './Analytics';

afterEach(cleanup);
const labels = { new: 'Новые', qualified: 'Квалификация' };
const draw = (total: number, advanced: number) => render(<SankeyFunnel statuses={['new', 'qualified']} labels={labels}
    data={{ pipeline: { new: total, qualified: advanced }, transitions: [], bottleneck: null,
        holes: [{ from: 'new', to: 'qualified', totalFromStatus: total, advancedCount: advanced, dropRate: total ? (total - advanced) / total * 100 : 0 }] }} />);

it('shows no percentage when no transitions were observed', () => {
    draw(0, 0);
    expect(screen.getByRole('img').textContent).toContain('—');
    expect(screen.queryByText('100%')).toBeNull();
    expect(screen.queryByText('0%')).toBeNull();
});
it('distinguishes observed zero conversion from missing observations', () => {
    draw(4, 0); expect(screen.getByText('0%')).toBeTruthy();
});
it('retains percentages backed by observed transitions', () => {
    draw(4, 2); expect(screen.getByText('50%')).toBeTruthy();
});


it('keeps an integer message axis unambiguous when there is only one message', () => {
    const view = render(<MessagesChart data={[{date:'2026-10-24',incoming:1,outgoing:0,total:1}]} />);
    const ticks = [...view.container.querySelectorAll('svg text')].map(node => node.textContent).filter(text => /^\d+$/.test(text || ''));
    expect(ticks.length).toBe(new Set(ticks).size);
    expect(view.container.querySelector('.analytics-message-legend')?.textContent).toContain('Входящие');
    expect(view.container.querySelector('.analytics-message-legend')?.textContent).toContain('Исходящие');
});
