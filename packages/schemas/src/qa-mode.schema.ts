/** QA workflows: full | targeted. */
import { z } from 'zod';

export const QA_MODES = ['full', 'targeted'] as const;
export const CANONICAL_QA_MODES = ['full', 'targeted'] as const;
export type QAMode = (typeof QA_MODES)[number];

export const QAModeSchema = z.enum(QA_MODES);
export type QAModeType = z.infer<typeof QAModeSchema>;
