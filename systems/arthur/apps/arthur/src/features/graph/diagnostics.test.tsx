import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { GraphDiagnostics, GraphDiagnosticsManualRun } from "@arthur/contracts";
import { createPreviewClient } from "../../client/preview-client";
import { createArthurClient } from "../../client";
import type { Invoke } from "../../client/tauri-ipc";
import { NOTHING, renderApp, seeded } from "../../test/render";
import { NOTHING_NEW, describeEmptyInference } from "./inference-message";

const manual = (over: Partial<GraphDiagnosticsManualRun>): GraphDiagnosticsManualRun => ({ outcome: "SUCCESS_NO_NEW_EDGES", considered: 4, proposed: 0, alreadyConnected: 0, verified: 0, rejected: 0, added: 0, providerRequests: 1, at: 1, ...over });
const diagnostics = (over: Partial<GraphDiagnostics> = {}): GraphDiagnostics => ({
  workerActive: true,
  enabled: true,
  diagnosis: { code: "SUCCESS_NO_NEW_EDGES", explanation: "The latest idea was fully processed and Arthur found nothing new to connect it to." },
  totals: { eventsEmitted: 4, eventsReceived: 4, eventsDroppedDisabled: 0, objectsConsidered: 6, candidatePairs: 6, stageAAttempted: 3, stageASucceeded: 3, stageAFailed: 0, stageBAttempted: 0, stageBSucceeded: 0, stageBFailed: 0, contractErrors: 0, proposed: 0, rejected: 0, relationsPersisted: 0, persistFailed: 0, uiUpdatesDelivered: 0 },
  recentRuns: [{ object: "289a8949", reason: "created", outcome: "SUCCESS_NO_NEW_EDGES", detail: null, projectObjects: 3, candidates: 3, stageA: "ok", stageB: "not_run", proposed: 0, verified: 0, survived: 0, rejected: 0, added: 0, removed: 0, at: 1 }],
  lastManual: null,
  ...over,
});

describe("an empty 'Find connections' run says why", () => {
  it("each cause has its own sentence, and none of them is the generic one", () => {
    const sentences = [
      describeEmptyInference(manual({ outcome: "NO_CANDIDATES", considered: 1 })),
      describeEmptyInference(manual({ outcome: "SUCCESS_NO_NEW_EDGES" })),
      describeEmptyInference(manual({ outcome: "SUCCESS_NO_NEW_EDGES", proposed: 2, alreadyConnected: 2 })),
      describeEmptyInference(manual({ outcome: "ALL_REJECTED", proposed: 2, verified: 2, rejected: 2 })),
    ];
    expect(new Set(sentences).size).toBe(4);
    for (const sentence of sentences) expect(sentence).not.toBe(NOTHING_NEW);
    expect(sentences[0]).toMatch(/not enough ideas/);
    expect(sentences[3]).toMatch(/proposed 2 possible connections, but its own checks rejected all of them/);
    // unknown: the legacy sentence, never a wrong specific one
    expect(describeEmptyInference(null)).toBe(NOTHING_NEW);
  });

  it("the Connections screen shows the specific reason from the native diagnostics", async () => {
    const { client } = await seeded();
    vi.spyOn(client, "inferRelations").mockResolvedValue([]);
    vi.spyOn(client, "getGraphIntegrationDiagnostics").mockResolvedValue(diagnostics({ lastManual: manual({ outcome: "ALL_REJECTED", proposed: 1, verified: 1, rejected: 1 }) }));
    renderApp(client, "connections");
    await screen.findByText(/2 ideas/);
    await waitFor(() => expect((screen.getByRole("button", { name: "Find connections" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Find connections" }));
    expect(await screen.findByText(/proposed 1 possible connection, but its own checks rejected all of them/)).toBeTruthy();
    expect(screen.queryByText(NOTHING_NEW)).toBeNull();
  });
});

describe("the diagnostics panel in Settings", () => {
  it("shows the first point of failure and the counts, and reads them only when opened", async () => {
    const client = createPreviewClient({ distillation: NOTHING });
    const read = vi.spyOn(client, "getGraphIntegrationDiagnostics").mockResolvedValue(diagnostics());
    renderApp(client, "settings");
    const panel = (await screen.findByText("What Automatic Connections has done")).closest("details") as HTMLDetailsElement;
    expect(read).not.toHaveBeenCalled();
    panel.open = true;
    fireEvent(panel, new Event("toggle"));
    const verdict = (await waitFor(() => {
      const found = panel.querySelector(".gd-verdict");
      if (!found) throw new Error("no verdict yet");
      return found;
    })) as HTMLElement;
    expect(verdict.textContent).toContain("SUCCESS_NO_NEW_EDGES");
    expect(within(panel).getByText("running")).toBeTruthy();
    expect(within(panel).getByText("4 / 4")).toBeTruthy();
    expect(within(panel).getByText("3 (3 / 0)")).toBeTruthy();
    expect(within(panel).getByRole("list", { name: "Recent runs" }).textContent).toContain("289a8949");
  });

  it("names a provider failure as one, not as 'nothing found'", async () => {
    const client = createPreviewClient({ distillation: NOTHING });
    vi.spyOn(client, "getGraphIntegrationDiagnostics").mockResolvedValue(
      diagnostics({ diagnosis: { code: "PROVIDER_FAILED", explanation: "The AI provider could not be used for the latest idea (see the error code)." }, recentRuns: [{ ...diagnostics().recentRuns[0]!, outcome: "PROVIDER_FAILED", detail: "llm_failed", stageA: "failed" }] }),
    );
    renderApp(client, "settings");
    const panel = (await screen.findByText("What Automatic Connections has done")).closest("details") as HTMLDetailsElement;
    panel.open = true;
    fireEvent(panel, new Event("toggle"));
    await waitFor(() => expect(panel.querySelector(".gd-verdict")?.textContent).toContain("PROVIDER_FAILED"));
    expect(within(panel).getByRole("list", { name: "Recent runs" }).textContent).toContain("llm_failed");
    expect(panel.textContent).not.toMatch(/no new connections found/i);
  });
});

describe("diagnostics over IPC", () => {
  it.each([
    ["mobile", { isTauri: true, tauriPlatform: "android" }],
    ["desktop", { isTauri: true, tauriPlatform: "linux" }],
  ] as const)("the %s client reads them with one argument-free command and rejects a malformed answer", async (_k, env) => {
    const call = vi.fn<Invoke>().mockResolvedValue(diagnostics());
    expect(await createArthurClient(env, call).getGraphIntegrationDiagnostics()).toMatchObject({ diagnosis: { code: "SUCCESS_NO_NEW_EDGES" } });
    expect(call.mock.calls).toEqual([["get_graph_integration_diagnostics"]]);
    await expect(createArthurClient(env, vi.fn<Invoke>().mockResolvedValue({ diagnosis: { code: "SOMETHING_ELSE", explanation: "x" } })).getGraphIntegrationDiagnostics()).rejects.toThrow(/invalid/i);
  });

  it("the preview, which has no worker and no model, says exactly that", async () => {
    const client = createPreviewClient();
    expect((await client.getGraphIntegrationDiagnostics()).diagnosis.code).toBe("DISABLED");
    await client.setGraphIntegrationEnabled(true);
    await waitFor(async () => expect((await client.getGraphIntegrationDiagnostics()).diagnosis.code).toBe("NO_EVENTS_YET"));
  });
});
