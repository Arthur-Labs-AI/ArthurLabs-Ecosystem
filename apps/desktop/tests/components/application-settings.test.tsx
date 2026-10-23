import React from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Settings } from '../../src/renderer/pages/Settings.js';
import { ApplicationSettings } from '../../src/renderer/pages/ApplicationSettings.js';
import { translateText } from '../../src/renderer/lib/i18n.js';

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  window.localStorage.clear();
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-reduced-motion');
  document.documentElement.lang = 'en';
  delete (window as { sentry?: unknown }).sentry;
});

function mountSettings(initialEntry = '/settings', setEnabled = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  clients.push(client);
  Object.defineProperty(window, 'sentry', {
    configurable: true,
    value: {
      system: {
        info: vi
          .fn()
          .mockResolvedValue({ dataRoot: '/data/sentry', versions: { runtime: '1.0.2' } }),
      },
      cli: {
        status: vi.fn().mockResolvedValue({
          started: true,
          pipePath: '\\\\.\\pipe\\sentry-cli',
          connectedClients: [],
        }),
        setEnabled,
      },
    },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/settings" element={<Settings />} />
          <Route path="/settings/application" element={<ApplicationSettings />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return { setEnabled };
}

describe('Application settings & localization', () => {
  it('defaults to English and translates static and dynamic UI strings to Bulgarian', () => {
    expect(translateText('Dashboard')).toBe('Dashboard');
    expect(translateText('Dashboard', 'bg')).toBe('Табло');
    expect(translateText('Settings', 'bg')).toBe('Настройки');
    expect(translateText('Started 15:14', 'bg')).toBe('Стартирано 15:14');
    expect(translateText('Duration 13m 26s', 'bg')).toBe('Продължителност 13м 26с');
    expect(translateText('3 selected agents', 'bg')).toBe('3 избрани агента');
    expect(translateText('19 findings · 41 evidence', 'bg')).toBe(
      '19 констатации · 41 доказателства',
    );
    expect(translateText('19 total findings · 41 evidence', 'bg')).toBe(
      '19 общо констатации · 41 доказателства',
    );
    expect(translateText('Run', 'bg')).toBe('Изпълнение');
    expect(translateText('cancelled', 'bg')).toBe('прекъснато');
    expect(translateText('completed', 'bg')).toBe('завършено');
    expect(translateText('unconfigured', 'bg')).toBe('неконфигуриран');
    expect(translateText('FULL QA · Production', 'bg')).toBe('ПЪЛЕН QA · Продукция');
    expect(translateText('Results', 'bg')).toBe('Резултати');
    expect(translateText('3 selected', 'bg')).toBe('3 избрани');
    expect(
      translateText('0 running · 2 completed · 0 failed / timed out / interrupted', 'bg'),
    ).toBe('0 активни · 2 завършени · 0 неуспешни / изтекли / прекъснати');
    expect(translateText('AGENT EXECUTIONS COMPLETE', 'bg')).toBe('ЗАВЪРШЕНИ ИЗПЪЛНЕНИЯ НА АГЕНТИ');
    expect(translateText('10 findings', 'bg')).toBe('10 констатации');
    expect(
      translateText(
        'Incomplete analysis. Reported findings and evidence are retained independently for each agent.',
        'bg',
      ),
    ).toBe(
      'Непълен анализ. Докладваните констатации и доказателства се запазват независимо за всеки агент.',
    );
    expect(translateText('Analysis cancelled.', 'bg')).toBe('Анализът е прекъснат.');
    expect(
      translateText(
        'Review agent details and Environment before deliberately starting another run.',
        'bg',
      ),
    ).toBe('Прегледайте детайлите на агентите и Среда, преди да стартирате ново изпълнение.');
    expect(
      translateText(
        'Execution runtime: /home/u/.local/share/sentry/tools/opencode/node_modules/.bin/opencode (source: environment)',
        'bg',
      ),
    ).toBe(
      'Среда за изпълнение: /home/u/.local/share/sentry/tools/opencode/node_modules/.bin/opencode (източник: среда)',
    );
  });

  it('shows Application controls only after clicking the Application button on /settings', async () => {
    mountSettings('/settings');
    expect(screen.queryByRole('switch', { name: 'Developer mode' })).toBeNull();
    const links = screen.getAllByRole('link');
    const appLink = links.find((el) => el.getAttribute('href') === '/settings/application');
    expect(appLink).toBeDefined();
    fireEvent.click(appLink!);
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Application', level: 1 })).toBeTruthy(),
    );
    expect(screen.getByRole('switch', { name: 'Developer mode' })).toBeTruthy();
  });

  it('switches theme modes, language, CLI broker, reduced motion, and paid-run guard', async () => {
    const setEnabled = vi.fn().mockResolvedValue({
      started: false,
      pipePath: '\\\\.\\pipe\\sentry-cli',
      connectedClients: [],
    });
    mountSettings('/settings/application', setEnabled);

    fireEvent.click(screen.getByRole('button', { name: 'Midnight Slate' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('midnight');

    fireEvent.click(screen.getByRole('button', { name: 'Daylight Light' }));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');

    const motionSwitch = screen.getByRole('switch', { name: 'Workspace Motion & Animations' });
    fireEvent.click(motionSwitch);
    expect(document.documentElement.getAttribute('data-reduced-motion')).toBe('true');

    const confirmSwitch = screen.getByRole('switch', { name: 'Confirm Before Paid QA Runs' });
    expect(confirmSwitch.getAttribute('aria-checked')).toBe('true');
    fireEvent.click(confirmSwitch);
    expect(confirmSwitch.getAttribute('aria-checked')).toBe('false');

    const cliSwitch = screen.getByRole('switch', { name: 'Local CLI Broker' });
    fireEvent.click(cliSwitch);
    await waitFor(() => expect(setEnabled).toHaveBeenCalledWith(false));

    fireEvent.click(screen.getByRole('button', { name: 'Bulgarian (Български)' }));
    await waitFor(() => expect(document.documentElement.lang).toBe('bg'));
    expect(screen.getByText('Изглед и тема')).toBeTruthy();
  });
});
