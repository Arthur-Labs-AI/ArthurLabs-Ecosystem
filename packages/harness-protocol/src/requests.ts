/**
 * Re-export of the run-request DTOs (source of truth: @qa/schemas)
 * so adapter implementers import everything protocol from one package.
 */
export {
  HarnessWorkspaceSchema,
  HarnessTaskSchema,
  HarnessRunRequestSchema,
  type HarnessWorkspace,
  type HarnessTask,
  type HarnessRunRequest,
} from '@qa/schemas';
