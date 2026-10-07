import { useState, type FormEvent } from "react";
import type { AiProviderId } from "@arthur/contracts";
import { useAiConfig } from "./ai-config-context";

/**
 * The one place a credential is typed. It is write-only: the value lives in this input until the native layer has stored it,
 * is cleared straight afterwards (success or not), and is never put in state that outlives the submit, a log, or a URL.
 */
export function KeyForm({ provider, providerName, variant, submitLabel = "Save key", onSaved, onCancel }: { provider: AiProviderId; providerName: string; variant: "desktop" | "mobile"; submitLabel?: string; onSaved?: () => void; onCancel?: () => void }) {
  const ai = useAiConfig();
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!value.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await ai.setCredential(provider, value);
      setValue("");
      onSaved?.();
    } catch (failure) {
      setValue("");
      setError(failure instanceof Error ? failure.message : "The key could not be saved.");
    } finally {
      setBusy(false);
    }
  };

  const id = `ai-key-${provider}-${variant}`;
  return (
    <form className="ai-key" onSubmit={(event) => void submit(event)}>
      <label htmlFor={id}>{providerName} API key</label>
      <input
        id={id}
        type="password"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        autoComplete="off"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        inputMode="text"
        placeholder="sk-…"
        disabled={busy}
        data-form-type="other"
      />
      {error && (
        <p role="alert" className={variant === "mobile" ? "m-note-block err" : "alert"}>
          {error}
        </p>
      )}
      <div className="ai-actions">
        <button type="submit" className={variant === "mobile" ? "m-pbtn primary" : "btn primary"} disabled={busy || !value.trim()}>
          {busy ? "Saving…" : submitLabel}
        </button>
        {onCancel && (
          <button type="button" className={variant === "mobile" ? "m-pbtn ghost" : "btn ghost"} onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        )}
      </div>
      <p className="ai-fine">Saved in secure storage on this device. It isn’t shown again, and it is never part of your knowledge, backups or logs.</p>
    </form>
  );
}
