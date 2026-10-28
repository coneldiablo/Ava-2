# AVA workspace

North star: open the right customer, understand the current state, complete the next action.

This is a dense CRM for owners, sales teams and platform operators. Keep the existing neutral Geist/Lucide language. The screen's protagonist is the work, rather than decorative images or navigation cards. Existing routes, records and business permissions are constraints.

## Applied rules

- **better-layout**: one primary task, related views in section navigation; 8px within a group and at least 16px between groups; wrap at 320px rather than shrink text. Sales retains separate deal stages and client stages.
- **better-writing**: one object name throughout a flow. An error names the failed action and recovery. Remove repeated instructions. The assistant answers business questions; knowledge preview and simulator test configuration.
- **better-typography**: 26/24px page titles, 18px sections, 14px UI body, 13px metadata. Unitless line heights, a 70ch description cap, tabular changing figures. Inputs are at least 16px on mobile.
- **better-colors**: reuse semantic colors in index.css. Neutral surfaces, one filled primary action, status labels alongside colors. Measure actual rendered pairs before claiming contrast conformance.
- **better-accessibility**: native links for navigation and buttons for actions, visible focus, route title and main focus, disclosures with visible cues, no inaccessible hidden editor. Dynamic recovery uses status/alert roles.
- **better-ui**: 10px controls and 18px surfaces in shared chrome. Only color/background feedback on frequent tabs; no motion with reduced-motion preference. Media uses one component across all inbox/history surfaces.
- **oil-ui / modern-web-design**: preserve the established direction, remove repeated explanations and competing sections. Build the representative shared navigation/header first, then verify each rendered view. Business content needs native HTML rather than generated raster assets.

## Shared implementation

ProductUi.css owns the shared spacing, type, radius and motion roles. PageHeader owns page titles and actions. SectionNavigation groups sales/results/automation and retains existing deep links. MediaAttachment owns preview/retry/error states. WorkspaceUi owns loading/error/retry feedback. Do not create another copy of these in a page.

## Data and states

SQLite timestamps without offsets represent UTC. API customer history returns ISO UTC; the UI uses the business hotelTimezone, default Europe/Moscow. Result periods use days=7/30/90 in the URL and survive view changes and reload.

Drafts remain after failure. Permission refresh can disable writes without losing mounted input. Platform operators use their supported inbox/directory; business-only workspaces require a membership. Instagram status is connected only after a fresh inbound Direct is saved. Manual control in a customer card takes priority over autonomous replies.

## Acceptance

Use actual React + API + isolated SQLite journeys for local behavior; external model/channel boundaries are fixtures. Inspect desktop and narrow screenshots and keyboard focus. Local checks do not prove provider login, delivery or a production release. The audit evidence and remaining external dependencies live in docs/ava-product-audit-20261024.
