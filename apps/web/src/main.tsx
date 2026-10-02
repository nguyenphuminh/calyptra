import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.tsx';
import { registerServiceWorker } from './app/pwa.ts';
import { followTheme } from './app/theme.ts';
import './styles.css';

followTheme();
registerServiceWorker();
createRoot(document.getElementById('root') as HTMLElement).render(<StrictMode><App /></StrictMode>);
