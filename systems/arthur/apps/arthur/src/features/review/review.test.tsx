import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { EvolutionError } from "../../client/arthur-client";
import { createPreviewClient, type PreviewEvolutionController } from "../../client/preview-client";
import { renderApp, seeded } from "../../test/render";

const BODY = "Improve the Arthur capture screen.";
const SUGGESTED = "Improve the Arthur capture screen and make it work offline.";

/** A client that holds one idea and one held suggestion for it, as the native pipeline would leave them. */
async function withSuggestion(extra: Partial<Parameters<typeof createPreviewClient>[0]> = {}) {
  const controller = {} as PreviewEvolutionController;
  const { client, objects, capture } = await seeded({ evolution: { controller }, ...extra });
  const idea = objects[0]!;
  const proposal = controller.propose({ objectId: idea.id, body: SUGGESTED, claimTitle: "Offline", claimBody: "It should work offline too." });
  return { client, controller, idea, capture, proposal };
}

const decide = () => screen.getByRole("group", { name: "Decide" });
const button = (name: RegExp | string) => within(decide()).getByRole("button", { name });

describe("Review screen (desktop)", () => {
  it("says plainly that nothing is waiting, and changes nothing", async () => {
    const { client } = await seeded();
    renderApp(client, "review");
    expect(await screen.findByRole("heading", { name: "Nothing is waiting for you" })).toBeTruthy();
    expect(screen.getByText(/Nothing changes until you approve it/)).toBeTruthy();
  });

  it("shows the idea now, the suggested version, what changed, the new note and how it was checked", async () => {
    const { client, proposal } = await withSuggestion();
    renderApp(client, "review");
    const article = await screen.findByRole("article", { name: /Suggestion for Improve capture screen/ });
    expect(within(article).getByText(BODY)).toBeTruthy();
    expect(within(article).getByLabelText("Suggested text").textContent).toBe(SUGGESTED);
    // the change is shown as words, with a text alternative that does not depend on colour
    const changes = within(article).getByLabelText("Changes");
    expect(changes.querySelector("ins")?.textContent).toContain("and make it work offline");
    expect(within(changes).getByText(/added:/)).toBeTruthy();
    expect(within(article).getByText("+5 words")).toBeTruthy();
    // AI authorship and the self-check are never hidden
    expect(within(article).getByText(/Written by Arthur\. Not applied/)).toBeTruthy();
    expect(within(article).getByText("Written by gpt-6-luna")).toBeTruthy();
    expect(within(article).getByText("Same-model self-check")).toBeTruthy();
    expect(within(article).getByText(/self-check, not an independent review/)).toBeTruthy();
    expect(within(article).getByText(/Arthur never changes an idea on its own/)).toBeTruthy();
    expect(within(article).getByText("Suggested addition")).toBeTruthy();
    expect(proposal.state).toBe("open");
    for (const name of ["Approve", /Edit & approve/, "Reject", "Keep as separate idea", "Decide later"]) expect(button(name)).toBeTruthy();
    // the sidebar shows what is waiting
    expect(within(screen.getByRole("navigation", { name: "Primary" })).getByLabelText("1 waiting")).toBeTruthy();
  });

  it("Approve applies the suggestion once, tells the person, and keeps the earlier text in history", async () => {
    const { client, idea } = await withSuggestion();
    const review = vi.spyOn(client, "reviewRevisionProposal");
    renderApp(client, "review");
    await screen.findByRole("article", { name: /Suggestion for/ });
    fireEvent.click(button("Approve"));
    expect(await screen.findByTestId("review-notice")).toBeTruthy();
    expect(screen.getByTestId("review-notice").textContent).toMatch(/Applied/);
    expect(review).toHaveBeenCalledTimes(1);
    expect(review.mock.calls[0]![0]).toMatchObject({ action: "approve", reviewedRevisionId: expect.any(String) });
    const lineage = await client.getObjectLineage(idea.id);
    expect(lineage.revisions.map((r) => r.body)).toEqual([BODY, SUGGESTED]);
    expect((await client.listKnowledgeObjects()).find((o) => o.id === idea.id)?.body).toBe(SUGGESTED);
    expect((await client.listObjectApprovals(idea.id))[0]).toMatchObject({ userEdited: false, verificationMode: "same_family_review" });
    expect(await screen.findByRole("heading", { name: "Nothing is waiting for you" })).toBeTruthy();
  });

  it("Edit & approve records the person's own words as theirs and keeps the AI draft as written", async () => {
    const { client, idea, proposal } = await withSuggestion();
    renderApp(client, "review");
    await screen.findByRole("article", { name: /Suggestion for/ });
    fireEvent.click(button(/Edit & approve/));
    const box = screen.getByLabelText("Your version") as HTMLTextAreaElement;
    expect(box.value).toBe(SUGGESTED);
    const mine = "Improve the Arthur capture screen; offline support comes later.";
    fireEvent.change(box, { target: { value: mine } });
    fireEvent.click(screen.getByRole("button", { name: "Approve my version" }));
    await waitFor(async () => expect((await client.listKnowledgeObjects()).find((o) => o.id === idea.id)?.body).toBe(mine));
    const stored = await client.getRevisionProposal(proposal.id);
    expect(stored).toMatchObject({ state: "approved", userEdited: true, finalBody: mine });
    expect(stored.proposed.body).toBe(SUGGESTED);
    expect((await client.listObjectApprovals(idea.id))[0]?.userEdited).toBe(true);
  });

  it("Approve my version stays disabled until the text is really different from what is there", async () => {
    const { client } = await withSuggestion();
    renderApp(client, "review");
    await screen.findByRole("article", { name: /Suggestion for/ });
    fireEvent.click(button(/Edit & approve/));
    const box = screen.getByLabelText("Your version") as HTMLTextAreaElement;
    fireEvent.change(box, { target: { value: "   " } });
    expect((screen.getByRole("button", { name: "Approve my version" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(box, { target: { value: BODY } });
    expect((screen.getByRole("button", { name: "Approve my version" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Your version")).toBeNull();
  });

  it("an idea edited after the suggestion blocks one-click approval and never overwrites the newer text", async () => {
    const { client, idea } = await withSuggestion();
    const theirs = "Improve the Arthur capture screen, starting with the composer.";
    await client.updateKnowledgeObject(idea.id, { body: theirs });
    renderApp(client, "review");
    const article = await screen.findByRole("article", { name: /Suggestion for/ });
    expect(await within(article).findByTestId("stale-warning")).toBeTruthy();
    expect(within(article).getByText(theirs)).toBeTruthy();
    expect((button("Approve") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Idea changed")).toBeTruthy();
    // the person can still re-review against what is there now
    fireEvent.click(button(/Edit & approve/));
    const mine = `${theirs} It should also work offline.`;
    fireEvent.change(screen.getByLabelText("Your version"), { target: { value: mine } });
    fireEvent.click(screen.getByRole("button", { name: "Approve my version" }));
    await waitFor(async () => expect((await client.listKnowledgeObjects()).find((o) => o.id === idea.id)?.body).toBe(mine));
    const history = (await client.getObjectLineage(idea.id)).revisions.map((r) => r.body);
    expect(history).toEqual([BODY, theirs, mine]);
  });

  it("a refusal from the native layer is shown, the queue is re-read, and nothing is applied", async () => {
    const { client, idea } = await withSuggestion();
    vi.spyOn(client, "reviewRevisionProposal").mockRejectedValue(new EvolutionError("stale", "This idea changed after the suggestion was written. Read the current text and review it again.", "r9"));
    const list = vi.spyOn(client, "listRevisionProposals");
    renderApp(client, "review");
    await screen.findByRole("article", { name: /Suggestion for/ });
    const reads = list.mock.calls.length;
    fireEvent.click(button("Approve"));
    await waitFor(() => expect(screen.getAllByRole("alert").some((a) => /changed after the suggestion/.test(a.textContent ?? ""))).toBe(true));
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(reads));
    expect((await client.listKnowledgeObjects()).find((o) => o.id === idea.id)?.body).toBe(BODY);
  });

  it("Approve cannot be pressed twice: the second press is ignored while the first is in flight", async () => {
    const { client } = await withSuggestion();
    const review = vi.spyOn(client, "reviewRevisionProposal");
    renderApp(client, "review");
    await screen.findByRole("article", { name: /Suggestion for/ });
    const approve = button("Approve");
    fireEvent.click(approve);
    fireEvent.click(approve);
    await screen.findByTestId("review-notice");
    expect(review).toHaveBeenCalledTimes(1);
  });

  it("Reject dismisses only the suggestion: the note stays, visible and undecided", async () => {
    const { client, idea } = await withSuggestion();
    renderApp(client, "review");
    await screen.findByRole("article", { name: /Suggestion for/ });
    fireEvent.click(button("Reject"));
    expect((await screen.findByTestId("review-notice")).textContent).toMatch(/note is kept and still waiting/);
    // the same note is now listed as a waiting note with no suggested text
    const note = await screen.findByRole("article", { name: "Waiting note: Offline" });
    expect(within(note).getByText(/no suggested text for this note/)).toBeTruthy();
    expect((await client.listKnowledgeObjects()).find((o) => o.id === idea.id)?.body).toBe(BODY);
    expect((await client.listUnresolvedClaims()).length).toBe(1);
    expect((await client.listRevisionProposals({ states: ["rejected"] })).length).toBe(1);
  });

  it("Keep as separate idea creates the note's own idea and leaves the existing one alone", async () => {
    const { client, idea } = await withSuggestion();
    const before = (await client.listKnowledgeObjects()).length;
    renderApp(client, "review");
    await screen.findByRole("article", { name: /Suggestion for/ });
    fireEvent.click(button("Keep as separate idea"));
    await screen.findByTestId("review-notice");
    const after = await client.listKnowledgeObjects();
    expect(after.length).toBe(before + 1);
    expect(after.find((o) => o.id === idea.id)?.body).toBe(BODY);
    expect(after.some((o) => o.title === "Offline")).toBe(true);
  });

  it("Decide later moves it to Later without losing it, and Review now brings it back", async () => {
    const { client } = await withSuggestion();
    renderApp(client, "review");
    await screen.findByRole("article", { name: /Suggestion for/ });
    fireEvent.click(button("Decide later"));
    expect(await screen.findByText("Later", { selector: ".rv-chip" })).toBeTruthy();
    expect(within(screen.getByRole("navigation", { name: "Waiting for review" })).getAllByRole("button").length).toBe(1);
    fireEvent.click(button("Review now"));
    await waitFor(() => expect(screen.queryByText("Later", { selector: ".rv-chip" })).toBeNull());
    expect(button("Approve")).toBeTruthy();
  });

  it("a waiting note with no suggestion invents none, and can be kept separate or left for later", async () => {
    const controller = {} as PreviewEvolutionController;
    const { client, objects, capture } = await seeded({ evolution: { controller } });
    controller.holdClaim({ captureId: capture.id, candidateObjectIds: objects.map((o) => o.id), title: "Which one?", body: "It should sync.", reasons: ["ambiguous_target"] });
    renderApp(client, "review");
    const note = await screen.findByRole("article", { name: "Waiting note: Which one?" });
    expect(within(note).getByText(/More than one of your ideas could be the one/)).toBeTruthy();
    expect(within(note).getByText("Improve capture screen")).toBeTruthy();
    expect(within(note).queryByText(/Suggested version/)).toBeNull();
    fireEvent.click(within(note).getByRole("button", { name: "Decide later" }));
    await screen.findByTestId("review-notice");
    expect((await client.listUnresolvedClaims())[0]?.claim.state).toBe("deferred");
    fireEvent.click(await screen.findByRole("button", { name: "Keep as separate idea" }));
    await waitFor(async () => expect((await client.listUnresolvedClaims()).length).toBe(0));
    expect((await client.listKnowledgeObjects()).some((o) => o.title === "Which one?")).toBe(true);
  });

  it("Home says a note is waiting instead of 'nothing to structure', and links to Review", async () => {
    const controller = {} as PreviewEvolutionController;
    const { client, objects, capture } = await seeded({ evolution: { controller }, distillation: { candidates: () => [] } }, "Another thought about the capture screen.");
    expect(objects.length).toBe(0);
    controller.holdClaim({ captureId: capture.id, candidateObjectIds: [], title: "Held", body: "Held note.", reasons: ["review_required"] });
    renderApp(client, "home");
    expect(await screen.findByText(/1 note is waiting for your review/)).toBeTruthy();
    expect(screen.queryByText(/Nothing to structure/)).toBeNull();
    expect(screen.getByText(/1 thing is waiting for your review\. Nothing changes until you decide\./)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: "Review" })[0]!);
    expect(await screen.findByRole("heading", { name: "Review", level: 1 })).toBeTruthy();
  });

  it("nothing is applied by merely opening, listing or selecting suggestions", async () => {
    const { client, idea } = await withSuggestion();
    const review = vi.spyOn(client, "reviewRevisionProposal");
    const update = vi.spyOn(client, "updateKnowledgeObject");
    renderApp(client, "review");
    await screen.findByRole("article", { name: /Suggestion for/ });
    fireEvent.click(button(/Edit & approve/));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(review).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
    expect((await client.listKnowledgeObjects()).find((o) => o.id === idea.id)?.body).toBe(BODY);
  });
});
