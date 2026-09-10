import { z, type ZodRawShape } from 'zod';
import { RelativePathSchema } from './primitives.js';

const CodeLocationShape = {
  relativePath: RelativePathSchema,
  startLine: z.number().int().min(1).optional(),
  endLine: z.number().int().min(1).optional(),
  symbol: z.string().min(1).max(300).optional(),
  message: z.string().min(1).max(2000).optional(),
};

function hasValidLineRange(location: { startLine?: number; endLine?: number }): boolean {
  return (
    location.endLine === undefined ||
    (location.startLine !== undefined && location.endLine >= location.startLine)
  );
}

/** Build a location-derived schema while retaining the one canonical line-range rule. */
export function extendCodeLocationSchema<Extension extends ZodRawShape>(extension: Extension) {
  return z
    .object({ ...CodeLocationShape, ...extension })
    .strict()
    .refine(hasValidLineRange, {
      message: 'endLine must be >= startLine (and requires startLine)',
    });
}

/** One canonical project-relative source location for every boundary DTO. */
export const CodeLocationSchema = extendCodeLocationSchema({});
export type CodeLocation = z.infer<typeof CodeLocationSchema>;
