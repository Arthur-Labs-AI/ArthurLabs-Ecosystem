import { useCallback, useEffect, useState } from "react";
import type { GraphDiagnostics } from "@arthur/contracts";
import { useArthurClient } from "../../hooks/use-arthur-client";
import "./diagnostics.css";

const n = (totals: Record<string, number>, key: string): number => totals[key] ?? 0;

/**
 * What Automatic Connections has actually done since Arthur started, in counts and codes. It exists because "nothing was connected" had
 * several indistinguishable causes (nothing to compare, everything rejected, the provider failed, the event never arrived). It shows no
 * idea text, no prompt, no answer and no key: the native layer never produces any.
 */
export function GraphDiagnosticsPanel({ variant, refreshKey }: { variant: "desktop" | "mobile"; refreshKey: unknown }) {
  const client = useArthurClient();
  const [data, setData] = useState<GraphDiagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const load = useCallback(() => {
    client.getGraphIntegrationDiagnostics().then(
      (next) => {
        setData(next);
        setError(null);
      },
      (failure: unknown) => setError(failure instanceof Error ? failure.message : String(failure)),
    );
  }, [client]);

  useEffect(() => {
    if (open) load();
  }, [open, load, refreshKey]);

  const t = data?.totals ?? {};
  return (
    <details className="gd" data-variant={variant} onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}>
      <summary>What Automatic Connections has done</summary>
      {error && (
        <p role="alert" className={variant === "mobile" ? "m-note-block err" : "alert"}>
          Could not read the diagnostics: {error}
        </p>
      )}
      {data && (
        <>
          <p role="status" className="gd-verdict">
            <b>{data.diagnosis.code}</b>
            <span>{data.diagnosis.explanation}</span>
          </p>
          <dl className="gd-counts">
            <dt>Worker</dt>
            <dd>{data.workerActive ? "running" : "not started"}</dd>
            <dt>Switch</dt>
            <dd>{data.enabled ? "on" : "off"}</dd>
            <dt>Ideas announced / received</dt>
            <dd>
              {n(t, "eventsEmitted")} / {n(t, "eventsReceived")}
              {n(t, "eventsDroppedDisabled") > 0 ? ` (${n(t, "eventsDroppedDisabled")} dropped while off)` : ""}
            </dd>
            <dt>Ideas compared · candidate pairs</dt>
            <dd>
              {n(t, "objectsConsidered")} · {n(t, "candidatePairs")}
            </dd>
            <dt>Proposal step (calls ok / failed)</dt>
            <dd>
              {n(t, "stageAAttempted")} ({n(t, "stageASucceeded")} / {n(t, "stageAFailed")})
            </dd>
            <dt>Checking step (calls ok / failed)</dt>
            <dd>
              {n(t, "stageBAttempted")} ({n(t, "stageBSucceeded")} / {n(t, "stageBFailed")})
            </dd>
            <dt>Invalid answers</dt>
            <dd>{n(t, "contractErrors")}</dd>
            <dt>Proposed · rejected · saved</dt>
            <dd>
              {n(t, "proposed")} · {n(t, "rejected")} · {n(t, "relationsPersisted")}
            </dd>
            <dt>Save failures</dt>
            <dd>{n(t, "persistFailed")}</dd>
            <dt>Screen updates sent</dt>
            <dd>{n(t, "uiUpdatesDelivered")}</dd>
          </dl>
          {data.recentRuns.length > 0 && (
            <ul className="gd-runs" aria-label="Recent runs">
              {data.recentRuns.slice(0, 8).map((run, index) => (
                <li key={`${run.object}-${run.at}-${index}`}>
                  <code>{run.object}</code> {run.reason} · <b>{run.outcome}</b>
                  {run.detail ? ` (${run.detail})` : ""} · {run.candidates} compared, {run.proposed} proposed, {run.rejected} rejected, {run.added} saved
                </li>
              ))}
            </ul>
          )}
          <button type="button" className={variant === "mobile" ? "m-pbtn sm" : "btn"} onClick={load}>
            Refresh
          </button>
        </>
      )}
    </details>
  );
}
