# React Bits: FadeContent

Adapted from the official TypeScript/default FadeContent implementation by David Haz:
https://github.com/DavidHDev/react-bits/blob/4aa93d3bc1048730c9673c266047abb094b5d8c0/src/ts-default/Animations/FadeContent/FadeContent.tsx

Source retrieved 2026-09-30. The pinned revision uses React and IntersectionObserver only; newer upstream versions use GSAP. The adjacent LICENSE.md is the exact upstream license from that revision (MIT + Commons Clause); this component is incorporated into the AVA application and is not offered as a component product.

Local adaptations: visible initial render and missing-API fallback; minimum opacity 0.85 so essential content never disappears; no blur; reduced-motion preference and live preference changes; observer/timer cleanup; bounded delay/duration; HTML attributes and style forwarding. The original one-time IntersectionObserver reveal and component API are retained.

Use for the static assistant setup heading, without remounting it on steps or business changes:

```tsx
import FadeContent from './react-bits/FadeContent';

<FadeContent><h1>Настройте ассистента</h1></FadeContent>
```

Do not wrap live status messages or use this as a loading/success indicator.
