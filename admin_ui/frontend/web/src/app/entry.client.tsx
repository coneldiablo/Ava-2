import { startTransition, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HydratedRouter } from 'react-router/dom';

// This application is built with `ssr: false`: the generated document is a
// static SPA bootstrap shell, not server-rendered route content. Mounting it as
// a fresh root avoids attempting to hydrate that shell as application markup.
startTransition(() => {
  createRoot(document).render(
    <StrictMode>
      <HydratedRouter />
    </StrictMode>
  );
});
