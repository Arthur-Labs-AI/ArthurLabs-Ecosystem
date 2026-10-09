import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type PreviewEvolutionController } from "../../client/preview-client";
import { renderApp, renderMobile, seeded } from "../../test/render";
import { usePhoneViewport } from "../../test/viewport";

const phone = usePhoneViewport(390);
const BODY = "Improve the Arthur capture screen.";
const SUGGESTED = "Improve the Arthur capture screen and make it work offline.";

async function approved(edited = false) {
  const controller = {} as PreviewEvolutionController;
  const { client, objects } = await seeded({ evolution: { controller } });
  const idea = objects[0]!;
  const proposal = controller.propose({ objectId: idea.id, body: SUGGESTED });
  const text = edited ? "Improve the Arthur capture screen; offline later." : undefined;
  await client.reviewRevisionProposal({ proposalId: proposal.id, action: edited ? "edit_approve" : "approve", reviewedRevisionId: proposal.baseRevisionId, ...(text ? { editedBody: text } : {}) });
  return { client, idea, text };
}

describe("history shows who made a change, and Undo adds a revision instead of rewriting", () => {
  it("labels an approved suggestion as approved by the person, and edited wording as theirs", async () => {
    const plain = await approved(false);
    renderApp(plain.client, "evolution");
    fireEvent.click(await screen.findByRole("button", { name: /Improve capture screen/ }));
    expect(await screen.findByText(/Suggested by Arthur · approved by you/)).toBeTruthy();
    expect(screen.queryByText(/Created by Arthur/)).toBeNull();
    // the source note says who wrote the words, and does not call them the person's edit
    expect(screen.getByText(/Arthur drafted these words and you approved them as written/)).toBeTruthy();
    expect(screen.queryByText(/This text is your edit/)).toBeNull();
  });

  it("labels edited wording as the person's own", async () => {
    const edited = await approved(true);
    renderApp(edited.client, "evolution");
    fireEvent.click(await screen.findByRole("button", { name: /Improve capture screen/ }));
    expect(await screen.findByText(/your wording, approved by you/)).toBeTruthy();
    // a person's wording is never described as AI-authored, and an AI draft is never described as the person's text
    expect(screen.getByText(/You wrote these words when you approved/)).toBeTruthy();
    expect(screen.queryByText(/Arthur drafted these words/)).toBeNull();
  });

  it("Undo brings the earlier text back as a NEW revision with both parents and deletes nothing", async () => {
    const { client, idea } = await approved(false);
    renderApp(client, "evolution");
    fireEvent.click(await screen.findByRole("button", { name: /Improve capture screen/ }));
    await screen.findByText(/Suggested by Arthur · approved by you/);
    // select the first revision on the rail, then undo to it
    fireEvent.click(screen.getByRole("button", { name: "Revision R1" }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo to R1" }));
    await waitFor(async () => expect((await client.getObjectLineage(idea.id)).revisions.length).toBe(3));
    const lineage = await client.getObjectLineage(idea.id);
    const restored = lineage.revisions[2]!;
    expect(restored.body).toBe(BODY);
    expect(restored.origin).toBe("merge");
    expect(restored.parentRevisionIds).toHaveLength(2);
    expect(lineage.currentRevisionId).toBe(restored.id);
    expect(lineage.revisions.map((r) => r.body).slice(0, 2)).toEqual([BODY, SUGGESTED]);
    expect((await client.listKnowledgeObjects()).find((o) => o.id === idea.id)?.body).toBe(BODY);
    expect(await screen.findByText(/Nothing was deleted/)).toBeTruthy();
    // the approved revision is no longer current, and the rail still says a person approved it
    expect(within(screen.getByRole("group", { name: "Revision history" })).getByText("approved by you")).toBeTruthy();
  });

  it("Undo is not offered for the revision that is already current", async () => {
    const { client } = await approved(false);
    renderApp(client, "evolution");
    fireEvent.click(await screen.findByRole("button", { name: /Improve capture screen/ }));
    await screen.findByText(/Suggested by Arthur · approved by you/);
    expect(screen.queryByRole("button", { name: /^Undo to/ })).toBeNull();
  });

  it("on a phone the same history is labelled and can be undone", async () => {
    const { client, idea } = await approved(false);
    phone.start();
    renderMobile(client, "evolution");
    fireEvent.click(await screen.findByRole("button", { name: /Improve capture screen/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Revision R2, Suggested by Arthur · approved by you, current/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Revision R1/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Undo to R1" }));
    await waitFor(async () => expect((await client.getObjectLineage(idea.id)).revisions.length).toBe(3));
    expect((await client.listKnowledgeObjects()).find((o) => o.id === idea.id)?.body).toBe(BODY);
    await act(async () => undefined);
    expect(within(document.body).queryByText(/Created by Arthur/)).toBeNull();
  });
});
