import React from 'react';

export type ThemeMode = 'dark' | 'midnight' | 'light';
export type AppLanguage = 'en' | 'bg';

export const THEME_MODE_KEY = 'sentry:theme-mode';
export const LANGUAGE_KEY = 'sentry:language';
export const REDUCED_MOTION_KEY = 'sentry:reduced-motion';
export const CONFIRM_PAID_RUNS_KEY = 'sentry:confirm-paid-runs';
export const CLI_ENABLED_KEY = 'sentry:cli-enabled';

const PREFS_EVENT = 'sentry:preferences-changed';

function notifyPreferencesChanged(): void {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(PREFS_EVENT));
  }
}

export function getThemeMode(): ThemeMode {
  try {
    const raw = window.localStorage.getItem(THEME_MODE_KEY);
    if (raw === 'midnight' || raw === 'light' || raw === 'dark') return raw;
    return 'dark';
  } catch {
    return 'dark';
  }
}

export function setThemeMode(mode: ThemeMode): void {
  try {
    window.localStorage.setItem(THEME_MODE_KEY, mode);
  } catch {
    /* non-persistent */
  }
  applyDocumentPreferences();
  notifyPreferencesChanged();
}

export function getLanguage(): AppLanguage {
  try {
    const raw = window.localStorage.getItem(LANGUAGE_KEY);
    return raw === 'bg' ? 'bg' : 'en';
  } catch {
    return 'en';
  }
}

export function setLanguage(language: AppLanguage): void {
  try {
    window.localStorage.setItem(LANGUAGE_KEY, language);
  } catch {
    /* non-persistent */
  }
  applyDocumentPreferences();
  notifyPreferencesChanged();
}

export function isReducedMotionEnabled(): boolean {
  try {
    return window.localStorage.getItem(REDUCED_MOTION_KEY) === '1';
  } catch {
    return false;
  }
}

export function setReducedMotionEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(REDUCED_MOTION_KEY, enabled ? '1' : '0');
  } catch {
    /* non-persistent */
  }
  applyDocumentPreferences();
  notifyPreferencesChanged();
}

export function isConfirmPaidRunsEnabled(): boolean {
  try {
    const raw = window.localStorage.getItem(CONFIRM_PAID_RUNS_KEY);
    return raw !== '0';
  } catch {
    return true;
  }
}

export function setConfirmPaidRunsEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(CONFIRM_PAID_RUNS_KEY, enabled ? '1' : '0');
  } catch {
    /* non-persistent */
  }
  notifyPreferencesChanged();
}

export function isCliBrokerEnabledPref(): boolean {
  try {
    const raw = window.localStorage.getItem(CLI_ENABLED_KEY);
    return raw !== '0';
  } catch {
    return true;
  }
}

export function setCliBrokerEnabledPref(enabled: boolean): void {
  try {
    window.localStorage.setItem(CLI_ENABLED_KEY, enabled ? '1' : '0');
  } catch {
    /* non-persistent */
  }
  notifyPreferencesChanged();
}

export function applyDocumentPreferences(): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.setAttribute('data-theme', getThemeMode());
  root.lang = getLanguage();
  if (isReducedMotionEnabled()) {
    root.setAttribute('data-reduced-motion', 'true');
  } else {
    root.removeAttribute('data-reduced-motion');
  }
}

export function useAppPreferences(): {
  readonly theme: ThemeMode;
  readonly setTheme: (mode: ThemeMode) => void;
  readonly language: AppLanguage;
  readonly setLanguage: (language: AppLanguage) => void;
  readonly reducedMotion: boolean;
  readonly setReducedMotion: (enabled: boolean) => void;
  readonly confirmPaidRuns: boolean;
  readonly setConfirmPaidRuns: (enabled: boolean) => void;
  readonly cliEnabledPref: boolean;
  readonly setCliEnabledPref: (enabled: boolean) => void;
} {
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    applyDocumentPreferences();
    const refresh = (): void => {
      applyDocumentPreferences();
      setTick((n) => n + 1);
    };
    window.addEventListener(PREFS_EVENT, refresh);
    window.addEventListener('storage', refresh);
    return () => {
      window.removeEventListener(PREFS_EVENT, refresh);
      window.removeEventListener('storage', refresh);
    };
  }, []);
  return {
    theme: getThemeMode(),
    setTheme: setThemeMode,
    language: getLanguage(),
    setLanguage,
    reducedMotion: isReducedMotionEnabled(),
    setReducedMotion: setReducedMotionEnabled,
    confirmPaidRuns: isConfirmPaidRunsEnabled(),
    setConfirmPaidRuns: setConfirmPaidRunsEnabled,
    cliEnabledPref: isCliBrokerEnabledPref(),
    setCliEnabledPref: setCliBrokerEnabledPref,
  };
}
