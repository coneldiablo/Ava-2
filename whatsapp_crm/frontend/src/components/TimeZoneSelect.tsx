type Zone = readonly [string, string];
const russianZones: readonly Zone[] = [
    ['Europe/Kaliningrad', 'Калининград (МСК −1)'],
    ['Europe/Moscow', 'Москва, Санкт-Петербург (МСК)'],
    ['Europe/Samara', 'Самара, Ижевск (МСК +1)'],
    ['Asia/Yekaterinburg', 'Екатеринбург, Пермь (МСК +2)'],
    ['Asia/Omsk', 'Омск (МСК +3)'],
    ['Asia/Krasnoyarsk', 'Красноярск, Новосибирск (МСК +4)'],
    ['Asia/Irkutsk', 'Иркутск (МСК +5)'],
    ['Asia/Yakutsk', 'Якутск, Чита (МСК +6)'],
    ['Asia/Vladivostok', 'Владивосток, Хабаровск (МСК +7)'],
    ['Asia/Magadan', 'Магадан, Южно-Сахалинск (МСК +8)'],
    ['Asia/Kamchatka', 'Камчатка, Анадырь (МСК +9)'],
];
const otherZones: readonly Zone[] = [
    ['Europe/Minsk', 'Минск'], ['Europe/Kyiv', 'Киев'], ['Asia/Almaty', 'Алматы'],
    ['Asia/Tashkent', 'Ташкент'], ['Asia/Bishkek', 'Бишкек'], ['Asia/Yerevan', 'Ереван'],
    ['Asia/Baku', 'Баку'], ['Asia/Tbilisi', 'Тбилиси'], ['Asia/Dubai', 'Дубай'],
    ['Europe/Istanbul', 'Стамбул'], ['Europe/Berlin', 'Берлин'], ['Europe/Paris', 'Париж'],
    ['Europe/London', 'Лондон'], ['Asia/Bangkok', 'Бангкок'], ['Asia/Singapore', 'Сингапур'],
    ['Asia/Shanghai', 'Пекин, Шанхай'], ['Asia/Tokyo', 'Токио'],
    ['America/New_York', 'Нью-Йорк'], ['America/Los_Angeles', 'Лос-Анджелес'],
    ['UTC', 'Всемирное время (Гринвич)'],
];

export function timeZoneLabel(value: string): string {
    const known = [...russianZones, ...otherZones].find(([zone]) => zone === value);
    if (known) return known[1];
    try {
        const name = new Intl.DateTimeFormat('ru-RU', { timeZone: value, timeZoneName: 'long' })
            .formatToParts(new Date()).find(part => part.type === 'timeZoneName')?.value;
        return name || value;
    } catch { return `Сохранённый пояс (${value})`; }
}

export default function TimeZoneSelect({ id, value, onChange, disabled = false, label = 'Часовой пояс', className = 'input min-h-[44px]' }: {
    id: string; value?: string; onChange: (value: string) => void; disabled?: boolean; label?: string; className?: string;
}) {
    const selected = value || '';
    const known = [...russianZones, ...otherZones].some(([zone]) => zone === selected);
    // A saved IANA zone outside the suggestions remains selected and round-trips unchanged.
    return <label htmlFor={id}><span className="label">{label}</span>
        <select id={id} name={id} value={selected} disabled={disabled} required className={className} onChange={event => onChange(event.target.value)}>
            {!selected && <option value="" disabled>Выберите город</option>}
            {selected && !known && <option value={selected}>{timeZoneLabel(selected)}</option>}
            <optgroup label="Россия">{russianZones.map(([zone, title]) => <option key={zone} value={zone}>{title}</option>)}</optgroup>
            <optgroup label="Другие страны">{otherZones.map(([zone, title]) => <option key={zone} value={zone}>{title}</option>)}</optgroup>
        </select>
    </label>;
}
