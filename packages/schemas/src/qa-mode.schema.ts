/** Phase 7 canonical QA modes (§6). Persisted explicitly on every QARun —
 *  never inferred later from flags or instructions. FULL semantics are
 *  unchanged (§7); TARGETED and RETEST are first-class (§8, §14). */
import { z } from 'zod';

export const QA_MODES = ['full', 'targeted', 'retest'] as const;
export type QAMode = (typeof QA_MODES)[number];

export const QAModeSchema = z.enum(QA_MODES);
export type QAModeType = z.infer<typeof QAModeSchema>;
