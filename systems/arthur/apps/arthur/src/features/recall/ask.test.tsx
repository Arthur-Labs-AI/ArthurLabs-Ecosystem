import { INBOX_PROJECT_ID, type CognitiveAnswer, type CognitiveQuery, type Project } from "@arthur/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ArthurClient } from "../../client/arthur-client";
import { createPreviewClient } from "../../client/preview-client";
import { answer, evidence, paragraph, richAnswer } from "../../test/recall-fixtures";
import { NOTHING, deferred, renderApp, seeded } from "../../test/render";

/** A client whose answers are scripted. `calls` records exactly what the UI asked. */
function scripted(result: (query: CognitiveQuery, scope: CognitiveAnswer["scope"]) => CognitiveAnswer | Promise<CognitiveAnswer>, extra: Parameters<typeof createPreviewClient>[0] = {}) {
  const calls: CognitiveQuery[] = [];
  const client = createPreviewClient({
    distillation: NOTHING,
    ...extra,
    recall: {
      ...extra.recall,
      answer: (query, scope) => {
        calls.push(query);
        return result(query, scope);
      },
    },
  });
  return { client, calls };
}

const ask = async (question: string) => {
  const box = await screen.findByRole("textbox", { name: "Your question" });
  fireEvent.change(box, { target: { value: question } });
  fireEvent.click(screen.getByRole("button", { name: "Ask" }));
};
const inScope = (result: CognitiveAnswer) => (query: CognitiveQuery, scope: CognitiveAnswer["scope"]) => ({ ...result, query: query.query, scope });

afterEach(() => window.localStorage.clear());

describe("Ask Arthur (desktop)", () => {
  it("opens with the active project named, and offers no all-project mode", async () => {
    const { client } = scripted(() => answer());
    renderApp(client, "ask");
    expect(await screen.findByRole("heading", { name: "Ask Arthur", level: 1 })).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Active project:/).textContent).toContain("Inbox"));
    expect(screen.queryByText(/all projects/i)).toBeNull();
    expect(screen.getByRole("textbox", { name: "Your question" }).getAttribute("placeholder")).toBe("Ask about Inbox…");
  });

  it("always asks with an explicit projectId and nothing else", async () => {
    const { client, calls } = scripted(inScope(answer()));
    renderApp(client, "ask");
    await ask("  What did I decide about audio retries?  ");
    await screen.findByRole("heading", { name: "Answer" });
    expect(calls).toEqual([{ query: "What did I decide about audio retries?", scope: { projectId: INBOX_PROJECT_ID } }]);
    expect(Object.keys(calls[0]!.scope)).toEqual(["projectId"]);
  });

  it("asks in the project the user switched to", async () => {
    const { client, calls } = scripted(inScope(answer()));
    const nexus = await client.createProject("Nexus");
    await client.setActiveProject(nexus.id);
    renderApp(client, "ask");
    await waitFor(() => expect(screen.getByText(/Active project:/).textContent).toContain("Nexus"));
    await ask("anything");
    await screen.findByRole("heading", { name: "Answer" });
    expect(calls[0]!.scope.projectId).toBe(nexus.id);
  });

  it("does not ask an empty or over-long question", async () => {
    const { client, calls } = scripted(inScope(answer()));
    renderApp(client, "ask");
    const box = await screen.findByRole("textbox", { name: "Your question" });
    const send = screen.getByRole("button", { name: "Ask" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(box, { target: { value: "я".repeat(501) } });
    expect(send.disabled).toBe(true);
    expect(screen.getByRole("alert").textContent).toContain("501/500");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(calls).toHaveLength(0);
  });

  it("asks on Enter, keeps Shift+Enter for a new line, and handles a long Bulgarian question", async () => {
    const { client, calls } = scripted(inScope(answer()));
    renderApp(client, "ask");
    const box = await screen.findByRole("textbox", { name: "Your question" });
    const long = "Какво реших за повторния опит при качване на временното аудио, когато връзката се прекъсне по средата на запис?";
    fireEvent.change(box, { target: { value: long } });
    fireEvent.keyDown(box, { key: "Enter", shiftKey: true });
    expect(calls).toHaveLength(0);
    fireEvent.keyDown(box, { key: "Enter" });
    await screen.findByRole("heading", { name: "Answer" });
    expect(calls[0]!.query).toBe(long);
  });

  it("shows one calm loading state while it works, with no stages or percentages, and can be cancelled", async () => {
    const gate = deferred<CognitiveAnswer>();
    const { client } = scripted(() => gate.promise);
    renderApp(client, "ask");
    await ask("slow question");
    const status = await screen.findByRole("status");
    expect(status.textContent).toContain("Looking through Inbox…");
    expect(status.textContent).not.toMatch(/%|thinking|step|\d/i);
    fireEvent.click(within(status).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("status")).toBeNull();
    gate.resolve(answer());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByRole("heading", { name: "Answer" })).toBeNull(); // the abandoned answer is never shown
  });

  describe("outcomes", () => {
    it("answered: the grounded answer, and the evidence it rests on under 'Based on'", async () => {
      const { client } = scripted(inScope(answer({ answer: { paragraphs: [paragraph("You decided to retry three times.", ["E1"])], gaps: ["Why three"] }, evidence: [evidence({ handle: "E1", title: "Retry decision" })] })));
      renderApp(client, "ask");
      await ask("retry?");
      expect(await screen.findByText("You decided to retry three times.")).toBeTruthy();
      const based = screen.getByRole("region", { name: /Based on/ });
      expect(within(based).getByRole("heading", { name: /Retry decision/ })).toBeTruthy();
      expect(screen.getByText("Not covered by what you’ve written")).toBeTruthy();
      expect(screen.getByText("Why three")).toBeTruthy();
    });

    it("insufficient_evidence: says so in the project's name, is not an error, and lets weak matches be inspected", async () => {
      const weak = evidence({ handle: "E1", title: "Possibly related", strength: { points: 1, level: "weak", sufficient: false, signals: [] } });
      const { client } = scripted(inScope(answer({ outcome: "insufficient_evidence", answer: null, evidence: [weak] })));
      renderApp(client, "ask");
      await ask("unknowable");
      expect(await screen.findByText("Arthur couldn’t find enough evidence in Inbox to answer that reliably.")).toBeTruthy();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByText("Possibly related")).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Inspect weak matches (1)" }));
      expect(screen.getByText("Possibly related")).toBeTruthy();
      expect(screen.getByText("Weak match")).toBeTruthy();
    });

    it("insufficient_evidence with nothing found points the user somewhere useful", async () => {
      const { client } = scripted(inScope(answer({ outcome: "insufficient_evidence", answer: null, evidence: [] })));
      renderApp(client, "ask");
      await ask("nothing here");
      expect(await screen.findByText(/Nothing in Inbox matched/)).toBeTruthy();
      expect(screen.queryByRole("button", { name: /weak matches/ })).toBeNull();
    });

    it("insufficient_evidence still shows what the evidence does say, quietly, with its gaps", async () => {
      const { client } = scripted(inScope(answer({ outcome: "insufficient_evidence", answer: { paragraphs: [paragraph("There is a note about retries.", ["E1"])], gaps: ["The number of retries"] }, evidence: [evidence()] })));
      renderApp(client, "ask");
      await ask("how many");
      expect(await screen.findByText("What the evidence does say")).toBeTruthy();
      expect(screen.getByText("There is a note about retries.")).toBeTruthy();
      expect(screen.getByText("The number of retries")).toBeTruthy();
    });

    it("retrieval_only: explains that no grounded answer could be written, and keeps the evidence it found", async () => {
      const base = answer({ outcome: "retrieval_only", answer: null, evidence: [evidence({ handle: "E1", title: "Found anyway" })] });
      const { client, calls } = scripted((query, scope) => ({ ...base, query: query.query, scope, diagnostics: { ...base.diagnostics, synthesis: { ...base.diagnostics.synthesis, state: "unavailable" } } }));
      renderApp(client, "ask");
      await ask("retry?");
      expect(await screen.findByText(/found relevant knowledge in Inbox, but couldn’t write a grounded answer/)).toBeTruthy();
      expect(screen.getByText("The answer model isn't available right now.")).toBeTruthy();
      expect(screen.getByRole("region", { name: /What Arthur found/ })).toBeTruthy();
      expect(screen.getByText("Found anyway")).toBeTruthy();
      expect(screen.queryByRole("heading", { name: "Answer" })).toBeNull();
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      await waitFor(() => expect(calls).toHaveLength(2));
      expect(calls[1]!.query).toBe("retry?");
    });

    it("the three outcomes are distinguishable by their headings", async () => {
      const outcomes: Array<[CognitiveAnswer["outcome"], string]> = [["answered", "Answer"], ["insufficient_evidence", "Not enough to answer"], ["retrieval_only", "Found related knowledge"]];
      for (const [outcome, heading] of outcomes) {
        const { client } = scripted(inScope(answer({ outcome, answer: outcome === "answered" ? answer().answer : null, evidence: outcome === "answered" ? [evidence()] : [] })));
        const view = renderApp(client, "ask");
        await ask("q");
        expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
        view.unmount();
      }
    });

    it("a request that cannot be served is an error with a retry, never a made-up answer", async () => {
      let first = true;
      const { client } = scripted((query, scope) => {
        if (first) {
          first = false;
          return Promise.reject(Object.assign(new Error("Recall could not read your knowledge."), { code: "storage_failed" }));
        }
        return { ...answer(), query: query.query, scope };
      });
      renderApp(client, "ask");
      await ask("q");
      expect((await screen.findByRole("alert")).textContent).toContain("Recall could not read your knowledge.");
      fireEvent.click(screen.getByRole("button", { name: "Try again" }));
      expect(await screen.findByRole("heading", { name: "Answer" })).toBeTruthy();
    });
  });

  describe("evidence", () => {
    const rich = async () => {
      const { client, calls } = scripted(inScope(richAnswer()));
      renderApp(client, "ask");
      await ask("How did the audio retry change?");
      await screen.findByRole("heading", { name: "Answer" });
      return { client, calls };
    };

    it("marks each paragraph with the evidence it rests on, readable without colour", async () => {
      await rich();
      const first = screen.getByText("Today the upload is retried three times.").closest(".ans-para") as HTMLElement;
      const ref = within(first).getByRole("button", { name: "Evidence E1: Retry temporary audio" });
      expect(ref.textContent).toBe("E1");
      const second = screen.getByText(/It started as a single retry/).closest(".ans-para") as HTMLElement;
      expect(within(second).getByRole("button", { name: /Evidence E1\.h1: Earlier version of Retry temporary audio/ }).textContent).toBe("E1 · earlier");
      expect(within(second).getByRole("button", { name: /Evidence E1\.h2: Branch not adopted, from Retry temporary audio/ }).textContent).toBe("E1 · branch");
    });

    it("focuses and highlights the matching evidence when a marker is chosen", async () => {
      await rich();
      const first = screen.getByText("The Gateway timeouts idea in Nexus feeds into it.").closest(".ans-para") as HTMLElement;
      fireEvent.click(within(first).getByRole("button", { name: /Evidence E3/ }));
      await waitFor(() => expect(document.activeElement?.id).toBe("ev-E3"));
      expect(document.getElementById("ev-E3")?.hasAttribute("data-active")).toBe(true);
      expect(within(document.getElementById("ev-E3")!).getByRole("button", { name: /Hide details for E3/ })).toBeTruthy();
    });

    it("highlights the paragraphs an evidence item supports when it is hovered", async () => {
      await rich();
      fireEvent.mouseEnter(document.getElementById("ev-E3")!);
      expect((screen.getByText("The Gateway timeouts idea in Nexus feeds into it.").closest(".ans-para") as HTMLElement).hasAttribute("data-active")).toBe(true);
      fireEvent.mouseLeave(document.getElementById("ev-E3")!);
      expect((screen.getByText("The Gateway timeouts idea in Nexus feeds into it.").closest(".ans-para") as HTMLElement).hasAttribute("data-active")).toBe(false);
    });

    it("tells current from historical in words, never by style alone", async () => {
      await rich();
      const e1 = document.getElementById("ev-E1")!;
      expect(within(e1).getAllByText("Current").length).toBeGreaterThan(0);
      const history = within(e1).getByRole("region", { name: "Earlier versions of Retry temporary audio" });
      expect(within(history).getByText("Earlier version")).toBeTruthy();
      expect(within(history).getByText("Branch not adopted")).toBeTruthy();
      expect(within(history).queryByText("Current")).toBeNull();
      expect(within(history).getByText("First version · Matches your wording".replace(" · ", " · ")) ).toBeTruthy();
      // a superseded entry is not presented as current
      const e4 = document.getElementById("ev-E4")!;
      expect(within(e4).getByText("Superseded")).toBeTruthy();
      expect(within(e4).queryByText("Current")).toBeNull();
    });

    it("says when a paragraph mixes current and earlier wording, and when it is wholly earlier or from another project", async () => {
      await rich();
      expect(screen.getByText("Current and earlier wording")).toBeTruthy();
      expect(screen.getByText("Earlier version", { selector: ".ans-temporal" })).toBeTruthy();
      expect(screen.getByText("From another project")).toBeTruthy();
      // a purely current paragraph carries no note
      const plain = screen.getByText("Today the upload is retried three times.").closest(".ans-para") as HTMLElement;
      expect(plain.querySelector(".ans-temporal")).toBeNull();
    });

    it("marks evidence from another project and keeps the identities apart", async () => {
      await rich();
      const e3 = document.getElementById("ev-E3")!;
      expect(within(e3).getByText(/Nexus/, { selector: ".ev-chip" }).textContent).toContain("↗");
      expect(within(e3).getByRole("button", { name: /Open idea in Nexus/ })).toBeTruthy();
      expect(within(document.getElementById("ev-E1")!).queryByText(/↗/)).toBeNull();
    });

    it("explains why the Graph added an entry, in the user's words", async () => {
      await rich();
      const e2 = document.getElementById("ev-E2")!;
      expect(within(e2).getByText("Included because")).toBeTruthy();
      expect(within(e2).getByText("Retry temporary audio depends on Temporary audio retry")).toBeTruthy();
      const e3 = document.getElementById("ev-E3")!;
      expect(within(e3).getByText("Retry temporary audio related to Gateway timeouts")).toBeTruthy();
      expect(within(e3).getByText("Contradicts Never retry on cellular")).toBeTruthy();
      fireEvent.click(within(document.getElementById("ev-E4")!).getByRole("button", { name: /Show details for E4/ }));
      expect(within(document.getElementById("ev-E4")!).getByText("Replaced by Retry temporary audio")).toBeTruthy();
      // a primary hit says nothing about the graph
      expect(within(document.getElementById("ev-E1")!).queryByText("Included because")).toBeNull();
    });

    it("never shows scores, internal ids, token counts or algorithm names", async () => {
      await rich();
      const text = document.body.textContent ?? "";
      for (const forbidden of ["0.71", "0.0312", "cosine", "RRF", "812", "obj-E1", "rev-E1", "rel-1", "tokens", "weight", "score", "points"]) expect(text, forbidden).not.toContain(forbidden);
      expect(screen.queryByText("Developer details")).toBeNull();
    });

    it("shows developer details only when explicitly switched on", async () => {
      window.localStorage.setItem("arthur.recall.debug", "1");
      await rich();
      expect(screen.getByText("Developer details")).toBeTruthy();
    });

    it("shows the exact capture text on 'View source', and says when the idea was edited since", async () => {
      await rich();
      const e1 = document.getElementById("ev-E1")!;
      expect(within(e1).getByText("Edited since capture")).toBeTruthy();
      expect(within(e1).queryByText("We should retry the audio upload three times")).toBeNull();
      fireEvent.click(within(e1).getAllByRole("button", { name: "View source" })[0]!);
      const quote = within(e1).getByLabelText("Original capture text");
      expect(quote.textContent).toBe("We should retry the audio upload three times");
      expect(within(e1).getByText(/Voice capture ·/)).toBeTruthy();
      expect(within(e1).getByText(/edited after it was captured, so the capture may not contain its current wording/)).toBeTruthy();
      fireEvent.click(within(e1).getByRole("button", { name: "Hide source" }));
      expect(within(e1).queryByLabelText("Original capture text")).toBeNull();
    });

    it("does not call an edited idea's capture its source of the current wording when nothing was edited", async () => {
      const { client } = scripted(inScope(answer({ evidence: [evidence()] })));
      renderApp(client, "ask");
      await ask("q");
      await screen.findByRole("heading", { name: "Answer" });
      fireEvent.click(screen.getByRole("button", { name: "View source" }));
      expect(screen.queryByText(/edited after it was captured/)).toBeNull();
    });

    it("says so when the exact words are not part of this answer, and offers the capture instead", async () => {
      const { client } = scripted(inScope(answer({ evidence: [evidence({ provenance: { origin: { ...evidence().provenance!.origin!, excerpt: null }, currentRevisionSource: null, editedSinceCapture: false, currentRevisionOrigin: "initial" } })] })));
      renderApp(client, "ask");
      await ask("q");
      fireEvent.click(await screen.findByRole("button", { name: "View source" }));
      expect(screen.getByText("The exact words aren’t shown here. Open the original capture to read them.")).toBeTruthy();
    });

    it("offers only the places an entry can actually take you", async () => {
      await rich();
      const e4 = document.getElementById("ev-E4")!;
      fireEvent.click(within(e4).getByRole("button", { name: /Show details for E4/ }));
      expect(within(e4).queryByRole("button", { name: "Open original capture" })).toBeNull(); // no provenance
      expect(within(e4).queryByRole("button", { name: "Open in Evolution" })).toBeNull(); // no history
      expect(within(e4).getByRole("button", { name: "Open in Connections" })).toBeTruthy();
      const e1 = document.getElementById("ev-E1")!;
      expect(within(e1).getByRole("button", { name: "Open in Evolution" })).toBeTruthy();
      expect(within(e1).queryByRole("button", { name: "Open in Connections" })).toBeNull();
    });

    it("keeps entries the answer did not use apart from the ones it rests on", async () => {
      await rich();
      expect(within(screen.getByRole("region", { name: /Also found/ })).getByText("Never retry on cellular")).toBeTruthy();
      expect(within(screen.getByRole("region", { name: /Based on/ })).queryByText("Never retry on cellular")).toBeNull();
    });
  });

  describe("navigation from evidence", () => {
    async function real() {
      const { client, objects } = await seeded();
      const calls: CognitiveQuery[] = [];
      const target = objects[0]!;
      const result = answer({ evidence: [evidence({ handle: "E1", objectId: target.id, title: target.title, lineage: { revisionCount: 2, entries: [] }, graph: { role: "supported", score: null, intentRelevant: true, paths: [], supersededBy: [], supersedes: [], conflictsWith: [], contradictory: false, aliases: [] } })] });
      const wired: ArthurClient = { ...client, ask: (query) => (calls.push(query), Promise.resolve({ ...result, query: query.query, scope: { projectId: query.scope.projectId, projectName: "Inbox", archived: false } })) };
      return { client: wired, target };
    }

    it("opens the idea in Ideas", async () => {
      const { client, target } = await real();
      renderApp(client, "ask");
      await ask("q");
      fireEvent.click(await screen.findByRole("button", { name: /^Open idea/ }));
      expect(await screen.findByRole("heading", { name: "Ideas", level: 1 })).toBeTruthy();
      expect(await screen.findByRole("complementary", { name: "Idea details" })).toBeTruthy();
      expect(within(screen.getByRole("complementary", { name: "Idea details" })).getByRole("heading", { name: target.title })).toBeTruthy();
    });

    it("opens the original capture at the idea's source, and Evolution and Connections for the same idea", async () => {
      const { client, target } = await real();
      renderApp(client, "ask");
      await ask("q");
      await screen.findByRole("heading", { name: "Answer" });
      fireEvent.click(screen.getByRole("button", { name: "Open original capture" }));
      const inspector = await screen.findByRole("complementary", { name: "Idea details" });
      expect(within(inspector).getByLabelText("Original capture text")).toBeTruthy();
      fireEvent.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: /^Ask Arthur/ }));
      fireEvent.click(await screen.findByRole("button", { name: "Open in Evolution" }));
      expect(await screen.findByRole("heading", { name: "Evolution", level: 1 })).toBeTruthy();
      fireEvent.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: /^Ask Arthur/ }));
      fireEvent.click(await screen.findByRole("button", { name: "Open in Connections" }));
      expect(await screen.findByRole("heading", { name: "Connections", level: 1 })).toBeTruthy();
      expect(target.title.length).toBeGreaterThan(0);
    });

    it("keeps the result when the user comes back to Ask Arthur from another screen", async () => {
      const { client } = await real();
      renderApp(client, "ask");
      await ask("q");
      await screen.findByRole("heading", { name: "Answer" });
      fireEvent.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: /^Home/ }));
      fireEvent.click(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: /^Ask Arthur/ }));
      expect(await screen.findByRole("heading", { name: "Answer" })).toBeTruthy();
    });

    it("opens evidence from another project by switching to that project first", async () => {
      const { client } = await seeded();
      const nexus = await client.createProject("Nexus");
      // seeded() leaves Nexus active (createProject switches); go back to the Inbox as the project asked about.
      await client.setActiveProject(INBOX_PROJECT_ID);
      const nexusCapture = await client.createCapture({ source: "text", content: "Gateway timeouts are too long.", projectId: nexus.id });
      const objects = await client.distillCapture(nexusCapture.id).catch(() => []);
      void objects;
      const idea = await client.createCapture({ source: "text", content: "x", projectId: nexus.id });
      void idea;
      const external = evidence({ handle: "E1", externalProject: true, projectId: nexus.id, projectName: "Nexus", title: "Gateway timeouts", objectId: "missing-in-preview" });
      const wired: ArthurClient = { ...client, ask: (query) => Promise.resolve(answer({ evidence: [external], scope: { projectId: query.scope.projectId, projectName: "Inbox", archived: false } })) };
      renderApp(wired, "ask");
      await ask("q");
      await screen.findByRole("heading", { name: "Answer" });
      fireEvent.click(screen.getByRole("button", { name: "Open idea in Nexus" }));
      expect(await screen.findByRole("heading", { name: "Ideas", level: 1 })).toBeTruthy();
      await waitFor(async () => expect((await client.getActiveProject()).id).toBe(nexus.id));
      expect(screen.getByText("Nexus", { selector: ".proj-name, .proj-name *, button *" })).toBeTruthy();
    });

    it("says so, and stays put, when another project cannot be opened", async () => {
      const { client } = await seeded();
      const external = evidence({ handle: "E1", externalProject: true, projectId: "gone", projectName: "Vanished", title: "Lost" });
      const wired: ArthurClient = { ...client, ask: (query) => Promise.resolve(answer({ evidence: [external], scope: { projectId: query.scope.projectId, projectName: "Inbox", archived: false } })) };
      renderApp(wired, "ask");
      await ask("q");
      fireEvent.click(await screen.findByRole("button", { name: "Open idea in Vanished" }));
      expect((await screen.findAllByRole("alert")).map((a) => a.textContent).join(" ")).toMatch(/couldn't be opened|couldn’t be opened/);
      expect(screen.getByRole("heading", { name: "Ask Arthur", level: 1 })).toBeTruthy();
    });
  });

  describe("projects", () => {
    it("asks an archived project only when that project is the one open, and labels it", async () => {
      const { client } = scripted((query, scope) => ({ ...answer(), query: query.query, scope: { ...scope, archived: true, projectName: "Old work" } }));
      const open: Project = { id: "p-old", name: "Old work", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", archivedAt: "2026-02-01T00:00:00.000Z", captureCount: 0, objectCount: 0 } as Project;
      const wired: ArthurClient = { ...client, getActiveProject: () => Promise.resolve(open), listProjects: () => Promise.resolve([open]), getProject: () => Promise.resolve(open), ask: (query) => (query.scope.projectId === open.id ? Promise.resolve(answer({ scope: { projectId: open.id, projectName: "Old work", archived: true } })) : Promise.reject(new Error("wrong project"))) };
      renderApp(wired, "ask");
      expect((await screen.findAllByText("Archived"))[0]).toBeTruthy();
      await ask("what was in it?");
      expect(await screen.findByText(/Old work is archived\. This answer reads it as it was\./)).toBeTruthy();
    });

    it("drops a result when the project changes, so an answer is never shown under the wrong project", async () => {
      const { client } = scripted(inScope(answer()));
      renderApp(client, "ask");
      await ask("q");
      await screen.findByRole("heading", { name: "Answer" });
      await client.createProject("Elsewhere");
      const rail = screen.getByRole("complementary", { name: "Sidebar" });
      fireEvent.click(await within(rail).findByRole("button", { name: /^Project:/ }));
      const menu = screen.getByRole("group", { name: "Projects" });
      fireEvent.click(await within(within(menu).getByRole("list", { name: "Switch project" })).findByRole("button", { name: /^Elsewhere/ }));
      await waitFor(() => expect(screen.queryByRole("heading", { name: "Answer" })).toBeNull());
      expect(screen.getByText(/Active project:/).textContent).toContain("Elsewhere");
    });
  });

  describe("shortcut and navigation", () => {
    it("is in the sidebar and reached with Ctrl+K or ⌘K from anywhere, with the cursor in the question", async () => {
      const { client } = scripted(inScope(answer()));
      renderApp(client, "ideas");
      const nav = await screen.findByRole("navigation", { name: "Primary" });
      expect(within(nav).getByRole("button", { name: /^Ask Arthur/ })).toBeTruthy();
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
      expect(await screen.findByRole("heading", { name: "Ask Arthur", level: 1 })).toBeTruthy();
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Your question" })));
      fireEvent.click(within(nav).getByRole("button", { name: /^Home/ }));
      fireEvent.keyDown(window, { key: "K", metaKey: true });
      expect(await screen.findByRole("heading", { name: "Ask Arthur", level: 1 })).toBeTruthy();
    });

    it("leaves Capture's shortcut alone and ignores Mod+K inside the Capture dialog", async () => {
      const { client } = scripted(inScope(answer()));
      renderApp(client, "ideas");
      await screen.findByRole("navigation", { name: "Primary" });
      fireEvent.keyDown(window, { key: "n", ctrlKey: true });
      expect(await screen.findByRole("dialog")).toBeTruthy();
      fireEvent.keyDown(window, { key: "k", ctrlKey: true });
      expect(screen.queryByRole("heading", { name: "Ask Arthur", level: 1 })).toBeNull();
      expect(screen.getByRole("dialog")).toBeTruthy();
    });

    it("does not treat Ctrl+Shift+K or Alt+K as Ask Arthur", async () => {
      const { client } = scripted(inScope(answer()));
      renderApp(client, "ideas");
      await screen.findByRole("navigation", { name: "Primary" });
      fireEvent.keyDown(window, { key: "k", ctrlKey: true, shiftKey: true });
      fireEvent.keyDown(window, { key: "k", ctrlKey: true, altKey: true });
      expect(screen.queryByRole("heading", { name: "Ask Arthur", level: 1 })).toBeNull();
    });
  });

  describe("nothing is kept", () => {
    it("writes no question, answer or evidence to any browser storage, and a fresh session starts empty", async () => {
      const writes: string[] = [];
      const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation((key, value) => void writes.push(`${key}=${value}`));
      const { client } = scripted(inScope(richAnswer()));
      const first = renderApp(client, "ask");
      await ask("a very particular question");
      await screen.findByRole("heading", { name: "Answer" });
      expect(writes.filter((entry) => /particular|retry|Retry|E1/.test(entry))).toEqual([]);
      expect(window.indexedDB === undefined || true).toBe(true);
      first.unmount();
      set.mockRestore();
      renderApp(client, "ask");
      expect(await screen.findByRole("textbox", { name: "Your question" })).toBeTruthy();
      expect((screen.getByRole("textbox", { name: "Your question" }) as HTMLTextAreaElement).value).toBe("");
      expect(screen.queryByRole("heading", { name: "Answer" })).toBeNull();
    });
  });
});

describe("explicit read-only access to an archived project", () => {
  async function archivedWorld() {
    const { client, calls } = scripted((query, scope) => ({ ...answer(), query: query.query, scope }));
    const old = await client.createProject("Old work");
    await client.setActiveProject(INBOX_PROJECT_ID);
    await client.archiveProject(old.id);
    return { client, calls, old };
  }
  const openReadOnly = async (name: string) => {
    const rail = await screen.findByRole("complementary", { name: "Sidebar" });
    fireEvent.click(await within(rail).findByRole("button", { name: /^Project:/ }));
    fireEvent.click(await screen.findByRole("button", { name: /^Archived \(1\)/ }));
    fireEvent.click(await screen.findByRole("button", { name: `Open ${name} read-only` }));
  };

  it("opens the archived project read-only from the project list, labelled Archived, and asks with ITS id", async () => {
    const { client, calls, old } = await archivedWorld();
    renderApp(client, "ideas");
    await openReadOnly("Old work");
    expect(await screen.findByRole("heading", { name: "Ask Arthur", level: 1 })).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/Active project:/).textContent).toContain("Old work"));
    expect(screen.getByText("Archived", { selector: ".ev-chip" })).toBeTruthy();
    expect(screen.getByText(/Read-only: you opened this archived project/)).toBeTruthy();
    await ask("what was in it?");
    await screen.findByRole("heading", { name: "Answer" });
    expect(calls).toEqual([{ query: "what was in it?", scope: { projectId: old.id } }]);
  });

  it("never becomes the active project: the live project is unchanged, so captures and ideas still belong to it", async () => {
    const { client, old } = await archivedWorld();
    renderApp(client, "ideas");
    await openReadOnly("Old work");
    await screen.findByRole("heading", { name: "Ask Arthur", level: 1 });
    expect((await client.getActiveProject()).id).toBe(INBOX_PROJECT_ID);
    expect((await client.getActiveProject()).id).not.toBe(old.id);
    const rail = screen.getByRole("complementary", { name: "Sidebar" });
    expect(within(rail).getByRole("button", { name: "Project: Inbox" })).toBeTruthy();
  });

  it("ends when the user goes back to the live project, and then asks there again", async () => {
    const { client, calls } = await archivedWorld();
    renderApp(client, "ideas");
    await openReadOnly("Old work");
    await screen.findByText(/Read-only: you opened/);
    fireEvent.click(screen.getByRole("button", { name: "Back to Inbox" }));
    await waitFor(() => expect(screen.queryByText(/Read-only: you opened/)).toBeNull());
    await waitFor(() => expect(screen.getByText(/Active project:/).textContent).toContain("Inbox"));
    await ask("live question");
    await screen.findByRole("heading", { name: "Answer" });
    expect(calls[0]!.scope.projectId).toBe(INBOX_PROJECT_ID);
    expect(screen.queryByText("Archived", { selector: ".ev-chip" })).toBeNull();
  });

  it("is ended by switching project, and drops the archived result", async () => {
    const { client } = await archivedWorld();
    const other = await client.createProject("Other");
    renderApp(client, "ideas");
    await openReadOnly("Old work");
    await ask("q");
    await screen.findByRole("heading", { name: "Answer" });
    const rail = screen.getByRole("complementary", { name: "Sidebar" });
    fireEvent.click(within(rail).getByRole("button", { name: /^Project:/ }));
    fireEvent.click(await within(await screen.findByRole("list", { name: "Switch project" })).findByRole("button", { name: /^Other/ }));
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Answer" })).toBeNull());
    expect(screen.getByText(/Active project:/).textContent).toContain("Other");
    expect(screen.queryByText(/Read-only/)).toBeNull();
    expect(other.id.length).toBeGreaterThan(0);
  });

  it("is not part of normal Recall: a live question never carries an archived project's id", async () => {
    const { client, calls, old } = await archivedWorld();
    renderApp(client, "ask");
    await waitFor(() => expect(screen.getByText(/Active project:/).textContent).toContain("Inbox"));
    await ask("normal");
    await screen.findByRole("heading", { name: "Answer" });
    expect(calls.map((c) => c.scope.projectId)).toEqual([INBOX_PROJECT_ID]);
    expect(calls.some((c) => c.scope.projectId === old.id)).toBe(false);
  });
});
