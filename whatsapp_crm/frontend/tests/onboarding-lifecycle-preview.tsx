// Local browser harness: production App and HTTP onboarding API; synthetic identity and provider data.
import React from 'react';
import { createRoot } from 'react-dom/client';
import App from '../src/App';
import '../src/index.css';
import '../src/pages/AvaWorkspace.css';

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
