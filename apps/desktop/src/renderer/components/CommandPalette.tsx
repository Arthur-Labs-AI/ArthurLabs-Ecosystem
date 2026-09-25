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
  const [selected, setSelected] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const listRef = React.useRef<HTMLUListElement | null>(null);
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
      setSelected(0);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open ]);

  const go = React.useCallback(
    (to: string) => {
      onClose();
      navigate(to);
    },
    [navigate, onClose],
  );

  const entries = React.useMemo(() => buildPaletteEntries(projectList, go), [projectList, go]);
  const filtered = React.useMemo(() => filterPaletteEntries(entries, query), [entries, query]);
  const visible = filtered.slice(0, 12);

  React.useEffect(() => {
    setSelected(0);
  }, [query]);

  React.useEffect(() => {
    listRef.current
      ?.querySelector('[data-selected="true"]')
      ?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-modal="true"
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
        style={{ width: 520, maxHeight: 420, overflow: 'auto', height: 'fit-content' }}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSelected((s) => Math.min(s + 1, Math.max(visible.length - 1, 0)));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSelected((s) => Math.max(s - 1, 0));
            } else if (e.key === 'Enter' && visible[selected] !== undefined) {
              visible[selected]?.run();
            }
          }}
          placeholder="Type a command or project name…"
          aria-label="Command palette input"
          aria-activedescendant={visible[selected] !== undefined ? 'palette-' + selected : undefined}
          aria-expanded="true"
          aria-controls="palette-list"
          role="combobox"
          style={{ width: '100%' }}
        />
        <ul ref={listRef} id="palette-list" role="listbox" style={{ listStyle: 'none', padding: 0 }}>
          {visible.map((entry, index) => (
            <li key={entry.label} role="option" id={'palette-' + index} aria-selected={index === selected}>
              <button
                onClick={entry.run}
                onMouseEnter={() => setSelected(index)}
                data-selected={index === selected}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  borderColor: index === selected ? 'var(--accent)' : undefined,
                  background: index === selected ? 'var(--bg-panel)' : undefined,
                }}
              >
                {entry.label}{' '}
                {entry.hint !== undefined ? <span className="mono faint">{entry.hint}</span> : null}
              </button>
            </li>
          ))}
          {visible.length === 0 ? <li className="muted">No matching commands.</li> : null}
        </ul>
      </div>
    </div>
  );
}
