// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import TimeZoneSelect from './TimeZoneSelect';

afterEach(cleanup);
it('shows Russian city choices, sends the canonical zone and respects disabled state', () => {
    const change = vi.fn();
    const view = render(<TimeZoneSelect id="zone" value="UTC" onChange={change} />);
    const select = screen.getByRole('combobox', { name: 'Часовой пояс' }) as HTMLSelectElement;
    expect(select.value).toBe('UTC');
    expect(screen.getByRole('option', { name: 'Москва, Санкт-Петербург (МСК)' })).toBeTruthy();
    fireEvent.change(select, { target: { value: 'Europe/Moscow' } });
    expect(change).toHaveBeenCalledWith('Europe/Moscow');
    view.rerender(<TimeZoneSelect id="zone" value="Europe/Moscow" disabled onChange={change} />);
    expect(select.disabled).toBe(true);
});
it('preserves a saved zone outside suggestions rather than silently selecting Moscow', () => {
    render(<TimeZoneSelect id="zone" value="Pacific/Auckland" onChange={vi.fn()} />);
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('Pacific/Auckland');
    expect(select.selectedOptions[0].textContent).toMatch(/новозеланд|Нов[а-я]* Зеланди[а-я]*/i);
});
