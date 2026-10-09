import { GraphDiagnosticsPanel } from "./GraphDiagnosticsPanel";
import { useAutomaticConnections } from "./use-automatic-connections";

export const AUTOMATIC_CONNECTIONS_DESCRIPTION = "Automatically discover and connect related ideas in your Projects.";
export const AUTOMATIC_CONNECTIONS_WARNING = "Experimental: AI-generated connections may be inaccurate. Review important relationships before relying on them.";

/**
 * The one switch for Automatic Connections. It shows only the saved state; a change that could not be saved is reported as an error
 * and the switch stays where it was. Off by default, and turning it off never removes a connection.
 */
export function AutomaticConnectionsSetting({ variant }: { variant: "desktop" | "mobile" }) {
  const connections = useAutomaticConnections();
  const value = connections.value;
  const errorClass = variant === "mobile" ? "m-note-block err" : "alert";

  return (
    <div className="ai-auto" data-variant={variant}>
      <h3>Automatic Connections</h3>
      <p>{AUTOMATIC_CONNECTIONS_DESCRIPTION}</p>
      {connections.status === "loading" && <p role="status">Reading the setting…</p>}
      {connections.status === "error" && (
        <p role="alert" className={errorClass}>
          Could not read the Automatic Connections setting: {connections.error}
        </p>
      )}
      {value && (
        <>
          <label className="sr-toggle">
            <input type="checkbox" role="switch" checked={value.enabled} disabled={connections.busy} onChange={(event) => void connections.setEnabled(event.target.checked)} />
            <span>Automatic Connections</span>
            <b className="sr-onoff">{value.enabled ? "On" : "Off"}</b>
          </label>
          {value.enabled && <p role="note">{AUTOMATIC_CONNECTIONS_WARNING}</p>}
          <GraphDiagnosticsPanel variant={variant} refreshKey={value.enabled} />
          <p className="ai-fine">
            {value.enabled
              ? "New ideas and meaningful changes are connected in the background using your AI provider. Ideas you already have are not scanned. Turning this off keeps every connection."
              : "Off: nothing is sent for connecting, and your own connections work as always."}
          </p>
        </>
      )}
      {connections.error && connections.status !== "error" && (
        <p role="alert" className={errorClass}>
          {connections.error}
        </p>
      )}
    </div>
  );
}
