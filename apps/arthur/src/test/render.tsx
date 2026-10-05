import { render } from "@testing-library/react";
import type { ArthurClient } from "../client/arthur-client";
import { createPreviewClient, type PreviewClientOptions } from "../client/preview-client";
import { App } from "../app/App";
import { ArthurProviders } from "../app/providers";
import type { Screen } from "../app/navigation";

export function renderApp(client: ArthurClient, screen: Screen = "home") {
  return render(
    <ArthurProviders client={client} initialScreen={screen}>
      <App />
    </ArthurProviders>,
  );
}

/** The fake model finds nothing to structure: keeps capture tests about capture, not about organizing. */
export const NOTHING: PreviewClientOptions["distillation"] = { candidates: () => [] };

export const TEXT = "I want to improve the Arthur capture screen. Tomorrow I also need to email Ignatov about the competition.";

export const TWO_OBJECTS: PreviewClientOptions["distillation"] = {
  candidates: () => [
    { kind: "idea", title: "Improve capture screen", body: "Improve the Arthur capture screen.", evidence: "improve the Arthur capture screen" },
    { kind: "task", title: "Email Ignatov", body: "Email Ignatov about the competition.", evidence: "email Ignatov about the competition" },
  ],
};

/** A promise you resolve by hand, to hold an operation in flight. */
export function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A client that already holds one capture distilled into the given objects. */
export async function seeded(options: PreviewClientOptions = {}, content = TEXT) {
  const client = createPreviewClient({ distillation: TWO_OBJECTS, ...options });
  const capture = await client.createCapture({ source: "text", content });
  const objects = await client.distillCapture(capture.id);
  return { client, capture, objects };
}

/** Renders the app as a phone sees it. The viewport must already be installed (see test/viewport.ts). */
export const renderMobile = renderApp;
