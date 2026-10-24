import React from 'react';
import enMessages from '../locales/en.json';
import bgMessages from '../locales/bg.json';
import {
  getLanguage,
  setLanguage,
  useAppPreferences,
  type AppLanguage,
} from './app-preferences.js';

export const TRANSLATIONS: Record<AppLanguage, Readonly<Record<string, string>>> = {
  en: enMessages,
  bg: bgMessages,
};

const BG_MAP: Readonly<Record<string, string>> = bgMessages;

const STATUS_BG: Readonly<Record<string, string>> = {
  ready: 'готов',
  'not ready': 'не е готов',
  unconfigured: 'неконфигуриран',
  configured: 'конфигуриран',
  degraded: 'ограничен',
  unavailable: 'недостъпен',
  unknown: 'неизвестно',
  running: 'изпълнява се',
  agents_running: 'изпълнява се',
  starting: 'стартира',
  planning: 'планиране',
  investigating: 'проучване',
  reporting: 'докладване',
  completed: 'завършено',
  partial: 'частично',
  failed: 'неуспешно',
  cancelled: 'прекъснато',
  timed_out: 'изтекло време',
  'timed out': 'изтекло време',
  interrupted: 'прекъснато',
  waiting: 'изчакване',
  'not started': 'не е стартиран',
  probing: 'проверка',
  connected: 'свързано',
  offline: 'офлайн',
};

function translateDurationUnits(raw: string): string {
  return raw
    .replace(/(\d+)h\b/g, '$1ч')
    .replace(/(\d+)m\b/g, '$1м')
    .replace(/(\d+)s\b/g, '$1с');
}

function translateExecutionRuntimeLine(trimmed: string): string | undefined {
  if (!trimmed.startsWith('Execution runtime:')) return undefined;
  return trimmed
    .replace(/^Execution runtime:/, 'Среда за изпълнение:')
    .replace(/\(source:\s*environment\)/i, '(източник: среда)')
    .replace(
      /\(source:\s*managed,\s*Sentry-managed installation\)/i,
      '(източник: управлявана инсталация на Sentry)',
    )
    .replace(/\(source:\s*managed\)/i, '(източник: управляван)')
    .replace(/\(source:\s*path\)/i, '(източник: PATH)')
    .replace(/\(source:\s*explicit\)/i, '(източник: изрично зададен)');
}

function translateCore(trimmed: string): string {
  if (trimmed.length === 0) return trimmed;
  const exact = BG_MAP[trimmed];
  if (exact !== undefined) return exact;

  const lowerStatus = STATUS_BG[trimmed.toLowerCase()];
  if (lowerStatus !== undefined) {
    return trimmed === trimmed.toUpperCase() && trimmed.length > 1
      ? lowerStatus.toUpperCase()
      : trimmed[0] === trimmed[0]?.toUpperCase()
        ? lowerStatus.charAt(0).toUpperCase() + lowerStatus.slice(1)
        : lowerStatus;
  }

  const execLine = translateExecutionRuntimeLine(trimmed);
  if (execLine !== undefined) return execLine;

  if (trimmed.startsWith('Started ')) {
    return 'Стартирано ' + trimmed.slice('Started '.length);
  }
  if (trimmed.startsWith('Duration ')) {
    return 'Продължителност ' + translateDurationUnits(trimmed.slice('Duration '.length));
  }
  if (trimmed.startsWith('Cancellation: ')) {
    const st = trimmed.slice('Cancellation: '.length);
    return 'Прекъсване: ' + (STATUS_BG[st.toLowerCase()] ?? st);
  }
  if (trimmed.startsWith('WSL distribution:')) {
    return 'WSL дистрибуция:' + trimmed.slice('WSL distribution:'.length);
  }
  if (trimmed.startsWith('Ecosystem:')) {
    return 'Екосистема:' + trimmed.slice('Ecosystem:'.length);
  }

  const runsMatch = /^(\d+)\s+runs?$/.exec(trimmed);
  if (runsMatch !== null) {
    const count = runsMatch[1];
    return count === '1' ? '1 изпълнение' : `${count} изпълнения`;
  }

  const activeRunMatch = /^(\d+)\s+(?:(last known active|active))\s+runs?(?:\s*·\s*Open)?$/.exec(
    trimmed,
  );
  if (activeRunMatch !== null) {
    const count = activeRunMatch[1];
    const hasOpen = trimmed.endsWith('Open');
    const base = count === '1' ? '1 активно изпълнение' : `${count} активни изпълнения`;
    return hasOpen ? `${base} · Отвори` : base;
  }

  const inProgressMatch = /^(\d+)\s+QA\s+runs?\s+in\s+progress$/.exec(trimmed);
  if (inProgressMatch !== null) {
    const count = inProgressMatch[1];
    return count === '1' ? '1 QA изпълнение в ход' : `${count} QA изпълнения в ход`;
  }

  const selectedAgentsMatch = /^([\d,]+)\s+selected\s+agents?$/.exec(trimmed);
  if (selectedAgentsMatch !== null) {
    const count = selectedAgentsMatch[1];
    return count === '1' ? '1 избран агент' : `${count} избрани агента`;
  }

  const selectedMatch = /^([\d,]+)\s+selected$/.exec(trimmed);
  if (selectedMatch !== null) {
    const count = selectedMatch[1];
    return count === '1' ? '1 избран' : `${count} избрани`;
  }

  const findingsEvidenceMatch = /^([\d,]+)\s+(total\s+)?findings?\s*·\s*([\d,]+)\s+evidence$/.exec(
    trimmed,
  );
  if (findingsEvidenceMatch !== null) {
    const fCount = findingsEvidenceMatch[1];
    const isTotal = Boolean(findingsEvidenceMatch[2]);
    const eCount = findingsEvidenceMatch[3];
    const fLabel = fCount === '1' ? 'констатация' : 'констатации';
    const eLabel = eCount === '1' ? 'доказателство' : 'доказателства';
    const totalWord = isTotal ? 'общо ' : '';
    return `${fCount} ${totalWord}${fLabel} · ${eCount} ${eLabel}`;
  }

  const agentSummaryMatch =
    /^(\d+)\s+running\s*·\s*(\d+)\s+completed\s*·\s*(\d+)\s+failed\s*\/\s*timed\s+out\s*\/\s*interrupted$/.exec(
      trimmed,
    );
  if (agentSummaryMatch !== null) {
    return `${agentSummaryMatch[1]} активни · ${agentSummaryMatch[2]} завършени · ${agentSummaryMatch[3]} неуспешни / изтекли / прекъснати`;
  }

  const findingsCountMatch = /^([\d,]+)\s+findings?$/.exec(trimmed);
  if (findingsCountMatch !== null) {
    const count = findingsCountMatch[1];
    return count === '1' ? '1 констатация' : `${count} констатации`;
  }

  const evidenceCountMatch = /^([\d,]+)\s+evidence$/.exec(trimmed);
  if (evidenceCountMatch !== null) {
    const count = evidenceCountMatch[1];
    return count === '1' ? '1 доказателство' : `${count} доказателства`;
  }

  const tabCountMatch = /^(Findings|Evidence)\s*\((\d+)\)$/.exec(trimmed);
  if (tabCountMatch !== null) {
    const tabName = tabCountMatch[1] === 'Findings' ? 'Констатации' : 'Доказателства';
    return `${tabName} (${tabCountMatch[2]})`;
  }

  const modeProdMatch = /^(FULL|TARGETED)\s+QA\s*·\s*(Production|Legacy simulation)$/i.exec(
    trimmed,
  );
  if (modeProdMatch !== null) {
    const modeLabel = modeProdMatch[1]?.toUpperCase() === 'FULL' ? 'ПЪЛЕН QA' : 'ЦЕЛЕВИ QA';
    const kindLabel =
      modeProdMatch[2]?.toLowerCase() === 'production' ? 'Продукция' : 'Симулация (наследена)';
    return `${modeLabel} · ${kindLabel}`;
  }

  const analysisStatusMatch = /^Analysis\s+(cancelled|failed|partial)\.?$/i.exec(trimmed);
  if (analysisStatusMatch !== null) {
    const st = analysisStatusMatch[1]?.toLowerCase();
    if (st === 'cancelled') return 'Анализът е прекъснат.';
    if (st === 'failed') return 'Анализът е неуспешен.';
    if (st === 'partial') return 'Анализът е частичен.';
  }

  const runSummaryMatch =
    /^([?\d]+)\/([?\d]+)\s+agents\s*·\s*(\d+)\s+findings\s*·\s*(\d+)\s+issues$/.exec(trimmed);
  if (runSummaryMatch !== null) {
    return `${runSummaryMatch[1]}/${runSummaryMatch[2]} агента · ${runSummaryMatch[3]} констатации · ${runSummaryMatch[4]} проблема`;
  }

  const bareModeMatch = /^(FULL|TARGETED)\s+QA$/.exec(trimmed);
  if (bareModeMatch !== null) {
    return bareModeMatch[1] === 'FULL' ? 'ПЪЛЕН QA' : 'ЦЕЛЕВИ QA';
  }

  const runsRevMatch = /^(\d+)\s+runs?\s*·\s*rev\s+(.+)$/.exec(trimmed);
  if (runsRevMatch !== null) {
    const count = runsRevMatch[1];
    const rev = runsRevMatch[2];
    return count === '1' ? `1 изпълнение · rev ${rev}` : `${count} изпълнения · rev ${rev}`;
  }

  const openRecentMatch = /^Open most recent active run\. (\d+) active runs?$/.exec(trimmed);
  if (openRecentMatch !== null) {
    const count = openRecentMatch[1];
    return count === '1'
      ? 'Отвори последното активно изпълнение. 1 активно изпълнение'
      : `Отвори последното активно изпълнение. ${count} активни изпълнения`;
  }

  const removeProjectMatch = /^Remove project (.+)$/.exec(trimmed);
  if (removeProjectMatch !== null) {
    return `Премахни проект ${removeProjectMatch[1]}`;
  }

  const removeHeadingMatch = /^Remove (.+)\?$/.exec(trimmed);
  if (removeHeadingMatch !== null) {
    return `Премахни ${removeHeadingMatch[1]}?`;
  }

  const createdMatch = /^(\d+)\s+created$/.exec(trimmed);
  if (createdMatch !== null) {
    return `${createdMatch[1]} създадени`;
  }

  const targetedPathsMatch = /^TARGETED\s*·\s*(\d+)\s+paths?$/.exec(trimmed);
  if (targetedPathsMatch !== null) {
    const count = targetedPathsMatch[1];
    return count === '1' ? 'ЦЕЛЕВИ · 1 път' : `ЦЕЛЕВИ · ${count} пътя`;
  }

  const severityBreakdownMatch =
    /^(\d+)\s+Critical\s*·\s*(\d+)\s+High\s*·\s*(\d+)\s+Medium\s*·\s*(\d+)\s+Low\s*·\s*(\d+)\s+Info$/.exec(
      trimmed,
    );
  if (severityBreakdownMatch !== null) {
    const [, critical, high, medium, low, info] = severityBreakdownMatch;
    return `${critical} критични · ${high} високи · ${medium} средни · ${low} ниски · ${info} информационни`;
  }

  const agentActivityMatch =
    /^([^\s]+?)\s+(running|planning|completed|failed|timed\s+out|interrupted|investigating|reporting|starting|probing)$/.exec(
      trimmed,
    );
  if (agentActivityMatch !== null) {
    const name = agentActivityMatch[1];
    const statusKey = agentActivityMatch[2]?.toLowerCase().replace(/\s+/, ' ') ?? '';
    const statusBg = STATUS_BG[statusKey];
    if (statusBg !== undefined) {
      return `${name} ${statusBg}`;
    }
  }

  return trimmed;
}

export function translateText(text: string, language: AppLanguage = getLanguage()): string {
  if (language === 'en') return text;
  const trimmed = text.trim();
  if (trimmed.length === 0) return text;
  const translated = translateCore(trimmed);
  if (translated === trimmed) return text;
  const start = text.indexOf(trimmed);
  const lead = text.slice(0, start);
  const tail = text.slice(start + trimmed.length);
  return lead + translated + tail;
}

export function useI18n(): {
  readonly language: AppLanguage;
  readonly setLanguage: (language: AppLanguage) => void;
  readonly t: (text: string) => string;
} {
  const { language } = useAppPreferences();
  const t = React.useCallback((text: string) => translateText(text, language), [language]);
  return { language, setLanguage, t };
}

const originalTextNodes = new WeakMap<Text, string>();
const lastWrittenTextNodes = new WeakMap<Text, string>();
const originalPlaceholder = new WeakMap<Element, string>();

function shouldSkipElement(el: Element | null): boolean {
  if (el === null) return true;
  // Skip code blocks, preformatted JSON, and dynamic agent message/finding descriptions
  return (
    el.closest('code, pre, [data-no-translate="true"], .event-row, .finding-title, .live-line') !==
    null
  );
}

function translateSubtree(root: HTMLElement, language: AppLanguage): void {
  if (typeof document === 'undefined') return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let current = walker.nextNode() as Text | null;
  while (current !== null) {
    const parent = current.parentElement;
    if (!shouldSkipElement(parent)) {
      const value = current.nodeValue ?? '';
      const lastWritten = lastWrittenTextNodes.get(current);
      // If React updated the text node underneath us, refresh the stored English source
      if (!originalTextNodes.has(current) || (lastWritten !== undefined && value !== lastWritten)) {
        originalTextNodes.set(current, value);
      }
      const source = originalTextNodes.get(current) ?? value;
      const target = language === 'en' ? source : translateText(source, 'bg');
      if (current.nodeValue !== target) {
        lastWrittenTextNodes.set(current, target);
        current.nodeValue = target;
      } else {
        lastWrittenTextNodes.set(current, value);
      }
    }
    current = walker.nextNode() as Text | null;
  }
  const inputs = root.querySelectorAll('input[placeholder], textarea[placeholder]');
  for (const el of inputs) {
    if (shouldSkipElement(el)) continue;
    const currentAttr = el.getAttribute('placeholder') ?? '';
    if (!originalPlaceholder.has(el)) {
      originalPlaceholder.set(el, currentAttr);
    }
    const source = originalPlaceholder.get(el) ?? currentAttr;
    const target = language === 'en' ? source : translateText(source, 'bg');
    if (currentAttr !== target) {
      el.setAttribute('placeholder', target);
    }
  }
  // Tooltips and accessible names follow the interface language too.
  const labelled = root.querySelectorAll('[title], [aria-label]');
  for (const el of labelled) {
    if (shouldSkipElement(el)) continue;
    translateElementAttribute(el, 'title', language);
    translateElementAttribute(el, 'aria-label', language);
  }
}

const originalAttributes = new WeakMap<Element, Map<string, string>>();
const lastWrittenAttributes = new WeakMap<Element, Map<string, string>>();

function translateElementAttribute(el: Element, attr: string, language: AppLanguage): void {
  const current = el.getAttribute(attr);
  if (current === null || current.trim().length === 0) return;
  let sources = originalAttributes.get(el);
  if (sources === undefined) {
    sources = new Map<string, string>();
    originalAttributes.set(el, sources);
  }
  let written = lastWrittenAttributes.get(el);
  if (written === undefined) {
    written = new Map<string, string>();
    lastWrittenAttributes.set(el, written);
  }
  const last = written.get(attr);
  // If React updated the attribute underneath us, refresh the stored English source.
  if (!sources.has(attr) || (last !== undefined && current !== last)) {
    sources.set(attr, current);
  }
  const source = sources.get(attr) ?? current;
  const target = language === 'en' ? source : translateText(source, 'bg');
  if (current !== target) {
    written.set(attr, target);
    el.setAttribute(attr, target);
  } else {
    written.set(attr, current);
  }
}

export function useDomTranslationObserver(
  rootRef: React.RefObject<HTMLElement | null>,
  language: AppLanguage,
): void {
  React.useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    translateSubtree(root, language);
    if (language === 'en' || typeof MutationObserver === 'undefined') return;
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        if (rootRef.current !== null && getLanguage() === 'bg') {
          translateSubtree(rootRef.current, 'bg');
        }
      });
    });
    observer.observe(root, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [rootRef, language]);
}
