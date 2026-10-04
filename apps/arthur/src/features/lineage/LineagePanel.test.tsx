import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { KnowledgeObject } from "@arthur/contracts";
import { ArthurProviders } from "../../app/providers";
import type { ArthurClient } from "../../client/arthur-client";
import { createPreviewClient } from "../../client/preview-client";
import { GraphPanel } from "../graph/GraphPanel";
import { KnowledgePanel } from "../knowledge/KnowledgePanel";
import { LineagePanel } from "./LineagePanel";

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

function mount(client: ArthurClient, extra = false) {
  return render(
    <ArthurProviders client={client}>
      {extra && <KnowledgePanel />}
      <LineagePanel />
      {extra && <GraphPanel />}
    </ArthurProviders>,
  );
}

const selectedPanel = () => screen.getByLabelText("Selected revision");
const listText = () => within(screen.getByLabelText("Revisions")).getAllByRole("listitem").map((item) => item.textContent?.replace(/\s+/g, " ").trim());

async function save(form: string, button: string, body?: string) {
  const element = screen.getByRole("form", { name: form });
  if (body !== undefined) fireEvent.change(within(element).getByLabelText("Body"), { target: { value: body } });
  fireEvent.click(within(element).getByRole("button", { name: button }));
}

describe("LineagePanel", () => {
  it("guides the user when there is nothing to show", async () => {
    mount(createPreviewClient());
    expect(await screen.findByText(/Distill a capture to create a knowledge object/)).toBeTruthy();
  });

  it("shows the initial revision as current, with its original source and no parent", async () => {
    const { client } = await seed();
    mount(client);

    expect(await screen.findByRole("button", { name: "Revision R1 (current)" })).toBeTruthy();
    expect(listText()).toEqual(["R1 · Initial revision · current"]);
    const details = selectedPanel();
    expect(within(details).getByText("Revision R1 (current)")).toBeTruthy();
    expect(within(details).getByText("Organize ideas")).toBeTruthy();
    expect(within(details).getByText(TEXT)).toBeTruthy();
    expect(within(details).getByText(/^Source: capture [0-9a-f-]{8} · characters 0–46$/)).toBeTruthy();
    expect(within(details).getByText("No parent: this is where the history starts.")).toBeTruthy();
  });

  it("an edit makes R2 current with R1 as its parent, shows the deterministic diff, and claims no capture source", async () => {
    const { client } = await seed();
    mount(client);
    await screen.findByRole("button", { name: "Revision R1 (current)" });

    await save("Edit this thought", "Save as new revision", EDITED);

    expect(await screen.findByText("New revision saved.")).toBeTruthy();
    expect(listText()).toEqual(["R1 · Initial revision", "R2 · Edited by you · current from R1"]);
    expect(screen.getByRole("button", { name: "Revision R2 (current)" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Revision R1" })).toBeTruthy();
    const details = selectedPanel();
    expect(within(details).getByText("Parents: R1")).toBeTruthy();
    expect(within(details).getByText("No direct Capture source: this text was written in an edit, not interpreted from a Capture.")).toBeTruthy();
    const diff = await within(details).findByLabelText("Changes from R1 to R2");
    expect(within(diff).getByLabelText("Body changes").querySelector("ins")?.textContent).toBe(" and connect related ideas");
    expect(within(diff).getByText("Title unchanged.")).toBeTruthy();
    expect(within(diff).getByText("Kind unchanged.")).toBeTruthy();
  });

  it("refuses an edit that changes nothing and says so", async () => {
    const { client } = await seed();
    mount(client);
    await screen.findByRole("button", { name: "Revision R1 (current)" });

    fireEvent.click(within(screen.getByRole("form", { name: "Edit this thought" })).getByRole("button", { name: "Save as new revision" }));

    expect(await screen.findByText("Nothing changed.")).toBeTruthy();
    expect((await client.listRevisions((await client.listKnowledgeObjects())[0]?.id as string)).length).toBe(1);
  });

  it("builds the whole R1 / R2 / R3 / R4 topology: branch from R1, then merge R2 and R3", async () => {
    const { client, object } = await seed();
    const { container } = mount(client);
    await screen.findByRole("button", { name: "Revision R1 (current)" });
    await save("Edit this thought", "Save as new revision", EDITED);
    await screen.findByRole("button", { name: "Revision R2 (current)" });

    // Branch from the ORIGINAL revision.
    fireEvent.click(screen.getByRole("button", { name: /^R1 · Initial revision/ }));
    await waitFor(() => expect(within(selectedPanel()).getByText("Revision R1")).toBeTruthy());
    await save("Branch from the selected revision", "Branch from R1", BRANCHED);
    expect(await screen.findByText("Branch saved. The current revision is unchanged.")).toBeTruthy();

    expect(listText()).toEqual(["R1 · Initial revision", "R2 · Edited by you · current from R1", "R3 · Edited by you from R1"]);
    expect(screen.getByRole("button", { name: "Revision R2 (current)" }), "creating the branch did not replace R2").toBeTruthy();
    expect((await client.getObjectLineage(object.id)).revisions[1]?.body).toBe(EDITED);

    // Merge R2 and R3.
    fireEvent.click(screen.getByRole("checkbox", { name: "Merge R2" }));
    expect(screen.getByText(/Tick two or more revisions/)).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: "Merge R3" }));
    await save("Merge the ticked revisions", "Merge R2 + R3", MERGED);
    expect(await screen.findByText("Merge saved.")).toBeTruthy();

    expect(listText()).toEqual(["R1 · Initial revision", "R2 · Edited by you from R1", "R3 · Edited by you from R1", "R4 · Merge · current from R2 + R3"]);
    expect(screen.getByRole("button", { name: "Revision R4 (current)" })).toBeTruthy();
    // Four nodes, and exactly four parent arrows: R1>R2, R1>R3, R2>R4, R3>R4.
    expect(container.querySelectorAll(".lineage-node")).toHaveLength(4);
    expect(container.querySelectorAll(".lineage-edge")).toHaveLength(4);
    expect(container.querySelectorAll(".lineage-node.current")).toHaveLength(1);
    const lineage = await client.getObjectLineage(object.id);
    const [r1, r2, r3, r4] = lineage.revisions;
    expect(r4?.parentRevisionIds).toEqual([r2?.id, r3?.id]);
    expect(r3?.parentRevisionIds).toEqual([r1?.id]);
    expect(lineage.currentRevisionId).toBe(r4?.id);
    // Selecting the merge shows both parents, and a diff against each.
    fireEvent.click(screen.getByRole("button", { name: /^R4 · Merge/ }));
    const details = selectedPanel();
    expect(within(details).getByText("Parents: R2, R3")).toBeTruthy();
    expect(await within(details).findByLabelText("Changes from R2 to R4")).toBeTruthy();
    expect(within(details).getByLabelText("Changes from R3 to R4")).toBeTruthy();
    expect(within(details).getByText("No direct Capture source: this text was written in an edit, not interpreted from a Capture.")).toBeTruthy();
  });

  it("shows the same history after the panel is reopened: state lives in the client, not the component", async () => {
    const { client } = await seed();
    const first = mount(client);
    await screen.findByRole("button", { name: "Revision R1 (current)" });
    await save("Edit this thought", "Save as new revision", EDITED);
    await screen.findByRole("button", { name: "Revision R2 (current)" });
    const before = listText();
    first.unmount();

    mount(client);
    await screen.findByRole("button", { name: "Revision R2 (current)" });
    expect(listText()).toEqual(before);
  });

  it("an edit updates the object in the Knowledge panel, whose original source still resolves to the first capture", async () => {
    const { client } = await seed();
    mount(client, true);
    await screen.findByRole("button", { name: "Revision R1 (current)" });

    await save("Edit this thought", "Save as new revision", EDITED);
    await screen.findByRole("button", { name: "Revision R2 (current)" });

    const knowledge = await screen.findByLabelText("Knowledge objects");
    await waitFor(() => expect(within(knowledge).getByText(EDITED)).toBeTruthy());
    fireEvent.click(within(knowledge).getByRole("button", { name: "View source" }));
    expect(within(knowledge).getByLabelText("Original capture text").querySelector("mark")?.textContent).toBe(TEXT.slice(0, 46));
  });

  it("graph relations are untouched by edits and are not shown as revisions", async () => {
    const { client, object } = await seed();
    const other = await client.createCapture({ source: "text", content: "A related thought" });
    const [otherObject] = (await client.distillCapture(other.id)) as [KnowledgeObject];
    await client.createRelation({ kind: "supersedes", sourceObjectId: otherObject.id, targetObjectId: object.id });
    mount(client, true);
    await screen.findByRole("button", { name: /^Revision R1/ });
    const edgesBefore = (await screen.findAllByRole("button", { name: /^Edge: / })).map((e) => e.getAttribute("aria-label"));

    await save("Edit this thought", "Save as new revision", EDITED);
    await screen.findByText("New revision saved.");

    const edgesAfter = screen.getAllByRole("button", { name: /^Edge: / }).map((e) => e.getAttribute("aria-label"));
    expect(edgesAfter.length).toBe(1);
    expect(edgesAfter[0]).toContain("supersedes");
    expect(edgesBefore.length).toBe(1);
    expect(listText().some((line) => line?.includes("supersedes"))).toBe(false);
  });
});
