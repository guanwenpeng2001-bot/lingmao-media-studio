export type ThemeMode = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'lingmao:theme';

export function readStoredTheme(): ThemeMode {
  try {
    const val = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (val === 'dark' || val === 'light') return val;
  } catch {
    // ignore storage access issues
  }
  if (typeof document !== 'undefined') {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr === 'dark' || attr === 'light') return attr;
  }
  return 'light';
}

export function applyTheme(theme: ThemeMode): void {
  if (typeof document !== 'undefined') {
    document.documentElement.setAttribute('data-theme', theme);
  }
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // ignore storage errors
  }
}
