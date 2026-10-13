// The installable app (PWA): production builds register the service worker that vite.config.ts
// generates (sw.js). The dev server never does, so development always sees fresh files.
export function registerServiceWorker(): void {
  if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => undefined); // the app works the same without it
  });
}
