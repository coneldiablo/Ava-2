/** AVA module mark; inherits the existing theme without adding styles. */
export default function AvaMark({ size = 24 }: { size?: number }) {
    return <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
        strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
        <path d="m6 16 6-12 6 12M9 11h6M6 20h12" />
        <circle cx="4" cy="20" r="2" /><circle cx="20" cy="20" r="2" />
    </svg>;
}
