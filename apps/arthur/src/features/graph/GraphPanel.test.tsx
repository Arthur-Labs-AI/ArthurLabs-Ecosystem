import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { KnowledgeObject } from "@arthur/contracts";
import { ArthurProviders } from "../../app/providers";
import { RelationError, type ArthurClient } from "../../client/arthur-client";
import { createPreviewClient, type PreviewClientOptions } from "../../client/preview-client";
import { CapturePanel } from "../capture/CapturePanel";
import { KnowledgePanel } from "../knowledge/KnowledgePanel";
import { GraphPanel } from "./GraphPanel";

const THOUGHTS = [
  { text: "I want Arthur to organize ideas automatically.", title: "Arthur organizes ideas" },
  { text: "The Cognitive Graph should connect related ideas instead of showing flat notes.", title: "Graph connects ideas" },
  { text: "Before Graph inference works, Thought Distillation has to create KnowledgeObjects.", title: "Distillation comes first" },
];

async function seed(options: PreviewClientOptions = {}) {
  const client = createPreviewClient(options);
  const objects: KnowledgeObject[] = [];
  for (const { text } of THOUGHTS) {
    const capture = await client.createCapture({ source: "text", content: text });
    objects.push(...(await client.distillCapture(capture.id)));
  }
  return { client, objects };
}

/** Same previews, but titles chosen by the test. */
function previewOptions(extra: PreviewClientOptions = {}): PreviewClientOptions {
  return {
    distillation: { candidates: (capture) => [{ kind: "idea", title: THOUGHTS.find((t) => t.text === capture.content)!.title, body: capture.content, evidence: capture.content }] },
    ...extra,
  };
}

function mount(client: ArthurClient) {
  return render(
    <ArthurProviders client={client}>
      <GraphPanel />
    </ArthurProviders>,
  );
}

const nodeCount = () => screen.queryAllByRole("button", { name: /^Node: / }).length;
const edgeLabels = () => screen.queryAllByRole("button", { name: /^Edge: / }).map((edge) => edge.getAttribute("aria-label"));

describe("GraphPanel", () => {
  it("guides the user when there is nothing to show yet", async () => {
    mount(createPreviewClient());
    expect(await screen.findByText(/Distill a capture to create knowledge objects/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "Infer relations" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("renders knowledge objects as nodes and typed relations as edges that differ by kind", async () => {
    const { client, objects } = await seed(previewOptions());
    await client.createRelation({ kind: "extends", sourceObjectId: objects[1]!.id, targetObjectId: objects[0]!.id });
    await client.createRelation({ kind: "contradicts", sourceObjectId: objects[2]!.id, targetObjectId: objects[0]!.id });
    const { container } = mount(client);

    await screen.findByRole("button", { name: "Edge: Graph connects ideas extends Arthur organizes ideas" });

    expect(nodeCount()).toBe(3);
    expect(edgeLabels()).toHaveLength(2);
    const extendsEdge = container.querySelector(".graph-edge.edge-extends");
    const contradictsEdge = container.querySelector(".graph-edge.edge-contradicts");
    expect(extendsEdge && contradictsEdge).toBeTruthy();
    // A directional relation has an arrowhead; a symmetric one has none.
    expect(extendsEdge!.querySelector(".graph-edge-line")!.getAttribute("marker-end")).toBe("url(#arrow-extends)");
    expect(contradictsEdge!.querySelector(".graph-edge-line")!.getAttribute("marker-end")).toBeNull();
    // Meaning is also in text, not only colour.
    expect(within(extendsEdge as HTMLElement).getByText("extends")).toBeTruthy();
  });

  it("shows a node's kind, title, body and source when it is selected", async () => {
    const { client, objects } = await seed(previewOptions());
    mount(client);

    fireEvent.click(await screen.findByRole("button", { name: "Node: Graph connects ideas" }));

    const details = screen.getByLabelText("Selected object");
    expect(within(details).getByText("idea")).toBeTruthy();
    expect(within(details).getByText("Graph connects ideas")).toBeTruthy();
    expect(within(details).getByText(THOUGHTS[1]!.text)).toBeTruthy();
    expect(within(details).getByText(new RegExp(`Source: capture ${objects[1]!.provenance.captureId.slice(0, 8)}`))).toBeTruthy();
    expect(within(details).getByText("No relations yet.")).toBeTruthy();
  });

  it("shows an edge's type, direction and origin when it is selected", async () => {
    const { client, objects } = await seed(previewOptions());
    await client.createRelation({ kind: "depends_on", sourceObjectId: objects[1]!.id, targetObjectId: objects[2]!.id });
    await client.createRelation({ kind: "related_to", sourceObjectId: objects[0]!.id, targetObjectId: objects[1]!.id });
    mount(client);

    fireEvent.click(await screen.findByRole("button", { name: "Edge: Graph connects ideas depends on Distillation comes first" }));
    let details = screen.getByLabelText("Selected relation");
    expect(within(details).getByText("Relation: depends on")).toBeTruthy();
    expect(within(details).getByText("Direction: Graph connects ideas → Distillation comes first")).toBeTruthy();
    expect(within(details).getByText("Origin: Created by you")).toBeTruthy();

    // A symmetric relation says it has no direction.
    fireEvent.click(screen.getByRole("button", { name: /^Edge: .* related to / }));
    details = screen.getByLabelText("Selected relation");
    expect(within(details).getByText(/↔.*\(no direction\)/)).toBeTruthy();
  });

  it("can be operated from the keyboard", async () => {
    const { client } = await seed(previewOptions());
    mount(client);
    const first = await screen.findByRole("button", { name: "Node: Arthur organizes ideas" });
    fireEvent.keyDown(first, { key: "Enter" });
    expect(screen.getByLabelText("Selected object")).toBeTruthy();
    expect(first.getAttribute("aria-pressed")).toBe("true");
  });

  it("creates a relation manually, shows it as a user edge, and persists it in the client", async () => {
    const { client, objects } = await seed(previewOptions());
    mount(client);
    await screen.findByRole("button", { name: "Node: Arthur organizes ideas" });

    const form = screen.getByRole("form", { name: "Add a relation" });
    fireEvent.change(within(form).getByLabelText("From"), { target: { value: objects[1]!.id } });
    fireEvent.change(within(form).getByLabelText("Relation"), { target: { value: "extends" } });
    fireEvent.change(within(form).getByLabelText("To"), { target: { value: objects[0]!.id } });
    fireEvent.click(within(form).getByRole("button", { name: "Add relation" }));

    expect(await screen.findByText("Relation saved.")).toBeTruthy();
    expect(edgeLabels()).toEqual(["Edge: Graph connects ideas extends Arthur organizes ideas"]);
    expect(screen.getByText("(Created by you)")).toBeTruthy();
    expect(await client.listRelations()).toHaveLength(1);
  });

  it("will not submit a relation from an object to itself", async () => {
    const { client } = await seed(previewOptions());
    mount(client);
    await screen.findByRole("button", { name: "Node: Arthur organizes ideas" });
    const form = screen.getByRole("form", { name: "Add a relation" });
    const [from] = within(form).getAllByRole("combobox") as HTMLSelectElement[];
    fireEvent.change(within(form).getByLabelText("To"), { target: { value: from!.value } });

    expect(within(form).getByRole("alert").textContent).toMatch(/two different objects/);
    expect((within(form).getByRole("button", { name: "Add relation" }) as HTMLButtonElement).disabled).toBe(true);
    expect(await client.listRelations()).toEqual([]);
  });

  it("infers relations with the model, shows them as model edges, and says so when there are none", async () => {
    let titles: Record<string, KnowledgeObject> = {};
    const { client, objects } = await seed(
      previewOptions({
        inference: {
          proposals: () => [{ kind: "depends_on", sourceObjectId: titles.graph!.id, targetObjectId: titles.distill!.id }],
        },
      }),
    );
    titles = { arthur: objects[0]!, graph: objects[1]!, distill: objects[2]! };
    mount(client);
    await screen.findByRole("button", { name: "Node: Arthur organizes ideas" });

    fireEvent.click(screen.getByRole("button", { name: "Infer relations" }));

    expect(await screen.findByText("Added 1 relation.")).toBeTruthy();
    expect(edgeLabels()).toEqual(["Edge: Graph connects ideas depends on Distillation comes first"]);
    expect(screen.getByText("(Proposed by the model)")).toBeTruthy();

    // Running it again finds nothing new and never duplicates the edge.
    fireEvent.click(screen.getByRole("button", { name: "Infer relations" }));
    await waitFor(() => expect(screen.getByText("No new relations found.")).toBeTruthy());
    expect(edgeLabels()).toHaveLength(1);
  });

  it("shows a loading state while inferring and a readable error if the model output is rejected", async () => {
    const { client } = await seed(previewOptions({ inference: { error: new RelationError("llm_invalid_output", "The language model returned something that could not be trusted."), once: true } }));
    mount(client);
    await screen.findByRole("button", { name: "Node: Arthur organizes ideas" });

    fireEvent.click(screen.getByRole("button", { name: "Infer relations" }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toMatch(/could not be trusted/);
    expect(edgeLabels()).toEqual([]);
    expect((screen.getByRole("button", { name: "Infer relations" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("the nodes and edges are identical after the panel is reopened (state comes from the client, not the component)", async () => {
    const { client, objects } = await seed(previewOptions());
    await client.createRelation({ kind: "extends", sourceObjectId: objects[1]!.id, targetObjectId: objects[0]!.id });
    await client.createRelation({ kind: "related_to", sourceObjectId: objects[0]!.id, targetObjectId: objects[2]!.id });

    const first = mount(client);
    await screen.findAllByRole("button", { name: /^Edge: / });
    const before = { nodes: nodeCount(), edges: edgeLabels() };
    first.unmount();

    mount(client);
    await screen.findAllByRole("button", { name: /^Edge: / });
    expect({ nodes: nodeCount(), edges: edgeLabels() }).toEqual(before);
  });

  it("never draws an edge whose object it does not know", async () => {
    const { client, objects } = await seed(previewOptions());
    await client.createRelation({ kind: "extends", sourceObjectId: objects[1]!.id, targetObjectId: objects[0]!.id });
    const stale: ArthurClient = { ...client, listKnowledgeObjects: async () => (await client.listKnowledgeObjects()).filter((o) => o.id !== objects[0]!.id) };
    mount(stale);

    await screen.findByRole("button", { name: "Node: Graph connects ideas" });
    expect(edgeLabels()).toEqual([]);
  });

  it("picks up objects distilled in the Knowledge panel without a reload", async () => {
    const client = createPreviewClient(previewOptions());
    const capture = await client.createCapture({ source: "text", content: THOUGHTS[0]!.text });
    render(
      <ArthurProviders client={client}>
        <CapturePanel />
        <KnowledgePanel />
        <GraphPanel />
      </ArthurProviders>,
    );
    await screen.findByText(/Distill a capture to create knowledge objects/);

    fireEvent.click(await screen.findByRole("button", { name: `Distill capture ${capture.id.slice(0, 8)}` }));

    expect(await screen.findByRole("button", { name: "Node: Arthur organizes ideas" })).toBeTruthy();
    expect(screen.getByText(/at least two knowledge objects/)).toBeTruthy();
  });

  it("lists every relation as text too, and selecting one from the list shows its details", async () => {
    const { client, objects } = await seed(previewOptions());
    await client.createRelation({ kind: "supersedes", sourceObjectId: objects[2]!.id, targetObjectId: objects[0]!.id });
    mount(client);

    const list = await screen.findByLabelText("Relations");
    fireEvent.click(within(list).getByRole("button", { name: "Distillation comes first supersedes Arthur organizes ideas" }));

    expect(within(screen.getByLabelText("Selected relation")).getByText("Relation: supersedes")).toBeTruthy();
  });
});
