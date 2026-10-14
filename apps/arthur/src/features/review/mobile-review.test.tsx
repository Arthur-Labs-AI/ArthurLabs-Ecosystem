import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type PreviewEvolutionController } from "../../client/preview-client";
import { renderMobile, seeded } from "../../test/render";
import { usePhoneViewport } from "../../test/viewport";

const phone = usePhoneViewport(390);
const SUGGESTED = "Improve the Arthur capture screen and make it work offline.";

async function rig() {
  const controller = {} as PreviewEvolutionController;
  const { client, objects } = await seeded({ evolution: { controller } });
  const idea = objects[0]!;
  controller.propose({ objectId: idea.id, body: SUGGESTED, claimTitle: "Offline", claimBody: "It should work offline too." });
  phone.start();
  renderMobile(client, "home");
  return { client, idea, controller };
}

/** Home has two ways in: the one-line notice and the held capture's own link. The notice is the stable one. */
async function openList() {
  const notice = (await screen.findByText(/things? (is|are) waiting for your review/)).closest(".rv-notice") as HTMLElement;
  fireEvent.click(within(notice).getByRole("button", { name: "Review" }));
}

const back = () => act(() => void window.dispatchEvent(new PopStateEvent("popstate")));

describe("Review on a phone", () => {
  it("Home says something is waiting and opens the review list as a page, which Back closes", async () => {
    await rig();
    const notice = await screen.findByText(/1 thing is waiting for your review/);
    fireEvent.click(within(notice.closest(".rv-notice") as HTMLElement).getByRole("button", { name: "Review" }));
    const page = await screen.findByRole("region", { name: "Review" });
    expect(within(page).getByRole("heading", { name: "Review", level: 1 })).toBeTruthy();
    expect(within(page).getByText(/Nothing changes until you approve it/)).toBeTruthy();
    back();
    await waitFor(() => expect(screen.queryByRole("region", { name: "Review" })).toBeNull());
    expect(screen.getByRole("heading", { name: /Your thoughts, expanded/ })).toBeTruthy();
  });

  it("opens one suggestion as its own page with every decision, and Back returns to the list", async () => {
    await rig();
    await openList();
    const list = await screen.findByRole("list", { name: "Waiting for review" });
    fireEvent.click(within(list).getByRole("button", { name: /Improve capture screen/ }));
    const page = await screen.findByRole("region", { name: "Suggestion" });
    const article = within(page).getByRole("article", { name: /Suggestion for/ });
    expect(within(article).getByLabelText("Suggested text").textContent).toBe(SUGGESTED);
    expect(within(article).getByText(/self-check, not an independent review/)).toBeTruthy();
    const group = within(article).getByRole("group", { name: "Decide" });
    for (const name of ["Approve", /Edit & approve/, "Reject", "Keep as separate idea", "Decide later"]) expect(within(group).getByRole("button", { name })).toBeTruthy();
    back();
    await waitFor(() => expect(screen.queryByRole("region", { name: "Suggestion" })).toBeNull());
    expect(screen.getByRole("region", { name: "Review" })).toBeTruthy();
  });

  it("approving applies the suggestion, says so, and Back to review leaves a list without it", async () => {
    const { client, idea } = await rig();
    await openList();
    fireEvent.click(within(await screen.findByRole("list", { name: "Waiting for review" })).getByRole("button", { name: /Improve capture screen/ }));
    const group = await screen.findByRole("group", { name: "Decide" });
    fireEvent.click(within(group).getByRole("button", { name: "Approve" }));
    const done = await screen.findByTestId("review-done");
    expect(within(done).getByRole("status").textContent).toMatch(/Applied/);
    expect((await client.listKnowledgeObjects()).find((o) => o.id === idea.id)?.body).toBe(SUGGESTED);
    fireEvent.click(within(done).getByRole("button", { name: "Back to review" }));
    expect(await screen.findByRole("heading", { name: "Nothing is waiting for you" })).toBeTruthy();
  });

  it("an idea edited meanwhile cannot be approved with one tap on a phone either", async () => {
    const { client, idea } = await rig();
    await client.updateKnowledgeObject(idea.id, { body: "Improve the capture screen, composer first." });
    await openList();
    fireEvent.click(within(await screen.findByRole("list", { name: "Waiting for review" })).getByRole("button", { name: /Improve capture screen/ }));
    expect(await screen.findByTestId("stale-warning")).toBeTruthy();
    expect((within(screen.getByRole("group", { name: "Decide" })).getByRole("button", { name: "Approve" }) as HTMLButtonElement).disabled).toBe(true);
    expect((await client.listKnowledgeObjects()).find((o) => o.id === idea.id)?.body).toBe("Improve the capture screen, composer first.");
  });

  it("reject keeps the note and shows it in the list as waiting with no suggested text", async () => {
    await rig();
    await openList();
    fireEvent.click(within(await screen.findByRole("list", { name: "Waiting for review" })).getByRole("button", { name: /Improve capture screen/ }));
    fireEvent.click(within(await screen.findByRole("group", { name: "Decide" })).getByRole("button", { name: "Reject" }));
    fireEvent.click(await screen.findByRole("button", { name: "Back to review" }));
    const list = await screen.findByRole("list", { name: "Waiting for review" });
    expect(within(list).getByText(/No suggested text/)).toBeTruthy();
  });
});
