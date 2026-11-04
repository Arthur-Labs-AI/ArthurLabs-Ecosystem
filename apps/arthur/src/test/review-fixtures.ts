import { createPreviewClient, type PreviewEvolutionController } from "../client/preview-client";
import type { ArthurClient } from "../client/arthur-client";

/** A preview client that already holds an idea and a suggestion for it, so the Review screen can be looked at without a model. Development only. */
export function reviewDemoClient(): ArthurClient {
  const controller = {} as PreviewEvolutionController;
  const client = createPreviewClient({
    evolution: { controller, enabled: false },
    distillation: { candidates: (capture) => [{ kind: "idea", title: "Capture screen", body: capture.content.trim(), evidence: capture.content.trim() }] },
  });
  void (async () => {
    const capture = await client.createCapture({ source: "text", content: "Improve the Arthur capture screen." });
    const [idea] = await client.distillCapture(capture.id);
    if (idea) controller.propose({ objectId: idea.id, body: "Improve the Arthur capture screen and make it work offline.", claimTitle: "Offline", claimBody: "It should work offline too." });
  })();
  return client;
}
