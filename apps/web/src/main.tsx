import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App.tsx';
import { registerServiceWorker } from './app/pwa.ts';
import { followTheme } from './app/theme.ts';
// Self-hosted fonts (the app works offline): Inter for text, JetBrains Mono for labels, Silkscreen for big money.
import '@fontsource-variable/inter';
import '@fontsource-variable/jetbrains-mono';
import '@fontsource/silkscreen';
import './styles.css';

followTheme();
registerServiceWorker();
createRoot(document.getElementById('root') as HTMLElement).render(<StrictMode><App /></StrictMode>);
