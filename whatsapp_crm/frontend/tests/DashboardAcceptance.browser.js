// Paste this file into Safari Web Inspector as a snippet, or load it on a local
// Vite candidate with: await import('/tests/DashboardAcceptance.browser.js')
// It reads the current authenticated page and only clicks period controls.
(() => {
    const assert = (condition, message) => { if (!condition) throw new Error(message); };
    const visible = element => !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
    const text = element => (element?.textContent || '').replace(/\s+/g, ' ').trim();
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    function inspect({ businessName, forbiddenText = [] } = {}) {
        assert(document.querySelectorAll('main').length === 1,
            'Dashboard must use the existing Layout main landmark');
        const main = document.querySelector('main') || document.body;
        const heading = [...main.querySelectorAll('h1')].find(node => /главная/i.test(text(node)));
        assert(heading && visible(heading), 'Главная must have a visible h1');
        const pageText = text(main);
        if (businessName) assert(pageText.includes(businessName), `Selected business ${businessName} is absent`);
        for (const value of forbiddenText) {
            assert(!pageText.includes(value), `Foreign or demo text remains visible: ${value}`);
        }
        assert(!/Priority Score\s*92\s*\/\s*100|Сегодня 3 сделки готовы/i.test(pageText),
            'Prototype values are still rendered');
        const requiredRoutes = ['/conversations', '/leads', '/deals', '/channels', '/team'];
        for (const route of requiredRoutes) {
            const link = [...main.querySelectorAll('a[href]')].find(node =>
                new URL(node.href, location.href).pathname === route && visible(node));
            assert(link, `Visible navigation to ${route} is missing`);
        }
        assert(![...main.querySelectorAll('a[href]')].some(node => visible(node)
            && ['#', 'javascript:void(0)'].includes(node.getAttribute('href'))),
        'A visible action is a dead link');
        const alerts = [...main.querySelectorAll('[role="alert"]')].filter(visible).map(text);
        const statuses = [...main.querySelectorAll('[role="status"]')].filter(visible).map(text);
        return { title: text(heading), businessName: businessName || null,
            alerts, statuses, checkedRoutes: requiredRoutes, checkedAt: new Date().toISOString() };
    }

    function periodButton(days) {
        const pattern = new RegExp(`(^|\\D)${days}(?:\\s*(?:д|day)|\\D|$)`, 'i');
        return [...document.querySelectorAll('button, [role="tab"]')]
            .find(node => visible(node) && pattern.test(text(node)));
    }

    async function exercisePeriods() {
        const originalFetch = window.fetch;
        const originalOpen = XMLHttpRequest.prototype.open;
        const seen = [];
        window.fetch = function(input, init) {
            seen.push(String(typeof input === 'string' ? input : input.url));
            return originalFetch.call(this, input, init);
        };
        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
            seen.push(String(url));
            return originalOpen.call(this, method, url, ...rest);
        };
        try {
            let selectedBusinessId = null;
            for (const days of [7, 30, 90]) {
                const button = periodButton(days);
                assert(button, `${days}-day period control is missing`);
                seen.length = 0;
                button.click();
                for (let attempt = 0; attempt < 25; attempt++) {
                    if (seen.some(url => /\/dashboard\/\d+\/metrics/.test(url))) break;
                    await sleep(200);
                }
                const calls = seen.filter(url => /\/dashboard\/\d+\/metrics/.test(url));
                assert(calls.length, `Selecting ${days} days did not request dashboard metrics`);
                const request = new URL(calls.at(-1), location.href);
                assert(request.searchParams.get('days') === String(days),
                    `${days}-day control requested a different period`);
                const businessId = request.pathname.match(/\/dashboard\/(\d+)\/metrics/)?.[1];
                assert(businessId, 'Metrics request lacks a business ID');
                if (selectedBusinessId) assert(businessId === selectedBusinessId,
                    'Period selection unexpectedly changed the selected business');
                selectedBusinessId = businessId;
            }
            return { businessId: selectedBusinessId, checkedPeriods: [7, 30, 90] };
        } finally {
            window.fetch = originalFetch;
            XMLHttpRequest.prototype.open = originalOpen;
        }
    }

    window.DashboardAcceptance = { inspect, exercisePeriods };
})();
