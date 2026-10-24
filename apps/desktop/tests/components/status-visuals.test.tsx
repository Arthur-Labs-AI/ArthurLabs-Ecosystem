import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { nodeStateClass, statusVisual } from '../../src/renderer/components/StatusGlyph.js';
import { StatusPill, dotClassForStatus } from '../../src/renderer/components/ui/StatusPill.js';

describe('status presentation preserves lifecycle meaning', () => {
  it.each(['not_started', 'idle', 'pending', 'inactive', 'offline', 'unavailable'])(
    '%s never looks like live activity',
    (status) => {
      expect(statusVisual(status).tone).toBe('muted');
      expect(statusVisual(status).spin).not.toBe(true);
      expect(statusVisual(status).breathe).not.toBe(true);
      expect(dotClassForStatus(status)).not.toContain('status-running');
      expect(nodeStateClass(status)).toBe('state-idle');
    },
  );

  it.each(['planning_failed', 'reporting_failed', 'completed_with_errors'])(
    '%s gives failure precedence over phase names',
    (status) => {
      expect(statusVisual(status).tone).toBe('danger');
      expect(nodeStateClass(status)).toBe('state-failed');
    },
  );

  it('keeps partial completion and timeout distinct from success', () => {
    expect(statusVisual('partially_completed').tone).toBe('warning');
    expect(statusVisual('timed_out').tone).toBe('warning');
    expect(dotClassForStatus('timed_out')).toBe('status-dot status-partial');
  });

  it('renders the same semantic icon in pills and nodes with readable text', () => {
    const html = renderToStaticMarkup(<StatusPill status="thinking" label="Planning scan" />);
    expect(html).toContain('lucide-brain');
    expect(html).toContain('Planning scan');
    expect(html).toContain('aria-hidden="true"');
  });
});
