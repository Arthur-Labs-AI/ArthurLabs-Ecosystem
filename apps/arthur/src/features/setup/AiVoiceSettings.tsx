import { useState } from "react";
import { AI_CAPABILITIES, type AiCapability, type AiCapabilityStatus, type AiProviderStatus, type ProviderTestResult } from "@arthur/contracts";
import { useArthurClient } from "../../hooks/use-arthur-client";
import { useSemanticRecall } from "../recall/use-semantic-recall";
import { useAiConfig } from "./ai-config-context";
import { CAPABILITY_FALLBACK, CAPABILITY_LABEL, OUTCOME_DETAIL, OUTCOME_LABEL } from "./ai-copy";
import { KeyForm } from "./KeyForm";
import "./ai.css";

type Variant = "desktop" | "mobile";

/**
 * Settings → AI & Voice. One row per capability: provider, model, status, Change, Test. The credential belongs to the provider
 * account, so Change and Remove act on that account and say which capabilities share it. A saved key is never displayed or
 * reconstructed: only "configured" is shown.
 */
export function AiVoiceSettings({ variant }: { variant: Variant }) {
  const client = useArthurClient();
  const ai = useAiConfig();
  const [editing, setEditing] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [tests, setTests] = useState<Partial<Record<AiCapability, ProviderTestResult | "running" | "failed">>>({});
  const mobile = variant === "mobile";
  const btn = mobile ? "m-pbtn" : "btn";

  if (ai.status === "loading") return <p role="status">Reading the AI settings…</p>;
  if (ai.status === "error" || !ai.config) {
    return (
      <p role="alert" className={mobile ? "m-note-block err" : "alert"}>
        Could not read the AI settings.
      </p>
    );
  }

  const config = ai.config;
  // Voice Capture only exists where the device can record; do not show a row that can never work here.
  const rows = config.capabilities.filter((row) => row.capability !== "stt" || client.capabilities.voiceCapture);
  const providerOf = (row: AiCapabilityStatus): AiProviderStatus | undefined => config.providers.find((p) => p.id === row.provider);

  const runTest = async (capability: AiCapability) => {
    setTests((current) => ({ ...current, [capability]: "running" }));
    try {
      const result = await ai.testProvider(capability);
      setTests((current) => ({ ...current, [capability]: result }));
    } catch {
      setTests((current) => ({ ...current, [capability]: "failed" }));
    }
  };

  const remove = async (providerId: AiProviderStatus["id"]) => {
    setRemoveError(null);
    try {
      await ai.deleteCredential(providerId);
      setTests({});
      setConfirmRemove(null);
    } catch (failure) {
      setRemoveError(failure instanceof Error ? failure.message : "The key could not be removed.");
    }
  };

  return (
    <div className="ai" data-variant={variant}>
      <p className="ai-lead">Your knowledge stays on this device. Arthur uses an AI provider only for the requests below.</p>
      {client.capabilities.voiceCapture && <p>Speech is transcribed by a cloud speech service. The recording is deleted once it has been transcribed; only the text is kept.</p>}
      <p>Organizing a capture, and finding connections, send the text of your captures and ideas to a cloud model.</p>

      {config.providers.map((provider) => {
        const sharing = rows.filter((row) => row.provider === provider.id);
        const open = editing === provider.id;
        return (
          <div className="ai-provider" key={provider.id}>
            <div className="ai-provider-h">
              <b>{provider.name}</b>
              <span className="ai-key-state" data-configured={provider.hasCredential}>
                {provider.hasCredential ? `${provider.name} key •••••••• configured` : `No ${provider.name} key`}
              </span>
            </div>
            {open ? (
              <KeyForm provider={provider.id} providerName={provider.name} variant={variant} submitLabel={provider.hasCredential ? "Replace key" : "Save key"} onSaved={() => { setEditing(null); setTests({}); }} onCancel={() => setEditing(null)} />
            ) : (
              <div className="ai-actions">
                <button type="button" className={btn} onClick={() => setEditing(provider.id)}>
                  {provider.hasCredential ? "Change key" : "Add key"}
                </button>
                {provider.hasCredential && confirmRemove !== provider.id && (
                  <button type="button" className={`${btn} ghost`} onClick={() => setConfirmRemove(provider.id)}>
                    Remove key
                  </button>
                )}
              </div>
            )}
            {confirmRemove === provider.id && (
              <div className="ai-confirm" role="group" aria-label={`Remove the ${provider.name} key`}>
                <p>
                  Remove the {provider.name} key? {sharing.map((row) => CAPABILITY_LABEL[row.capability]).join(", ")} will stop working until you add a key. Your captures and ideas stay exactly as they are.
                </p>
                {removeError && (
                  <p role="alert" className={mobile ? "m-note-block err" : "alert"}>
                    {removeError}
                  </p>
                )}
                <div className="ai-actions">
                  <button type="button" className={`${btn} primary`} onClick={() => void remove(provider.id)}>
                    Remove key
                  </button>
                  <button type="button" className={`${btn} ghost`} onClick={() => setConfirmRemove(null)}>
                    Keep
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      <ul className="ai-rows">
        {AI_CAPABILITIES.map((capability) => rows.find((row) => row.capability === capability)).filter((row): row is AiCapabilityStatus => row !== undefined).map((row) => (
          <CapabilityRow key={row.capability} row={row} provider={providerOf(row)} variant={variant} test={tests[row.capability]} onChange={() => setEditing(row.provider)} onTest={() => void runTest(row.capability)} />
        ))}
      </ul>
    </div>
  );
}

function CapabilityRow({ row, provider, variant, test, onChange, onTest }: { row: AiCapabilityStatus; provider: AiProviderStatus | undefined; variant: Variant; test: ProviderTestResult | "running" | "failed" | undefined; onChange: () => void; onTest: () => void }) {
  const mobile = variant === "mobile";
  const btn = mobile ? "m-pbtn" : "btn";
  const ready = row.status === "ready";
  const label = CAPABILITY_LABEL[row.capability];

  return (
    <li className="ai-row" data-capability={row.capability} data-status={row.status}>
      <div className="ai-row-h">
        <h3>{label}</h3>
        <span className="ai-status" data-ready={ready}>
          {ready ? "Ready" : "Needs a key"}
        </span>
      </div>
      <dl className="ai-kv">
        <dt>Provider</dt>
        <dd>{row.providerName}</dd>
        <dt>Model</dt>
        <dd>{row.models.join(", ")}</dd>
      </dl>
      {row.capability === "embeddings" && <ConsentLine ready={ready} providerName={row.providerName} />}
      {!ready && <p className="ai-fallback">{CAPABILITY_FALLBACK[row.capability]}</p>}
      <div className="ai-actions">
        <button type="button" className={btn} onClick={onChange} aria-label={`Change the ${row.providerName} key used for ${label}`}>
          {provider?.hasCredential ? "Change" : "Add key"}
        </button>
        <button type="button" className={btn} onClick={onTest} disabled={test === "running" || !ready} aria-label={`Test ${label}`}>
          {test === "running" ? "Testing…" : "Test"}
        </button>
      </div>
      <TestResult result={test} variant={variant} />
    </li>
  );
}

/** Semantic Recall is the user's own choice and is never implied by a connection, so the two facts are shown separately. */
function ConsentLine({ ready, providerName }: { ready: boolean; providerName: string }) {
  const { value } = useSemanticRecall();
  const on = value?.enabled ?? false;
  return (
    <p className="ai-consent" role="status">
      {ready ? `${providerName} connected` : `No ${providerName} key`} · Semantic Recall {on ? "On" : "Off"}
      {ready && !on ? ". Connecting doesn’t turn it on; that is its own setting below." : ""}
    </p>
  );
}

export function TestResult({ result, variant }: { result: ProviderTestResult | "running" | "failed" | undefined; variant: Variant }) {
  if (!result || result === "running") return null;
  if (result === "failed") {
    return (
      <p role="alert" className={variant === "mobile" ? "m-note-block err" : "alert"}>
        The test couldn’t run.
      </p>
    );
  }
  const good = result.outcome === "connected";
  return (
    <p role="status" className="ai-result" data-outcome={result.outcome} data-good={good}>
      <b>{OUTCOME_LABEL[result.outcome]}.</b> {OUTCOME_DETAIL[result.outcome]}
    </p>
  );
}
