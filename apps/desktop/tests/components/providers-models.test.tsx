import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Providers } from '../../src/renderer/pages/Providers.js';

interface Status {
  name: string;
  configured: boolean;
  source: string;
  persistence: string;
  hint: string;
}

const clients: QueryClient[] = [];
afterEach(() => {
  cleanup();
  for (const client of clients.splice(0)) client.clear();
  delete (window as { sentry?: unknown }).sentry;
});

function statusRow(
  name: string,
  hint: string,
  configured = true,
  source = 'persisted',
  persistence = 'persisted',
): Status {
  return { name, configured, source, persistence, hint };
}

function mount(status: ReturnType<typeof vi.fn>, save = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false } },
  });
  clients.push(client);
  Object.defineProperty(window, 'sentry', {
    configurable: true,
    value: { providers: { status, save, clearKey: vi.fn(), forgetAll: vi.fn() } },
  });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Providers />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return {
    client,
    openCodeCard: () => within(screen.getByRole('region', { name: 'OpenCode provider settings' })),
    deepSeekCard: () => within(screen.getByRole('region', { name: 'DeepSeek provider settings' })),
    glmCard: () => within(screen.getByRole('region', { name: 'GLM provider settings' })),
  };
}

const bothKeys = (providerHint: string, modelHint = 'kimi-k3'): Status[] => [
  statusRow('SENTRY_OPENCODE_PROVIDER', providerHint, providerHint !== ''),
  statusRow('SENTRY_OPENCODE_MODEL', modelHint),
  {
    ...statusRow('OPENCODE_API_KEY', 'Configured · Stored securely'),
    source: 'stored',
    persistence: 'secure',
  },
  {
    ...statusRow('OPENROUTER_API_KEY', 'Configured · Stored securely'),
    source: 'stored',
    persistence: 'secure',
  },
];

describe('Providers model controls', () => {
  it('shows a Go subscription dropdown and switches to a manual input for pay-as-you-go modes', async () => {
    const query = vi.fn().mockResolvedValue(bothKeys('opencode-go'));
    const s = mount(query);
    await waitFor(() =>
      expect(
        (s.openCodeCard().getByLabelText('Value for SENTRY_OPENCODE_MODEL') as HTMLElement).tagName,
      ).toBe('SELECT'),
    );
    const modelSelect = s
      .openCodeCard()
      .getByLabelText('Value for SENTRY_OPENCODE_MODEL') as HTMLSelectElement;
    expect(modelSelect.tagName).toBe('SELECT');
    expect(modelSelect.value).toBe('kimi-k3');
    expect(within(modelSelect).getByRole('option', { name: 'glm-5.3-flash' })).toBeTruthy();

    const providerSelect = s
      .openCodeCard()
      .getByLabelText('Value for SENTRY_OPENCODE_PROVIDER') as HTMLSelectElement;
    fireEvent.change(providerSelect, { target: { value: 'opencode' } });
    const manual = s
      .openCodeCard()
      .getByLabelText('Value for SENTRY_OPENCODE_MODEL') as HTMLInputElement;
    expect(manual.tagName).toBe('INPUT');
    // No model dropdown in pay-as-you-go modes: only the manual text input.
    expect(manual.id).toBe('provider-SENTRY_OPENCODE_MODEL');

    fireEvent.change(providerSelect, { target: { value: 'openrouter' } });
    expect(
      (s.openCodeCard().getByLabelText('Value for SENTRY_OPENCODE_MODEL') as HTMLElement).tagName,
    ).toBe('INPUT');

    fireEvent.change(providerSelect, { target: { value: 'opencode-go' } });
    const back = s
      .openCodeCard()
      .getByLabelText('Value for SENTRY_OPENCODE_MODEL') as HTMLSelectElement;
    expect(back.tagName).toBe('SELECT');
    expect(within(back).getByRole('option', { name: 'gpt-6-luna' })).toBeTruthy();
    // Switching modes is local draft state: nothing is saved implicitly.
    expect(query).toHaveBeenCalledOnce();
  });

  it('saves chosen DeepSeek and GLM models and labels the legacy alias', async () => {
    const query = vi.fn().mockResolvedValue([]);
    const save = vi
      .fn()
      .mockResolvedValue({ configured: true, persistence: 'persisted', source: 'persisted' });
    const s = mount(query, save);

    const deepseekSelect = (await s
      .deepSeekCard()
      .findByLabelText('Value for SENTRY_DEEPSEEK_MODEL')) as HTMLSelectElement;
    fireEvent.change(deepseekSelect, { target: { value: 'deepseek-v4-pro' } });
    fireEvent.click(within(deepseekSelect.parentElement!).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('SENTRY_DEEPSEEK_MODEL', 'deepseek-v4-pro'),
    );

    fireEvent.change(deepseekSelect, { target: { value: 'deepseek-v4-flash' } });
    expect(s.deepSeekCard().getByText(/is a legacy alias/)).toBeTruthy();

    const glmSelect = s.glmCard().getByLabelText('Value for SENTRY_GLM_MODEL') as HTMLSelectElement;
    fireEvent.change(glmSelect, { target: { value: 'glm-5.3-flash' } });
    fireEvent.click(within(glmSelect.parentElement!).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith('SENTRY_GLM_MODEL', 'glm-5.3-flash'));
  });

  it('preserves provider-prefixed, legacy, and custom saved models without rewriting them', async () => {
    const query = vi
      .fn()
      .mockResolvedValue([
        statusRow('SENTRY_OPENCODE_PROVIDER', 'opencode-go'),
        statusRow('SENTRY_OPENCODE_MODEL', 'opencode-go/kimi-k3'),
        statusRow('SENTRY_DEEPSEEK_MODEL', 'deepseek-v4-flash'),
        statusRow('SENTRY_GLM_MODEL', 'my-custom-7b'),
      ]);
    const save = vi.fn();
    const s = mount(query, save);

    // Wait for the Go dropdown (its options render only in dropdown mode).
    await s.openCodeCard().findByRole('option', { name: 'kimi-k3' });
    const modelSelect = s
      .openCodeCard()
      .getByLabelText('Value for SENTRY_OPENCODE_MODEL') as HTMLSelectElement;
    // Provider prefix is understood for display; the saved id is untouched.
    expect(modelSelect.value).toBe('kimi-k3');
    expect(s.openCodeCard().queryByText(/not in the current list/)).toBeNull();

    expect(s.deepSeekCard().getByText(/is a legacy alias/)).toBeTruthy();

    const customInput = s
      .glmCard()
      .getByLabelText('Custom value for SENTRY_GLM_MODEL') as HTMLInputElement;
    expect(customInput.value).toBe('my-custom-7b');
    expect(s.glmCard().getByText(/not in the current list/)).toBeTruthy();
    expect(save).not.toHaveBeenCalled();
  });

  it('switches the active credential source and keeps both keys stored', async () => {
    const query = vi.fn().mockResolvedValue(bothKeys('opencode-go'));
    const save = vi
      .fn()
      .mockResolvedValue({ configured: true, persistence: 'persisted', source: 'persisted' });
    const s = mount(query, save);
    const useOpenRouter = await s.openCodeCard().findByRole('button', {
      name: 'Use OpenRouter key',
    });
    const useOpenCode = s.openCodeCard().getByRole('button', { name: 'Use OpenCode key' });
    expect(useOpenCode.getAttribute('aria-pressed')).toBe('true');

    fireEvent.click(useOpenRouter);
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('SENTRY_OPENCODE_PROVIDER', 'openrouter'),
    );

    // Persisted switch: both key statuses stay configured, selection follows.
    query.mockResolvedValue(bothKeys('openrouter'));
    await act(async () => {
      await s.client.invalidateQueries({ queryKey: ['providers'] });
    });
    await waitFor(() =>
      expect(
        s
          .openCodeCard()
          .getByRole('button', { name: 'Use OpenRouter key' })
          .getAttribute('aria-pressed'),
      ).toBe('true'),
    );
    expect(s.openCodeCard().getAllByText('Stored securely')).toHaveLength(2);

    // Switching back to the OpenCode key retains the explicit Go choice.
    fireEvent.click(s.openCodeCard().getByRole('button', { name: 'Use OpenCode key' }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('SENTRY_OPENCODE_PROVIDER', 'opencode-go'),
    );
  });

  it('warns when the live runtime does not acknowledge a save', async () => {
    const query = vi
      .fn()
      .mockResolvedValue([statusRow('SENTRY_DEEPSEEK_MODEL', 'deepseek-v4-flash')]);
    const save = vi.fn().mockResolvedValue({
      configured: true,
      persistence: 'persisted',
      source: 'persisted',
      runtimeSynced: false,
    });
    const s = mount(query, save);
    const modelSelect = (await s
      .deepSeekCard()
      .findByLabelText('Value for SENTRY_DEEPSEEK_MODEL')) as HTMLSelectElement;
    fireEvent.change(modelSelect, { target: { value: 'deepseek-v4-pro' } });
    fireEvent.click(within(modelSelect.parentElement!).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('SENTRY_DEEPSEEK_MODEL', 'deepseek-v4-pro'),
    );
    await waitFor(() => expect(screen.getByText(/live runtime did not pick up/)).toBeTruthy());
  });

  it('shows no runtime warning when the push is acknowledged', async () => {
    const query = vi
      .fn()
      .mockResolvedValue([statusRow('SENTRY_DEEPSEEK_MODEL', 'deepseek-v4-flash')]);
    const save = vi.fn().mockResolvedValue({
      configured: true,
      persistence: 'persisted',
      source: 'persisted',
      runtimeSynced: true,
    });
    const s = mount(query, save);
    const modelSelect = (await s
      .deepSeekCard()
      .findByLabelText('Value for SENTRY_DEEPSEEK_MODEL')) as HTMLSelectElement;
    fireEvent.change(modelSelect, { target: { value: 'deepseek-v4-pro' } });
    fireEvent.click(within(modelSelect.parentElement!).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('SENTRY_DEEPSEEK_MODEL', 'deepseek-v4-pro'),
    );
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Saved'));
    expect(screen.queryByText(/live runtime did not pick up/)).toBeNull();
  });

  it('retains an explicit Zen choice when toggling the credential source', async () => {
    const query = vi.fn().mockResolvedValue(bothKeys('opencode', 'gpt-5.5'));
    const save = vi
      .fn()
      .mockResolvedValue({ configured: true, persistence: 'persisted', source: 'persisted' });
    const s = mount(query, save);
    const useOpenRouter = await s.openCodeCard().findByRole('button', {
      name: 'Use OpenRouter key',
    });
    fireEvent.click(useOpenRouter);
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('SENTRY_OPENCODE_PROVIDER', 'openrouter'),
    );

    query.mockResolvedValue(bothKeys('openrouter', 'gpt-5.5'));
    await act(async () => {
      await s.client.invalidateQueries({ queryKey: ['providers'] });
    });
    await waitFor(() =>
      expect(
        s
          .openCodeCard()
          .getByRole('button', { name: 'Use OpenRouter key' })
          .getAttribute('aria-pressed'),
      ).toBe('true'),
    );
    fireEvent.click(s.openCodeCard().getByRole('button', { name: 'Use OpenCode key' }));
    await waitFor(() => expect(save).toHaveBeenCalledWith('SENTRY_OPENCODE_PROVIDER', 'opencode'));
  });

  it('a failed model save shows no success and keeps unrelated drafts', async () => {
    const query = vi.fn().mockResolvedValue([]);
    const save = vi.fn().mockRejectedValue(new Error('Credential could not be stored securely'));
    const s = mount(query, save);

    const keyInput = s
      .deepSeekCard()
      .getByLabelText('Value for DEEPSEEK_API_KEY') as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: 'synthetic-key-draft' } });
    const modelSelect = (await s
      .deepSeekCard()
      .findByLabelText('Value for SENTRY_DEEPSEEK_MODEL')) as HTMLSelectElement;
    fireEvent.change(modelSelect, { target: { value: 'deepseek-flash' } });
    fireEvent.click(within(modelSelect.parentElement!).getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('could not be stored'),
    );
    expect(screen.queryByRole('status')).toBeNull();
    expect(
      (s.deepSeekCard().getByLabelText('Value for DEEPSEEK_API_KEY') as HTMLInputElement).value,
    ).toBe('synthetic-key-draft');
  });

  it('dims the model Save button once there is nothing new to save', async () => {
    const query = vi
      .fn()
      .mockResolvedValue([statusRow('SENTRY_DEEPSEEK_MODEL', 'deepseek-v4-flash')]);
    const save = vi
      .fn()
      .mockResolvedValue({ configured: true, persistence: 'persisted', source: 'persisted' });
    const s = mount(query, save);

    const modelSelect = (await s
      .deepSeekCard()
      .findByLabelText('Value for SENTRY_DEEPSEEK_MODEL')) as HTMLSelectElement;
    const saveButton = within(modelSelect.parentElement!).getByRole('button', {
      name: 'Save',
    }) as HTMLButtonElement;
    // The saved model is shown, but with no unsaved draft Save stays dimmed.
    expect(saveButton.disabled).toBe(true);

    fireEvent.change(modelSelect, { target: { value: 'deepseek-v4-pro' } });
    expect(saveButton.disabled).toBe(false);
    fireEvent.click(saveButton);
    await waitFor(() =>
      expect(save).toHaveBeenCalledWith('SENTRY_DEEPSEEK_MODEL', 'deepseek-v4-pro'),
    );
    // The saved draft is cleared on success, so Save dims again.
    await waitFor(() => expect(saveButton.disabled).toBe(true));
  });

  it('saving one setting does not erase an unrelated unsaved draft', async () => {
    const query = vi.fn().mockResolvedValue([]);
    const save = vi
      .fn()
      .mockResolvedValue({ configured: true, persistence: 'persisted', source: 'persisted' });
    const s = mount(query, save);

    const keyInput = s
      .deepSeekCard()
      .getByLabelText('Value for DEEPSEEK_API_KEY') as HTMLInputElement;
    fireEvent.change(keyInput, { target: { value: 'unsaved-key-draft' } });
    const modelSelect = (await s
      .deepSeekCard()
      .findByLabelText('Value for SENTRY_DEEPSEEK_MODEL')) as HTMLSelectElement;
    fireEvent.change(modelSelect, { target: { value: 'deepseek-flash' } });
    fireEvent.click(within(modelSelect.parentElement!).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('Saved'));
    expect(
      (s.deepSeekCard().getByLabelText('Value for DEEPSEEK_API_KEY') as HTMLInputElement).value,
    ).toBe('unsaved-key-draft');
  });
});
