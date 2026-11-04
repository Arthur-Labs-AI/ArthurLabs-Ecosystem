/**
 * File-backed application locale for the Electron main process.
 *
 * The renderer owns the language selection (localStorage) and mirrors it
 * here over IPC; main reads this file for strings the renderer can never
 * translate (native dialogs, the fatal boot screen). Every function is
 * total: missing files, corrupt JSON, and unwritable disks all fall back
 * to English instead of throwing.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export type AppLanguage = 'en' | 'bg';

export const APP_LOCALE_FILENAME = 'sentry-app-locale.json';

export function isAppLanguage(value: unknown): value is AppLanguage {
  return value === 'en' || value === 'bg';
}

export function resolveAppLocalePath(userDataDir: string): string {
  return join(userDataDir, APP_LOCALE_FILENAME);
}

export function readAppLanguage(userDataDir: string | undefined): AppLanguage {
  try {
    if (typeof userDataDir !== 'string' || userDataDir.length === 0) return 'en';
    const raw = readFileSync(resolveAppLocalePath(userDataDir), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    const language =
      typeof parsed === 'object' && parsed !== null
        ? (parsed as { language?: unknown }).language
        : undefined;
    return isAppLanguage(language) ? language : 'en';
  } catch {
    return 'en';
  }
}

export function writeAppLanguage(userDataDir: string | undefined, language: AppLanguage): boolean {
  try {
    if (typeof userDataDir !== 'string' || userDataDir.length === 0) return false;
    if (!isAppLanguage(language)) return false;
    mkdirSync(userDataDir, { recursive: true });
    const target = resolveAppLocalePath(userDataDir);
    const body = JSON.stringify({ language }) + '\n';
    const tmp = target + '.tmp-' + String(process.pid);
    try {
      writeFileSync(tmp, body, 'utf8');
      renameSync(tmp, target);
    } catch {
      // Atomic rename unavailable (aliases, locks): fall back to a direct
      // write rather than losing the preference. A torn file still reads
      // back as the English default, never as an exception.
      writeFileSync(target, body, 'utf8');
    }
    return true;
  } catch {
    return false;
  }
}

interface MainCopy {
  readonly en: string;
  readonly bg: string;
}

/** Every main-process user-facing string, in both interface languages. */
const MAIN_COPY: Record<string, MainCopy> = {
  'Disk reclamation is running': {
    en: 'Disk reclamation is running',
    bg: 'Тече освобождаване на дисково пространство',
  },
  'Wait for Windows disk reclamation and runtime reconnection to finish before closing Sentry.': {
    en: 'Wait for Windows disk reclamation and runtime reconnection to finish before closing Sentry.',
    bg: 'Изчакайте да завърши освобождаването на дисково пространство от Windows и повторното свързване на средата, преди да затворите Sentry.',
  },
  'Sentry is still running': {
    en: 'Sentry is still running',
    bg: 'Sentry все още работи',
  },
  'Shutdown could not complete. Cancel active QA work, wait for it to finish, then retry sentry stop.':
    {
      en: 'Shutdown could not complete. Cancel active QA work, wait for it to finish, then retry sentry stop.',
      bg: 'Затварянето не можа да завърши. Прекъснете активната QA работа, изчакайте да приключи и опитайте отново да спрете Sentry.',
    },
  'Sentry — runtime offline': {
    en: 'Sentry — runtime offline',
    bg: 'Sentry — средата за изпълнение е офлайн',
  },
  'Sentry Runtime Offline': {
    en: 'Sentry Runtime Offline',
    bg: 'Средата за изпълнение на Sentry е офлайн',
  },
  'Sentry — data store unavailable': {
    en: 'Sentry — data store unavailable',
    bg: 'Sentry — хранилището на данни е недостъпно',
  },
  'Sentry could not open its data store.': {
    en: 'Sentry could not open its data store.',
    bg: 'Sentry не можа да отвори своето хранилище от данни.',
  },
  'Sentry Desktop is running, but the native Linux execution runtime could not start.': {
    en: 'Sentry Desktop is running, but the native Linux execution runtime could not start.',
    bg: 'Sentry Desktop работи, но средата за изпълнение на native Linux не можа да се стартира.',
  },
  'Sentry Desktop is running, but the WSL2 execution runtime could not start.': {
    en: 'Sentry Desktop is running, but the WSL2 execution runtime could not start.',
    bg: 'Sentry Desktop работи, но WSL2 средата за изпълнение не можа да се стартира.',
  },
  'QA execution is disabled. Native Linux support currently targets CachyOS only.': {
    en: 'QA execution is disabled. Native Linux support currently targets CachyOS only.',
    bg: 'Изпълнението на QA е деактивирано. Поддръжката на native Linux в момента е само за CachyOS.',
  },
  'QA execution is disabled. See docs/setup/wsl-runtime.md for setup instructions.': {
    en: 'QA execution is disabled. See docs/setup/wsl-runtime.md for setup instructions.',
    bg: 'Изпълнението на QA е деактивирано. Вижте docs/setup/wsl-runtime.md за инструкции за настройка.',
  },
  'Fix the data root (SENTRY_DATA_ROOT) and retry.': {
    en: 'Fix the data root (SENTRY_DATA_ROOT) and retry.',
    bg: 'Поправете корена на данните (SENTRY_DATA_ROOT) и опитайте отново.',
  },
};

export function mainCopyKeys(): string[] {
  return Object.keys(MAIN_COPY);
}

export function translateMainCopy(source: string, language: AppLanguage): string {
  const entry = MAIN_COPY[source];
  if (entry === undefined) return source;
  return language === 'bg' ? entry.bg : entry.en;
}
