import React from 'react';

export const DEVELOPER_MODE_KEY = 'sentry:developer-mode';

export function isDeveloperModeEnabled(): boolean {
  try {
    return window.localStorage.getItem(DEVELOPER_MODE_KEY) === '1';
  } catch {
    return false;
  }
}

export function useDeveloperMode(): boolean {
  const [enabled, setEnabled] = React.useState(isDeveloperModeEnabled);
  React.useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key === DEVELOPER_MODE_KEY) setEnabled(event.newValue === '1');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);
  return enabled;
}
