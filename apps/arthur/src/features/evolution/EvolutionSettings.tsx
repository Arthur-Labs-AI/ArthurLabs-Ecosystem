import { useState, type FormEvent } from "react";
import type { EvolutionBlocker, EvolutionConsentKind, EvolutionProviderStatus } from "@arthur/contracts";
import { useReview } from "../review/review-context";
import { useEvolutionSettings } from "./use-evolution-status";
import "../review/review.css";

export const EVOLUTION_DESCRIPTION = "When a new note adds to, corrects or replaces an idea you already have, Arthur can write a suggested new version of that idea.";
export const EVOLUTION_MODE = "Review first. Arthur never applies a change on its own: every suggestion waits for your approval.";
export const EVOLUTION_EXPERIMENTAL = "Experimental: suggestions are written and checked by AI and can be wrong. Read each one before you approve it.";

const BLOCKER_TEXT: Record<EvolutionBlocker, string> = {
  typesafe_consent: "Allow TypeSafe to match notes to ideas",
  typesafe_credential: "Add your TypeSafe key",
  llm_credential: "Add your AI provider key in AI & Voice above",
  synthesis_authorization: "Allow your AI provider to write suggestions",
  verification_authorization: "Allow your AI provider to check suggestions",
};

interface PermissionCopy {
  kind: EvolutionConsentKind;
  title: string;
  purpose: string;
}

const PERMISSIONS: PermissionCopy[] = [
  { kind: "typesafe", title: "Match notes to ideas", purpose: "Decides whether a new note belongs to one of your existing ideas." },
  { kind: "synthesis", title: "Write suggestions", purpose: "Writes the suggested new version of an idea." },
  { kind: "verification", title: "Check suggestions", purpose: "Checks a suggestion before it is shown to you. It is the same model family, so it is a self-check, not an independent review." },
];

function PermissionCard({ copy, status, variant, busy, onSet }: { copy: PermissionCopy; status: EvolutionProviderStatus; variant: "desktop" | "mobile"; busy: boolean; onSet: (granted: boolean, version?: string) => Promise<void> }) {
  const [reading, setReading] = useState(false);
  const primary = variant === "mobile" ? "m-pbtn primary" : "btn primary";
  const plain = variant === "mobile" ? "m-pbtn" : "btn";
  const ghost = variant === "mobile" ? "m-pbtn ghost" : "btn ghost";
  const headingId = `evo-perm-${copy.kind}-${variant}`;

  return (
    <div className="evo-perm" role="group" aria-labelledby={headingId} data-granted={status.consented}>
      <h4 id={headingId}>
        {copy.title} <span className="evo-prov">{status.provider}</span> <b className="sr-onoff">{status.consented ? "Allowed" : "Not allowed"}</b>
      </h4>
      <p>{copy.purpose}</p>
      {(reading || !status.consented) && reading && (
        <div className="evo-disclosure">
          <p className="evo-disclosure-h">Before you agree, this is exactly what happens:</p>
          <ul>
            {status.disclosure.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="ai-actions">
        {status.consented ? (
          <button type="button" className={plain} disabled={busy} onClick={() => void onSet(false)}>
            Withdraw permission
          </button>
        ) : reading ? (
          <>
            <button type="button" className={primary} disabled={busy} onClick={() => void onSet(true, status.disclosureVersion).then(() => setReading(false))}>
              I understand — allow {status.provider}
            </button>
            <button type="button" className={ghost} disabled={busy} onClick={() => setReading(false)}>
              Cancel
            </button>
          </>
        ) : (
          <button type="button" className={plain} disabled={busy} onClick={() => setReading(true)}>
            Read and allow…
          </button>
        )}
      </div>
    </div>
  );
}

function TypesafeKey({ variant, has, busy, onSave, onRemove }: { variant: "desktop" | "mobile"; has: boolean; busy: boolean; onSave: (secret: string) => Promise<boolean>; onRemove: () => Promise<void> }) {
  // The key lives in this input only until the native layer has it; it is cleared straight afterwards, success or not.
  const [value, setValue] = useState("");
  const primary = variant === "mobile" ? "m-pbtn primary" : "btn primary";
  const plain = variant === "mobile" ? "m-pbtn" : "btn";
  const id = `evo-ts-key-${variant}`;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!value.trim() || busy) return;
    const secret = value;
    setValue("");
    await onSave(secret);
  };
  return (
    <form className="ai-key" onSubmit={(event) => void submit(event)}>
      <label htmlFor={id}>TypeSafe API key {has && <b className="sr-onoff">Saved</b>}</label>
      <input id={id} type="password" value={value} onChange={(event) => setValue(event.target.value)} autoComplete="off" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder={has ? "Replace the saved key…" : "Paste your TypeSafe key…"} disabled={busy} data-form-type="other" />
      <div className="ai-actions">
        <button type="submit" className={primary} disabled={busy || !value.trim()}>
          {has ? "Replace key" : "Save key"}
        </button>
        {has && (
          <button type="button" className={plain} disabled={busy} onClick={() => void onRemove()}>
            Remove key
          </button>
        )}
      </div>
      <p className="ai-fine">Saved in secure storage on this device, in its own slot. It isn’t shown again and it is never part of your knowledge, backups or logs.</p>
    </form>
  );
}

/**
 * The one place Automatic Thought Evolution is set up. Off by default. It can only be switched on when every permission and key it needs
 * exists; each permission is its own explicit, revocable choice that shows the exact explanation first. Withdrawing one stops new
 * provider requests at once and never deletes what a provider may already hold. Suggestions that already exist stay reviewable.
 */
export function EvolutionSettings({ variant, onOpenReview }: { variant: "desktop" | "mobile"; onOpenReview: () => void }) {
  const settings = useEvolutionSettings();
  const review = useReview();
  const value = settings.value;
  const errorClass = variant === "mobile" ? "m-note-block err" : "alert";
  const note = variant === "mobile" ? "m-note-block" : "note";

  return (
    <div className="ai-auto evo-set" data-variant={variant}>
      <h3>Automatic Thought Evolution</h3>
      <p>{EVOLUTION_DESCRIPTION}</p>
      <p role="note" className="evo-mode">
        {EVOLUTION_MODE}
      </p>
      {settings.status === "loading" && <p role="status">Reading the setting…</p>}
      {settings.status === "error" && (
        <p role="alert" className={errorClass}>
          Could not read the Automatic Thought Evolution setting: {settings.error}
        </p>
      )}
      {value && (
        <>
          <label className="sr-toggle">
            <input type="checkbox" role="switch" checked={value.enabled} disabled={settings.busy || (!value.enabled && !value.ready)} onChange={(event) => void settings.setEnabled(event.target.checked)} />
            <span>Suggest new versions of my ideas</span>
            <b className="sr-onoff">{value.enabled ? "On" : "Off"}</b>
          </label>
          {value.enabled && <p role="note">{EVOLUTION_EXPERIMENTAL}</p>}
          {value.enabled && !value.ready && (
            <p role="alert" className={errorClass}>
              Paused: a permission or key is missing, so nothing is being sent.
            </p>
          )}
          {!value.ready && (
            <div className={note}>
              <div>
                <p>To turn it on you still need to:</p>
                <ul className="evo-todo">
                  {value.blockers.map((blocker) => (
                    <li key={blocker}>{BLOCKER_TEXT[blocker]}</li>
                  ))}
                </ul>
              </div>
            </div>
          )}
          <p className="ai-fine">
            {value.enabled
              ? "New notes are matched to ideas in the background. Suggestions are saved on this device and wait for you in Review. Turning this off keeps them."
              : "Off: nothing is sent for this, and your ideas change only when you edit them."}
          </p>

          <div className="evo-perms">
            {PERMISSIONS.map((copy) => (
              <PermissionCard key={copy.kind} copy={copy} variant={variant} busy={settings.busy} status={copy.kind === "typesafe" ? value.typesafe : copy.kind === "synthesis" ? value.synthesis : value.verification} onSet={(granted, version) => settings.setConsent(copy.kind, granted, version)} />
            ))}
          </div>

          <TypesafeKey variant={variant} has={value.typesafe.hasCredential} busy={settings.busy} onSave={settings.saveTypesafeKey} onRemove={settings.removeTypesafeKey} />
          <p className="ai-fine">
            {value.synthesis.provider}: {value.synthesis.hasCredential ? "the key from AI & Voice above is used." : "no key yet. Add one in AI & Voice above."} Turning a permission off does not delete anything a provider may already hold.
          </p>
          {review.count > 0 && (
            <div className="ai-actions">
              <button type="button" className={variant === "mobile" ? "m-pbtn" : "btn"} onClick={onOpenReview}>
                {review.count} waiting in Review
              </button>
            </div>
          )}
        </>
      )}
      {settings.error && settings.status !== "error" && (
        <p role="alert" className={errorClass}>
          {settings.error}
        </p>
      )}
    </div>
  );
}
