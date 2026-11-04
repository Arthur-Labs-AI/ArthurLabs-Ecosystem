import type { GraphDiagnosticsManualRun } from "@arthur/contracts";

/** The generic sentence, used only when nothing more is known (for example a client without diagnostics). */
export const NOTHING_NEW = "No new connections found.";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * What an empty "Find connections" run really was. The button asks the AI model to propose connections among this project's ideas and
 * checks every proposal twice, so "nothing added" has different causes and each one is said plainly instead of one generic sentence.
 */
export function describeEmptyInference(run: GraphDiagnosticsManualRun | null): string {
  if (!run) return NOTHING_NEW;
  switch (run.outcome) {
    case "NO_CANDIDATES":
      return "There are not enough ideas in this project to compare yet. Nothing was sent to the AI.";
    case "ALL_REJECTED":
      return `Arthur proposed ${plural(run.proposed, "possible connection", "possible connections")}, but its own checks rejected ${run.rejected === run.verified ? "all of them" : `${run.rejected} of ${run.verified}`}. Nothing was added.`;
    case "SUCCESS_NO_NEW_EDGES":
      if (run.proposed > 0 && run.alreadyConnected === run.proposed) return `Arthur found ${plural(run.proposed, "possible connection", "possible connections")}, and ${run.proposed === 1 ? "it is" : "they are"} already connected. Nothing new to add.`;
      return `Arthur compared ${plural(run.considered, "idea", "ideas")} and did not find a connection it could support. Nothing was added.`;
    default:
      return NOTHING_NEW;
  }
}
