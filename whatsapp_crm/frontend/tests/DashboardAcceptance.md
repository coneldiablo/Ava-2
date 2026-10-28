# Safari dashboard acceptance helper

Run against the candidate in Safari after customer login. In Web Inspector, load `DashboardAcceptance.browser.js` as a snippet and run:

```js
DashboardAcceptance.inspect({ businessName: 'Business A', forbiddenText: ['Business B private marker'] })
await DashboardAcceptance.exercisePeriods()
```

The period helper clicks only 7/30/90 controls and checks the authenticated metrics request URL. Re-run `inspect` after manually switching businesses; use a unique B-only marker in `forbiddenText` when A is selected, and vice versa. Record screenshots and network response statuses separately. The helper does not prove the displayed numbers equal the server payload, does not perform task mutations, and cannot prove a live WhatsApp/Instagram connection. Verify those with the customer journey in `docs/dashboard-command-center-acceptance.md`.
