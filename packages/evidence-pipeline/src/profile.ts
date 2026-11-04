import { PROJECT_PROFILE_TEXT_MAX } from '@qa/schemas';

/** Context key under which a run hands an agent its own profile. */
export const PROFILE_CONTEXT_KEY = 'projectProfile';

const PROFILE_NOTE =
  'Your own earlier orientation notes about this project (AGENT-WRITTEN and UNVERIFIED: a map to save reconnaissance time, never evidence; the code may have changed and your notes may be wrong or incomplete; still read and probe the real code, and do not skip an area because the notes do not mention it).';

/** The profile text from the planning output of a profile turn: notes plus entry points, bounded. */
export function composeProfileText(plan: {
  readonly projectUnderstanding: string;
  readonly criticalFlows?: readonly string[] | undefined;
}): string {
  const flows = (plan.criticalFlows ?? []).map((line) => '- ' + line.trim()).filter((l) => l.length > 2);
  const text =
    plan.projectUnderstanding.trim() +
    (flows.length === 0 ? '' : '\n\nEntry points and flows:\n' + flows.join('\n'));
  return text.length <= PROJECT_PROFILE_TEXT_MAX
    ? text
    : text.slice(0, PROJECT_PROFILE_TEXT_MAX - 20).trimEnd() + '\n[notes cut]';
}

/** The mission-context entry that carries a profile into a run. */
export function profileContextEntry(text: string): { note: string; text: string } {
  return { note: PROFILE_NOTE, text };
}
