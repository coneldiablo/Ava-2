/** @type {import('tailwindcss').Config} */
export default {
    content: [
        "./index.html",
        "./src/**/*.{js,ts,jsx,tsx}",
    ],
    theme: {
        extend: {
            colors: {
                'neu-base': '#f2f2f2',
                'neu-surface': '#ffffff',
                'neu-surface-1': '#ffffff',
                'neu-surface-2': '#ececec',
                'neu-surface-3': '#d9d9d9',
                'accent': '#111111',
                'accent-hover': '#2f2f2f',
                'accent-2': '#666666',
                'neu-text': '#111111',
                'neu-muted': '#838282',
                'neu-dim': '#666666',
            },
            borderRadius: {
                'neu': '16px',
                'neu-sm': '12px',
                'neu-lg': '20px',
                'neu-xl': '24px',
            },
            boxShadow: {
                'neu-raised': '0 24px 60px rgba(17,17,17,0.08)',
                'neu-raised-sm': '0 10px 24px rgba(17,17,17,0.08)',
                'neu-raised-lg': '0 32px 80px rgba(17,17,17,0.10)',
                'neu-inset': 'inset 0 0 0 1px rgba(17,17,17,0.08)',
                'neu-inset-sm': 'inset 0 0 0 1px rgba(17,17,17,0.10)',
                'neu-hover': '0 28px 70px rgba(17,17,17,0.12)',
                'neu-pressed': 'inset 0 0 0 1px rgba(17,17,17,0.18)',
                'accent-glow': '0 0 0 6px rgba(17,17,17,0.08)',
            },
            fontFamily: {
                sans: ['Satoshi', 'Inter', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
                satoshi: ['Satoshi', 'Inter', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
                'clash-display': ['Clash Display', 'Inter', 'sans-serif'],
            },
        },
    },
    plugins: [],
}
