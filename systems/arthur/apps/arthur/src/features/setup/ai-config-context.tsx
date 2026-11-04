import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { isCapabilityReady, type AiCapability, type AiConfig, type AiProviderId, type ProviderTestResult } from "@arthur/contracts";
import { useArthurClient } from "../../hooks/use-arthur-client";

export interface AiConfigState {
  /** `loading` until the first read resolves. `error` means the configuration could not be read at all. */
  status: "loading" | "ready" | "error";
  config: AiConfig | null;
  /** Stores the credential. The secret is not kept anywhere in the UI after this resolves. Rejects with a displayable message. */
  setCredential: (provider: AiProviderId, secret: string) => Promise<void>;
  deleteCredential: (provider: AiProviderId) => Promise<void>;
  testProvider: (capability: AiCapability) => Promise<ProviderTestResult>;
  completeSetup: () => Promise<void>;
  /** True only when the configuration is known and the capability has a credential. */
  isReady: (capability: AiCapability) => boolean;
  /** True when the configuration is known and the capability does NOT have one. Unknown is not "unavailable". */
  isUnavailable: (capability: AiCapability) => boolean;
}

const AiConfigContext = createContext<AiConfigState | null>(null);

const messageOf = (failure: unknown): string => (failure instanceof Error ? failure.message : "Something went wrong.");

/**
 * What the native layer says is configured. It holds no secret: the credential is passed straight to `setCredential` and
 * what comes back is a configuration with only "has a credential" flags.
 */
export function AiConfigProvider({ children }: { children: ReactNode }) {
  const client = useArthurClient();
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [status, setStatus] = useState<AiConfigState["status"]>("loading");
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    client.getAiConfig().then(
      (next) => {
        if (!alive.current) return;
        setConfig(next);
        setStatus("ready");
      },
      () => alive.current && setStatus("error"),
    );
    return () => {
      alive.current = false;
    };
  }, [client]);

  const apply = useCallback(async (operation: () => Promise<AiConfig>) => {
    try {
      const next = await operation();
      if (alive.current) {
        setConfig(next);
        setStatus("ready");
      }
    } catch (failure) {
      throw new Error(messageOf(failure));
    }
  }, []);

  const value = useMemo<AiConfigState>(
    () => ({
      status,
      config,
      setCredential: (provider, secret) => apply(() => client.setCredential(provider, secret)),
      deleteCredential: (provider) => apply(() => client.deleteCredential(provider)),
      testProvider: (capability) => client.testProvider(capability),
      completeSetup: () => apply(() => client.completeSetup()),
      isReady: (capability) => isCapabilityReady(config, capability),
      isUnavailable: (capability) => config !== null && !isCapabilityReady(config, capability),
    }),
    [status, config, client, apply],
  );

  return <AiConfigContext.Provider value={value}>{children}</AiConfigContext.Provider>;
}

export function useAiConfig(): AiConfigState {
  const value = useContext(AiConfigContext);
  if (!value) throw new Error("useAiConfig must be used inside <AiConfigProvider>");
  return value;
}

/**
 * Whether Voice Capture can run here: the platform records, and speech recognition has a credential. While the configuration is
 * still being read, the platform's own answer stands, so Speak never flickers away.
 */
export function useVoiceAvailable(): boolean {
  const client = useArthurClient();
  const ai = useContext(AiConfigContext);
  return client.capabilities.voiceCapture && !(ai?.isUnavailable("stt") ?? false);
}
