import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { buildPaletteEntries, filterPaletteEntries } from '../lib/palette.js';
import { sentryApi } from '../lib/sentry-api.js';

export function CommandPalette({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): React.JSX.Element | null {
  const navigate = useNavigate();
  const [query, setQuery] = React.useState('');
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const projects = useQuery({
    queryKey: ['projects'],
    queryFn: () => sentryApi().projects.list(),
    enabled: open,
  });
  const projectList =
    (projects.data as Array<{ projectId: string; name: string }> | undefined) ?? [];

  React.useEffect(() => {
    if (open) {
      setQuery('');
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  const go = React.useCallback(
    (to: string) => {
      onClose();
      navigate(to);
    },
    [navigate, onClose],
  );

  const entries = React.useMemo(() => buildPaletteEntries(projectList, go), [projectList, go]);
  const filtered = React.useMemo(() => filterPaletteEntries(entries, query), [entries, query]);

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-label="Command palette"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.5)',
        zIndex: 50,
        display: 'flex',
        justifyContent: 'center',
        paddingTop: 80,
      }}
      onClick={onClose}
    >
      <div
        className="card"
        style={{ width: 520, maxHeight: 420, overflow: 'auto' }}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            if (e.key === 'Enter' && filtered[0] !== undefined) filtered[0].run();
          }}
          placeholder="Type a command or project name…"
          aria-label="Command palette input"
          style={{ width: '100%' }}
        />
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {filtered.slice(0, 12).map((entry) => (
            <li key={entry.label}>
              <button onClick={entry.run} style={{ width: '100%', textAlign: 'left' }}>
                {entry.label}{' '}
                {entry.hint !== undefined ? <span className="mono faint">{entry.hint}</span> : null}
              </button>
            </li>
          ))}
          {filtered.length === 0 ? <li className="muted">No matching commands.</li> : null}
        </ul>
      </div>
    </div>
  );
}
