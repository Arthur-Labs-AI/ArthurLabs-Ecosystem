import { translateText } from './i18n.js';

export interface PaletteEntry {
  readonly label: string;
  readonly hint?: string;
  readonly run: () => void;
}

export function buildPaletteEntries(
  projects: ReadonlyArray<{ projectId: string; name: string }>,
  go: (to: string) => void,
): PaletteEntry[] {
  return [
    { label: 'Open Projects', run: () => go('/projects') },
    { label: 'Open Environment', run: () => go('/environment') },
    { label: 'Open Settings', run: () => go('/settings') },
    ...projects.flatMap((project): PaletteEntry[] => [
      {
        label: 'Open Project — ' + project.name,
        hint: project.projectId.slice(0, 12),
        run: () => go('/projects/' + project.projectId),
      },
      {
        label: 'Start Full QA — ' + project.name,
        run: () => go('/projects/' + project.projectId),
      },
      {
        label: 'Start Targeted QA — ' + project.name,
        run: () => go('/projects/' + project.projectId),
      },
    ]),
  ];
}

export function filterPaletteEntries(
  entries: readonly PaletteEntry[],
  query: string,
  language: 'en' | 'bg' = 'en',
): PaletteEntry[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...entries];
  return entries.filter((e) =>
    (e.label + ' ' + (e.hint ?? '') + ' ' + translateText(e.label, language)).toLowerCase().includes(q),
  );
}
