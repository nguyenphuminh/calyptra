// BRD 2.2.14.10: light or dark like the device, unless the user chose one in Settings > Appearance.
// The choice belongs to the browser, not to a wallet, and is kept unencrypted.
export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'calyptra.theme';
const deviceDark = window.matchMedia('(prefers-color-scheme: dark)');

function saved(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}
let choice: ThemeChoice = saved(); // module-level copy: survives refused storage until the page closes

function apply(): void {
  document.documentElement.dataset.theme = choice === 'system' ? (deviceDark.matches ? 'dark' : 'light') : choice;
}

export const themeChoice = (): ThemeChoice => choice;

export function chooseTheme(next: ThemeChoice): void {
  choice = next;
  try {
    if (next === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, next);
  } catch {
    /* storage refused (some private windows): the choice lasts until the page closes */
  }
  apply();
}

/** Applies the choice, then follows the device whenever the choice is the device's. */
export function followTheme(): void {
  apply();
  deviceDark.addEventListener('change', apply);
}
