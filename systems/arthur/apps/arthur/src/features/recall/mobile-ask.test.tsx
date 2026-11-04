import { INBOX_PROJECT_ID, type CognitiveAnswer, type CognitiveQuery } from "@arthur/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ArthurClient } from "../../client/arthur-client";
import { createPreviewClient } from "../../client/preview-client";
import { answer, evidence, paragraph, richAnswer } from "../../test/recall-fixtures";
import { NOTHING, renderMobile, seeded } from "../../test/render";
import { usePhoneViewport } from "../../test/viewport";

const phone = usePhoneViewport(390);

function scripted(result: (query: CognitiveQuery, scope: CognitiveAnswer["scope"]) => CognitiveAnswer) {
  const calls: CognitiveQuery[] = [];
  const client = createPreviewClient({
    distillation: NOTHING,
    recall: {
      answer: (query, scope) => {
        calls.push(query);
        return result(query, scope);
      },
    },
  });
  return { client, calls };
}
const inScope = (result: CognitiveAnswer) => (query: CognitiveQuery, scope: CognitiveAnswer["scope"]) => ({ ...result, query: query.query, scope });
const tabs = () => screen.getByRole("navigation", { name: "Primary" });

async function openAsk(client: ArthurClient) {
  phone.start();
  renderMobile(client);
  fireEvent.click(await screen.findByRole("button", { name: /^Ask about/ }));
  return screen.findByRole("region", { name: "Ask Arthur" });
}
const ask = async (question: string) => {
  const box = await screen.findByRole("textbox", { name: "Your question" });
  fireEvent.change(box, { target: { value: question } });
  fireEvent.click(screen.getByRole("button", { name: "Ask" }));
};

describe("Ask Arthur (mobile)", () => {
  it("is reached from Home without adding a sixth tab, and Back returns to Home", async () => {
    const { client } = scripted(inScope(answer()));
    phone.start();
    renderMobile(client);
    const entry = await screen.findByRole("button", { name: "Ask about Inbox…" });
    expect(within(tabs()).getAllByRole("button").map((b) => b.textContent)).toEqual(["Home", "Ideas", "Capture", "Connections", "Evolution"]);
    fireEvent.click(entry);
    const page = await screen.findByRole("region", { name: "Ask Arthur" });
    expect(within(page).getByRole("heading", { name: "Ask Arthur", level: 1 })).toBeTruthy();
    expect(within(page).getByText(/Active project:/).textContent).toContain("Inbox");
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull(); // a pushed page, like Settings
    fireEvent.click(within(page).getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("button", { name: "Ask about Inbox…" })).toBeTruthy();
    expect(within(tabs()).getAllByRole("button")).toHaveLength(5);
  });

  it("asks with the explicit project scope", async () => {
    const { client, calls } = scripted(inScope(answer()));
    const nexus = await client.createProject("Nexus");
    await client.setActiveProject(nexus.id);
    await openAsk(client);
    await ask("Какво реших за аудиото?");
    await screen.findByRole("heading", { name: "Answer" });
    expect(calls).toEqual([{ query: "Какво реших за аудиото?", scope: { projectId: nexus.id } }]);
    expect(INBOX_PROJECT_ID).not.toBe(nexus.id);
  });

  it("shows the answer with margin references that open the evidence in a sheet, and returns focus afterwards", async () => {
    const { client } = scripted(inScope(richAnswer()));
    await openAsk(client);
    await ask("How did the audio retry change?");
    await screen.findByRole("heading", { name: "Answer" });
    const para = screen.getByText("Today the upload is retried three times.").closest(".ans-para") as HTMLElement;
    const ref = within(para).getByRole("button", { name: /Evidence E1/ });
    ref.focus();
    fireEvent.click(ref);
    const sheet = await screen.findByRole("dialog", { name: "Evidence E1: Retry temporary audio" });
    expect(within(sheet).getByText("Edited since capture")).toBeTruthy();
    expect(within(sheet).getByText("Earlier versions")).toBeTruthy();
    expect(within(sheet).getByText("Branch not adopted")).toBeTruthy();
    fireEvent.click(within(sheet).getByRole("button", { name: "Close Evidence E1: Retry temporary audio" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(ref));
  });

  it("lists the evidence as touch rows, with external projects and historical state in words", async () => {
    const { client } = scripted(inScope(richAnswer()));
    await openAsk(client);
    await ask("q");
    await screen.findByRole("heading", { name: "Answer" });
    const based = screen.getByRole("region", { name: /Based on/ });
    const rows = within(based).getAllByRole("button", { name: /Show details/ });
    expect(rows.length).toBe(3);
    expect(within(based).getByText(/Nexus/, { selector: ".ev-chip" }).textContent).toContain("↗");
    expect(screen.getByText("Current and earlier wording")).toBeTruthy();
    fireEvent.click(within(based).getByRole("button", { name: /^E3, / }));
    const sheet = await screen.findByRole("dialog", { name: /Evidence E3/ });
    expect(within(sheet).getByText("Retry temporary audio related to Gateway timeouts")).toBeTruthy();
    expect(within(sheet).getByText("Contradicts Never retry on cellular")).toBeTruthy();
  });

  it("opens the idea above the result, so Back returns to the answer", async () => {
    const { client, objects } = await (async () => {
      const made = await seeded();
      return made;
    })();
    const result = answer({ evidence: [evidence({ handle: "E1", objectId: objects[0]!.id, title: objects[0]!.title })] });
    const wired: ArthurClient = { ...client, ask: (query) => Promise.resolve({ ...result, query: query.query, scope: { projectId: query.scope.projectId, projectName: "Inbox", archived: false } }) };
    await openAsk(wired);
    await ask("q");
    fireEvent.click(await screen.findByRole("button", { name: /^E1, / }));
    fireEvent.click(await screen.findByRole("button", { name: /^Open idea/ }));
    const idea = await screen.findByRole("region", { name: `Idea: ${objects[0]!.title}` });
    expect(within(idea).getByLabelText("Original capture text")).toBeTruthy();
    // Back closes the idea page and lands on the result, which was kept. (The system Back gesture is covered on a real WebView.)
    fireEvent.click(within(idea).getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("heading", { name: "Answer" })).toBeTruthy();
    expect(screen.getByRole("region", { name: "Ask Arthur" })).toBeTruthy();
  });

  it("insufficient evidence and retrieval-only read differently here too", async () => {
    const { client } = scripted(inScope(answer({ outcome: "insufficient_evidence", answer: null, evidence: [] })));
    await openAsk(client);
    await ask("q");
    expect(await screen.findByText("Arthur couldn’t find enough evidence in Inbox to answer that reliably.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("shows retrieval-only evidence even though no answer could be written", async () => {
    const { client } = scripted(inScope(answer({ outcome: "retrieval_only", answer: null, evidence: [evidence({ title: "Found anyway" })] })));
    await openAsk(client);
    await ask("q");
    expect(await screen.findByRole("heading", { name: "Found related knowledge" })).toBeTruthy();
    expect(screen.getByText("Found anyway")).toBeTruthy();
  });

  it("copes with many evidence items and a long answer", async () => {
    const many = Array.from({ length: 40 }, (_, i) => evidence({ handle: `E${i + 1}`, title: `Idea number ${i + 1} ${"подробности ".repeat(8)}` }));
    const paragraphs = many.slice(0, 12).map((e, i) => paragraph(`Параграф ${i + 1}. ${"Дълъг отговор, който продължава. ".repeat(12)}`, [e.handle]));
    const { client } = scripted(inScope(answer({ answer: { paragraphs, gaps: [] }, evidence: many })));
    await openAsk(client);
    await ask("q");
    await screen.findByRole("heading", { name: "Answer" });
    expect(within(screen.getByRole("region", { name: /Based on/ })).getAllByRole("button", { name: /Show details/ })).toHaveLength(12);
    expect(within(screen.getByRole("region", { name: /Also found/ })).getAllByRole("button", { name: /Show details/ })).toHaveLength(28);
  });

  it("keeps Ask out of the way of root Back: with nothing open, Back is not ours", async () => {
    const { client } = scripted(inScope(answer()));
    phone.start();
    renderMobile(client);
    await screen.findByRole("button", { name: /^Ask about/ });
    const before = window.history.length;
    fireEvent.click(screen.getByRole("button", { name: /^Ask about/ }));
    await screen.findByRole("region", { name: "Ask Arthur" });
    expect(window.history.length).toBe(before + 1);
    fireEvent.click(screen.getByRole("button", { name: "Back" }));
    await screen.findByRole("button", { name: /^Ask about/ });
  });

  it("is reached with Ctrl+K from a narrow desktop window too", async () => {
    const { client } = scripted(inScope(answer()));
    phone.start();
    renderMobile(client);
    await screen.findByRole("button", { name: /^Ask about/ });
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(await screen.findByRole("region", { name: "Ask Arthur" })).toBeTruthy();
  });
});

describe("Ask Arthur (mobile): explicit read-only archived project", () => {
  it("is opened from the project sheet, labelled Archived, asked with its id, and ended by going back", async () => {
    const { client, calls } = scripted((query, scope) => ({ ...answer(), query: query.query, scope }));
    const old = await client.createProject("Old work");
    await client.setActiveProject(INBOX_PROJECT_ID);
    await client.archiveProject(old.id);
    phone.start();
    renderMobile(client);
    fireEvent.click(await screen.findByRole("button", { name: "Project: Inbox. Change project" }));
    const sheet = await screen.findByRole("dialog", { name: "Projects" });
    fireEvent.click(await within(sheet).findByRole("button", { name: "Open Old work read-only" }));
    const page = await screen.findByRole("region", { name: "Ask Arthur" });
    expect(within(page).getByText(/Active project:/).textContent).toContain("Old work");
    expect(within(page).getByText("Archived", { selector: ".ev-chip" })).toBeTruthy();
    expect(within(page).getByText(/Read-only\. Nothing here can be changed\./)).toBeTruthy();
    await ask("what was in it?");
    await screen.findByRole("heading", { name: "Answer" });
    expect(calls).toEqual([{ query: "what was in it?", scope: { projectId: old.id } }]);
    expect((await client.getActiveProject()).id).toBe(INBOX_PROJECT_ID);
    fireEvent.click(within(page).getByRole("button", { name: "Back to Inbox" }));
    await waitFor(() => expect(screen.queryByText(/Read-only\. Nothing/)).toBeNull());
    expect(screen.queryByRole("heading", { name: "Answer" })).toBeNull();
  });
});
