/** Phase 7 QA workflows. Canonical QARun execution modes are full |
 *  targeted; RETEST is a first-class cross-revision workflow (RetestRun +
 *  child QARun), not a QARun mode. QA_MODES retains 'retest' as a legacy
 *  workflow label so historical references still decode. */
import { z } from 'zod';

export const QA_MODES = ['full', 'targeted', 'retest'] as const;
export const CANONICAL_QA_MODES = ['full', 'targeted'] as const;
export type QAMode = (typeof QA_MODES)[number];

export const QAModeSchema = z.enum(QA_MODES);
export type QAModeType = z.infer<typeof QAModeSchema>;
