import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { KnowledgeObject } from "@arthur/contracts";
import { LineageError, type ArthurClient } from "../../client/arthur-client";
import { createPreviewClient } from "../../client/preview-client";
import { renderApp } from "../../test/render";

const TEXT = "Arthur should organize my ideas automatically.";
const EDITED = "Arthur should organize my ideas automatically and connect related ideas.";
const BRANCHED = "Arthur should organize my ideas automatically without changing the original notes.";
const MERGED = "Arthur should organize my ideas automatically, connect related ideas and leave the original notes unchanged.";

async function seed(): Promise<{ client: ArthurClient; object: KnowledgeObject }> {
  const client = createPreviewClient({ distillation: { candidates: (capture) => [{ kind: "idea", title: "Organize ideas", body: capture.content, evidence: capture.content }] } });
  const capture = await client.createCapture({ source: "text", content: TEXT });
  const [object] = (await client.distillCapture(capture.id)) as [KnowledgeObject];
  return { client, object };
}

const rail = () => screen.getByRole("group", { name: "Revision history" });
const revision = (label: string, current = false) => within(rail()).getByRole("button", { name: `Revision ${label}${current ? " (current)" : ""}` });
const detail = () => screen.getByLabelText("Selected revision");
const headline = () => screen.getByRole("heading", { level: 2, name: "Organize ideas" }).closest(".head") as HTMLElement;
const open = async (client: ArthurClient) => {
  const view = renderApp(client, "evolution");
  await screen.findByRole("group", { name: "Revision history" });
  return view;
};

async function revise(body: string) {
  fireEvent.click(within(headline()).getByRole("button", { name: /^Revise/ }));
  const form = screen.getByRole("form", { name: "Revise this idea" });
  fireEvent.change(within(form).getByLabelText("Body"), { target: { value: body } });
  fireEvent.click(within(form).getByRole("button", { name: "Save revision" }));
}

describe("EvolutionScreen", () => {
  it("guides the user when there is nothing to show", async () => {
    renderApp(createPreviewClient(), "evolution");
    expect(await screen.findByText("No history yet")).toBeTruthy();
  });

  it("shows the initial revision as current, with its original source and no parent", async () => {
    const { client } = await seed();
    await open(client);

    expect(revision("R1", true)).toBeTruthy();
    expect(within(headline()).getByText("R1 is current")).toBeTruthy();
    const panel = within(detail());
    expect(panel.getByRole("heading", { name: "Revision R1" })).toBeTruthy();
    expect(panel.getByText("First capture ·", { exact: false })).toBeTruthy();
    expect(panel.getByText(TEXT, { selector: ".diff div, .diff" })).toBeTruthy();
    expect(panel.getByLabelText("Original capture text").querySelector("mark")?.textContent).toBe(TEXT);
    expect(panel.getByText("Nothing. This is where the idea starts.")).toBeTruthy();
    expect(within(rail()).getByText("First captured")).toBeTruthy();
  });

  it("a revision makes R2 current with R1 as its parent, shows the deterministic diff, and claims no capture source", async () => {
    const { client } = await seed();
    await open(client);

    await revise(EDITED);
    await waitFor(() => expect(revision("R2", true)).toBeTruthy());
    fireEvent.click(revision("R2", true));
    const panel = within(detail());
    expect(panel.getByRole("heading", { name: "Revision R2" })).toBeTruthy();
    expect(panel.getByText("Your edit ·", { exact: false })).toBeTruthy();
    expect(panel.getByLabelText("Body changes").querySelector("ins")?.textContent).toBe(" and connect related ideas");
    expect(panel.getByLabelText("Body changes").querySelector("del")).toBeNull();
    expect(panel.getByText("This text is your edit, so it has no capture source.")).toBeTruthy();
    expect(panel.getByText("Title unchanged")).toBeTruthy();
    expect(within(headline()).getByText("2 revisions · 0 branches · 0 merges ·", { exact: false })).toBeTruthy();
  });

  it("derives each caption from the diff instead of inventing a message", async () => {
    const { client } = await seed();
    await open(client);
    await revise(EDITED);
    await waitFor(() => revision("R2", true));

    const captions = [...rail().querySelectorAll(".l-cap")].map((c) => c.textContent);
    expect(captions).toEqual(["First captured", "+4 −0 words"]);
    expect(rail().textContent).not.toMatch(/Add |Refine|Initial concept/);
  });

  it("refuses a revision that changes nothing and says so", async () => {
    const { client } = await seed();
    const update = vi.spyOn(client, "updateKnowledgeObject");
    await open(client);

    fireEvent.click(within(headline()).getByRole("button", { name: /^Revise/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save revision" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Nothing changed.");
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps the form and reports the problem when saving a revision fails", async () => {
    const { client } = await seed();
    const failing: ArthurClient = { ...client, updateKnowledgeObject: () => Promise.reject(new LineageError("storage_failed", "Could not save the revision. Check disk space.")) };
    await open(failing);

    await revise(EDITED);
    expect((await screen.findByRole("alert")).textContent).toContain("Could not save the revision");
    expect(screen.getByRole("form", { name: "Revise this idea" })).toBeTruthy();
    expect(revision("R1", true)).toBeTruthy();
  });

  it("builds the whole R1 / R2 / R3 / R4 topology: branch from R1, then merge R2 and R3", async () => {
    const { client, object } = await seed();
    await open(client);

    await revise(EDITED); // R2, current
    await waitFor(() => revision("R2", true));

    fireEvent.click(revision("R1"));
    fireEvent.click(within(headline()).getByRole("button", { name: "Branch from R1" }));
    const branchForm = screen.getByRole("form", { name: "Branch from the selected revision" });
    fireEvent.change(within(branchForm).getByLabelText("Body"), { target: { value: BRANCHED } });
    fireEvent.click(within(branchForm).getByRole("button", { name: "Branch from R1" }));
    expect(await screen.findByText("Branch saved. The current revision is unchanged.")).toBeTruthy();
    await waitFor(() => revision("R3"));
    expect(within(headline()).getByText("R2 is current")).toBeTruthy(); // a branch never takes over silently

    fireEvent.click(within(headline()).getByRole("button", { name: /Merge…/ }));
    expect(screen.getByText("Select two or more revisions on the rail to merge them into a new one.")).toBeTruthy();
    fireEvent.click(revision("R2", true));
    fireEvent.click(revision("R3"));
    const mergeForm = screen.getByRole("form", { name: "Merge the selected revisions" });
    fireEvent.change(within(mergeForm).getByLabelText("Body"), { target: { value: MERGED } });
    fireEvent.click(within(mergeForm).getByRole("button", { name: "Merge R2 + R3" }));

    await waitFor(() => expect(revision("R4", true)).toBeTruthy());
    expect(within(headline()).getByText("4 revisions · 1 branch · 1 merge ·", { exact: false })).toBeTruthy();
    expect(within(headline()).getByText("R4 is current")).toBeTruthy();
    expect(within(rail()).getByText("Merged R2 + R3")).toBeTruthy();

    const lineage = await client.getObjectLineage(object.id);
    expect(lineage.revisions.map((r) => [r.origin, r.parentRevisionIds.length])).toEqual([["initial", 0], ["user_edit", 1], ["user_edit", 1], ["merge", 2]]);

    fireEvent.click(revision("R4", true));
    const panel = within(detail());
    expect(panel.getByRole("heading", { name: "Revision R4" })).toBeTruthy();
    expect(panel.getByText("Merged from")).toBeTruthy();
    expect(panel.getByText("Merged text is written by you. Arthur never says it came from a capture.")).toBeTruthy();
    // a merge is compared against each parent in turn
    expect(panel.getByRole("button", { name: "vs R2" })).toBeTruthy();
    fireEvent.click(panel.getByRole("button", { name: "vs R3" }));
    expect(panel.getByText("R3", { selector: "b" })).toBeTruthy();
  });

  it("a merge may keep one parent's text as it is", async () => {
    const { client } = await seed();
    await open(client);
    await revise(EDITED);
    await waitFor(() => revision("R2", true));
    fireEvent.click(revision("R1"));
    fireEvent.click(within(headline()).getByRole("button", { name: "Branch from R1" }));
    const branchForm = screen.getByRole("form", { name: "Branch from the selected revision" });
    fireEvent.change(within(branchForm).getByLabelText("Body"), { target: { value: BRANCHED } });
    fireEvent.click(within(branchForm).getByRole("button", { name: "Branch from R1" }));
    await waitFor(() => revision("R3"));

    fireEvent.click(within(headline()).getByRole("button", { name: /Merge…/ }));
    fireEvent.click(revision("R2", true));
    fireEvent.click(revision("R3"));
    fireEvent.click(within(screen.getByRole("form", { name: "Merge the selected revisions" })).getByRole("button", { name: "Merge R2 + R3" }));

    await waitFor(() => expect(revision("R4", true)).toBeTruthy());
  });

  it("shows the same history after the screen is reopened: state lives in the client, not the component", async () => {
    const { client } = await seed();
    const first = await open(client);
    await revise(EDITED);
    await waitFor(() => revision("R2", true));
    first.unmount();

    await open(client);
    expect(revision("R2", true)).toBeTruthy();
    expect(revision("R1")).toBeTruthy();
  });

  it("a revision updates the idea everywhere, while its original source still resolves to the first capture", async () => {
    const { client } = await seed();
    await open(client);
    fireEvent.click(within(headline()).getByRole("button", { name: /^Revise/ }));
    const form = screen.getByRole("form", { name: "Revise this idea" });
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Organize ideas for me" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save revision" }));
    await screen.findByRole("heading", { name: "Organize ideas for me", level: 2 });

    fireEvent.click(screen.getByRole("button", { name: /^Ideas/ }));
    expect(await screen.findByRole("heading", { name: "Organize ideas for me", level: 2 })).toBeTruthy();
    expect(screen.getByLabelText("Original capture text").querySelector("mark")?.textContent).toBe(TEXT);
  });

  it("graph relations are untouched by revisions and are not shown as revisions", async () => {
    const { client, object } = await seed();
    const other = await client.createCapture({ source: "text", content: "A second thought about ideas." });
    const [second] = await client.distillCapture(other.id);
    await client.createRelation({ kind: "extends", sourceObjectId: object.id, targetObjectId: second!.id });
    const before = await client.listRelations();
    await open(client);

    await revise(EDITED);
    await waitFor(() => revision("R2", true));

    expect(await client.listRelations()).toEqual(before);
    expect(rail().querySelectorAll(".l-node")).toHaveLength(2);
  });

  it("lets you choose which idea's history to read, listing ideas with a real history first", async () => {
    const { client, object } = await seed();
    const other = await client.createCapture({ source: "text", content: "A second thought about ideas." });
    await client.distillCapture(other.id);
    await client.updateKnowledgeObject(object.id, { body: EDITED });
    renderApp(client, "evolution");
    await screen.findByRole("group", { name: "Revision history" });

    const picker = screen.getByRole("navigation", { name: "Ideas with history" });
    const titles = within(picker).getAllByRole("button").map((b) => b.querySelector(".t")?.textContent);
    expect(titles[0]).toBe("Organize ideas");

    fireEvent.click(within(picker).getAllByRole("button")[1]!);
    expect(await screen.findByText("1 revision · 0 branches · 0 merges ·", { exact: false })).toBeTruthy();
  });

  it("offers no 'make current' action: the client cannot do that for an existing revision", async () => {
    const { client } = await seed();
    await open(client);
    await revise(EDITED);
    await waitFor(() => revision("R2", true));
    fireEvent.click(revision("R1"));
    expect(screen.queryByRole("button", { name: /make current|set current|restore|revert/i })).toBeNull();
  });

  it("reports a failure to read a history instead of an empty rail", async () => {
    const { client } = await seed();
    const broken: ArthurClient = { ...client, getObjectLineage: () => Promise.reject(new Error("history is unreadable")) };
    renderApp(broken, "evolution");
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("unreadable"));
    expect(screen.queryByRole("group", { name: "Revision history" })).toBeNull();
  });
});
