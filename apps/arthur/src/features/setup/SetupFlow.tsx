import { useEffect, useState } from "react";
import { type AiCapability, type ProviderTestResult } from "@arthur/contracts";
import { Mark } from "../../components/icons";
import { useArthurClient } from "../../hooks/use-arthur-client";
import { useAiConfig } from "./ai-config-context";
import { CAPABILITY_FALLBACK, CAPABILITY_LABEL } from "./ai-copy";
import { TestResult } from "./AiVoiceSettings";
import { KeyForm } from "./KeyForm";
import "./ai.css";

type Step = "welcome" | "connect" | "speech" | "test" | "done";

/**
 * First-run Setup. Nothing in it is mandatory: every step can be skipped, and the closing summary says plainly what works and
 * what does not yet. Finishing (or skipping) records only that Setup was seen; it stores no secret and no consent. Semantic Recall
 * is never switched on here, whatever was connected.
 */
export function SetupFlow() {
  const client = useArthurClient();
  const ai = useAiConfig();
  const [step, setStep] = useState<Step>("welcome");
  const [error, setError] = useState<string | null>(null);
  const mobile = client.kind === "mobile";
  const variant = mobile ? "mobile" : "desktop";
  const btn = mobile ? "m-pbtn" : "btn";
  const voice = client.capabilities.voiceCapture;
  const config = ai.config;
  const provider = config?.providers[0];
  const connected = provider?.hasCredential ?? false;
  const steps: Step[] = voice ? ["welcome", "connect", "speech", "test", "done"] : ["welcome", "connect", "test", "done"];
  const next = () => setStep(steps[Math.min(steps.indexOf(step) + 1, steps.length - 1)] ?? "done");

  const finish = async () => {
    setError(null);
    try {
      await ai.completeSetup();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Setup could not be saved.");
    }
  };

  return (
    <main className={`setup${mobile ? " setup-mobile" : ""}`} aria-labelledby="setup-h" data-step={step}>
      <div className="setup-card">
        <div className="setup-brand">
          <Mark size={28} />
          <b>Arthur</b>
        </div>
        <p className="setup-step" aria-hidden="true">
          {steps.indexOf(step) + 1} of {steps.length}
        </p>

        {step === "welcome" && (
          <>
            <h1 id="setup-h">Welcome to Arthur</h1>
            <p className="setup-lead">Your knowledge stays locally on this device.</p>
            <p>Arthur can connect to an AI provider to organize what you capture, understand your voice and answer questions from your own ideas. None of that is required to start: you can capture by typing right away.</p>
            <div className="ai-actions">
              <button type="button" className={`${btn} primary`} onClick={next}>
                Connect AI
              </button>
              <button type="button" className={`${btn} ghost`} onClick={() => void finish()}>
                Set up later
              </button>
            </div>
          </>
        )}

        {step === "connect" && provider && (
          <>
            <h1 id="setup-h">Connect AI</h1>
            {connected ? (
              <p className="setup-ok" role="status">
                {provider.name} key •••••••• configured
              </p>
            ) : (
              <>
                <p>
                  One {provider.name} key is enough: it serves organizing, Ask Arthur{voice ? ", voice" : ""} and Semantic Recall if you ever turn it on. It is kept in this device’s secure storage and never shown again.
                </p>
                <KeyForm provider={provider.id} providerName={provider.name} variant={variant} submitLabel="Save and continue" onSaved={next} />
              </>
            )}
            <div className="ai-actions">
              {connected && (
                <button type="button" className={`${btn} primary`} onClick={next}>
                  Continue
                </button>
              )}
              {!connected && (
                <button type="button" className={`${btn} ghost`} onClick={next}>
                  Skip for now
                </button>
              )}
            </div>
          </>
        )}

        {step === "speech" && (
          <>
            <h1 id="setup-h">Configure speech</h1>
            <CapabilityLine capability="stt" />
            <p>Voice Capture records, sends the audio for transcription, and keeps only the text. The recording is deleted afterwards.</p>
            <div className="ai-actions">
              <button type="button" className={`${btn} primary`} onClick={next}>
                Continue
              </button>
              {!connected && (
                <button type="button" className={`${btn} ghost`} onClick={() => setStep("connect")}>
                  Back to Connect AI
                </button>
              )}
            </div>
          </>
        )}

        {step === "test" && (
          <>
            <h1 id="setup-h">Test</h1>
            <SetupTests voice={voice} variant={variant} />
            <div className="ai-actions">
              <button type="button" className={`${btn} primary`} onClick={next}>
                Continue
              </button>
            </div>
          </>
        )}

        {step === "done" && (
          <>
            <h1 id="setup-h">Done</h1>
            <ul className="setup-summary">
              <li>Typed Capture is ready.</li>
              <li>
                <CapabilityLine capability="llm" inline />
              </li>
              {voice && (
                <li>
                  <CapabilityLine capability="stt" inline />
                </li>
              )}
              <li>Semantic Recall is off. Turn it on in Settings whenever you want; Recall works by words without it.</li>
            </ul>
            <p className="ai-fine">You can change any of this later in Settings → AI & Voice.</p>
            {error && (
              <p role="alert" className={mobile ? "m-note-block err" : "alert"}>
                {error}
              </p>
            )}
            <div className="ai-actions">
              <button type="button" className={`${btn} primary`} onClick={() => void finish()}>
                Open Arthur
              </button>
            </div>
          </>
        )}
      </div>
    </main>
  );
}

/** One capability in one sentence: what it is, and if it has no key, what that costs. */
function CapabilityLine({ capability, inline = false }: { capability: AiCapability; inline?: boolean }) {
  const ai = useAiConfig();
  const row = ai.config?.capabilities.find((c) => c.capability === capability);
  if (!row) return null;
  const ready = row.status === "ready";
  const text = ready ? `${CAPABILITY_LABEL[capability]} is ready (${row.models[0]}).` : `${CAPABILITY_LABEL[capability]} needs a key. ${CAPABILITY_FALLBACK[capability]}`;
  return inline ? <>{text}</> : <p className={ready ? "setup-ok" : "setup-off"}>{text}</p>;
}

/** Runs the free provider checks for what is connected. Nothing is sent that costs tokens or audio. */
function SetupTests({ voice, variant }: { voice: boolean; variant: "desktop" | "mobile" }) {
  const ai = useAiConfig();
  const [results, setResults] = useState<Partial<Record<AiCapability, ProviderTestResult | "running" | "failed">>>({});
  const targets: AiCapability[] = voice ? ["llm", "stt"] : ["llm"];
  const readyTargets = targets.filter((capability) => ai.isReady(capability));

  useEffect(() => {
    let cancelled = false;
    setResults(Object.fromEntries(readyTargets.map((capability) => [capability, "running" as const])));
    for (const capability of readyTargets) {
      ai.testProvider(capability).then(
        (result) => !cancelled && setResults((current) => ({ ...current, [capability]: result })),
        () => !cancelled && setResults((current) => ({ ...current, [capability]: "failed" })),
      );
    }
    return () => {
      cancelled = true;
    };
    // The checks run once when the step opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (readyTargets.length === 0) {
    return <p>There’s nothing to test yet because no key is connected. You can add one later in Settings → AI & Voice.</p>;
  }
  return (
    <ul className="setup-tests">
      {readyTargets.map((capability) => (
        <li key={capability}>
          <b>{CAPABILITY_LABEL[capability]}</b>
          {results[capability] === "running" || results[capability] === undefined ? <p role="status">Checking…</p> : <TestResult result={results[capability]} variant={variant} />}
        </li>
      ))}
    </ul>
  );
}
