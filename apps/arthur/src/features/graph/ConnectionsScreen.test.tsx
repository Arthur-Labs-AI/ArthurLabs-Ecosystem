import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { KnowledgeObject } from "@arthur/contracts";
import { RelationError, type ArthurClient } from "../../client/arthur-client";
import { createPreviewClient, type PreviewClientOptions } from "../../client/preview-client";
import { deferred, renderApp } from "../../test/render";

const TEXT = "Capture should be faster. Email Ignatov about the demo. How should conflicts work? Notes on the graph.";
const FOUR: PreviewClientOptions["distillation"] = {
  candidates: () => [
    { kind: "idea", title: "Faster capture", body: "Capture should be faster.", evidence: "Capture should be faster" },
    { kind: "task", title: "Email Ignatov", body: "Email Ignatov about the demo.", evidence: "Email Ignatov about the demo" },
    { kind: "question", title: "Conflict handling", body: "How should conflicts work?", evidence: "How should conflicts work" },
    { kind: "note", title: "Graph notes", body: "Notes on the graph.", evidence: "Notes on the graph" },
  ],
};

async function graph(options: PreviewClientOptions = {}) {
  const client = createPreviewClient({ distillation: FOUR, ...options });
  const capture = await client.createCapture({ source: "text", content: TEXT });
  const objects = await client.distillCapture(capture.id);
  const by = (title: string) => (objects as KnowledgeObject[]).find((o) => o.title === title)!;
  return { client, objects, by };
}

const map = () => screen.getByRole("group", { name: "Knowledge map" });
const node = (title: string) => within(map()).getByRole("button", { name: `Node: ${title}` });
const edge = (text: string) => within(map()).getByRole("button", { name: `Edge: ${text}` });
const details = () => screen.getByRole("complementary", { name: "Connection details" });
const positions = () => [...map().querySelectorAll(".node")].map((n) => n.getAttribute("transform"));
const open = async (client: ArthurClient) => {
  renderApp(client, "connections");
  await screen.findByRole("group", { name: "Knowledge map" });
};

describe("ConnectionsScreen", () => {
  it("guides the user when there is nothing to show yet", async () => {
    renderApp(createPreviewClient(), "connections");
    expect(await screen.findByText("Nothing to connect yet")).toBeTruthy();
  });

  it("renders ideas as nodes and typed relations as edges whose geometry differs by kind", async () => {
    const { client, by } = await graph();
    await client.createRelation({ kind: "extends", sourceObjectId: by("Faster capture").id, targetObjectId: by("Graph notes").id });
    await client.createRelation({ kind: "depends_on", sourceObjectId: by("Email Ignatov").id, targetObjectId: by("Faster capture").id });
    await client.createRelation({ kind: "contradicts", sourceObjectId: by("Conflict handling").id, targetObjectId: by("Email Ignatov").id });
    await open(client);

    expect(map().querySelectorAll(".node")).toHaveLength(4);
    const kinds = [...map().querySelectorAll(".edge")].map((e) => e.getAttribute("data-kind")).sort();
    expect(kinds).toEqual(["contradicts", "depends_on", "extends"]);
    const dashes = new Set([...map().querySelectorAll(".edge")].map((e) => e.querySelector("path")?.getAttribute("stroke-dasharray") ?? "none"));
    expect(dashes.size).toBeGreaterThan(1); // not told apart by colour alone
    // directional kinds carry an arrowhead, a symmetric one has end bars instead of an arrow
    expect(map().querySelector('.edge[data-kind="extends"] path')?.getAttribute("marker-end")).toContain("m-extends");
    expect(map().querySelector('.edge[data-kind="contradicts"] path')?.getAttribute("marker-start")).toContain("m-contradicts");
  });

  it("names every node's kind by shape and exposes no edge text until something is selected", async () => {
    const { client, by } = await graph();
    await client.createRelation({ kind: "extends", sourceObjectId: by("Faster capture").id, targetObjectId: by("Graph notes").id });
    await open(client);

    expect(map().querySelector(".edge-label")).toBeNull();
    expect(new Set([...map().querySelectorAll(".shape")].map((s) => s.getAttribute("data-kind")))).toEqual(new Set(["idea", "task", "question", "note"]));
  });

  it("shows edge labels ONLY for the focus: a selected node's edges, or the selected edge", async () => {
    const { client, by } = await graph();
    await client.createRelation({ kind: "extends", sourceObjectId: by("Faster capture").id, targetObjectId: by("Graph notes").id });
    await client.createRelation({ kind: "depends_on", sourceObjectId: by("Email Ignatov").id, targetObjectId: by("Conflict handling").id });
    await open(client);

    fireEvent.click(node("Faster capture"));
    const labels = () => [...map().querySelectorAll(".edge-label")].map((l) => l.textContent);
    expect(labels()).toEqual(["extends"]);
    expect(map().querySelectorAll(".edge.dim")).toHaveLength(1);
    expect(map().querySelectorAll(".node.dim")).toHaveLength(2);

    fireEvent.click(edge("Email Ignatov depends on Conflict handling"));
    expect(labels()).toEqual(["depends on"]);
  });

  it("selecting a node shows its kind, title, body, and its connections grouped by relation", async () => {
    const { client, by } = await graph();
    await client.createRelation({ kind: "extends", sourceObjectId: by("Faster capture").id, targetObjectId: by("Graph notes").id });
    await open(client);

    fireEvent.click(node("Faster capture"));
    const panel = within(details());
    expect(panel.getByRole("heading", { name: "Faster capture", level: 2 })).toBeTruthy();
    expect(panel.getByText("Capture should be faster.")).toBeTruthy();
    expect(panel.getByText("Idea")).toBeTruthy();
    expect(panel.getByRole("button", { name: "Graph notes, extends" })).toBeTruthy();
  });

  it("selecting an edge explains its type, direction, origin and what it means", async () => {
    const { client, by } = await graph();
    await client.createRelation({ kind: "depends_on", sourceObjectId: by("Email Ignatov").id, targetObjectId: by("Faster capture").id });
    await open(client);

    fireEvent.click(edge("Email Ignatov depends on Faster capture"));
    const panel = within(details());
    expect(panel.getByText("Directional")).toBeTruthy();
    expect(panel.getByText("Email Ignatov → Faster capture")).toBeTruthy();
    expect(panel.getByText("Created by you")).toBeTruthy();
    expect(panel.getByText("The first needs the second to work, be valid or make sense.")).toBeTruthy();
  });

  it("a symmetric relation says it has no direction", async () => {
    const { client, by } = await graph();
    await client.createRelation({ kind: "related_to", sourceObjectId: by("Faster capture").id, targetObjectId: by("Graph notes").id });
    await open(client);

    fireEvent.click(map().querySelector(".edge-hit") as Element);
    expect(within(details()).getByText("No direction")).toBeTruthy();
    expect(within(details()).getByText(/↔.*\(no direction\)/)).toBeTruthy();
  });

  it("can be operated from the keyboard", async () => {
    const { client } = await graph();
    await open(client);

    fireEvent.keyDown(node("Email Ignatov"), { key: "Enter" });
    expect(within(details()).getByRole("heading", { name: "Email Ignatov", level: 2 })).toBeTruthy();
    expect(node("Email Ignatov").getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(node("Graph notes"), { key: " " });
    expect(within(details()).getByRole("heading", { name: "Graph notes", level: 2 })).toBeTruthy();
  });

  it("adds a connection FROM the selected idea, shows it as the user's, and persists it in the client", async () => {
    const { client, by } = await graph();
    await open(client);
    fireEvent.click(node("Faster capture"));

    const form = within(details()).getByRole("form", { name: "Add a connection" });
    fireEvent.change(within(form).getByLabelText("Relation"), { target: { value: "extends" } });
    fireEvent.change(within(form).getByLabelText("To"), { target: { value: by("Graph notes").id } });
    fireEvent.click(within(form).getByRole("button", { name: "Add connection" }));

    expect(await screen.findByText("Connection saved.")).toBeTruthy();
    expect(edge("Faster capture extends Graph notes")).toBeTruthy();
    expect(await client.listRelations()).toMatchObject([{ kind: "extends", sourceObjectId: by("Faster capture").id, targetObjectId: by("Graph notes").id, origin: "user" }]);
  });

  it("will not offer to connect an idea to itself", async () => {
    const { client, by } = await graph();
    await open(client);
    fireEvent.click(node("Faster capture"));

    const form = within(details()).getByRole("form", { name: "Add a connection" });
    const options = [...(within(form).getByLabelText("To") as HTMLSelectElement).options].map((o) => o.value);
    expect(options).not.toContain(by("Faster capture").id);
    expect(options).toHaveLength(3);
  });

  it("calls it 'Find connections' and says so when it finds nothing", async () => {
    const { client } = await graph({ inference: { proposals: () => [] } });
    await open(client);
    expect(screen.queryByText(/Infer/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Find connections" }));
    expect(await screen.findByText("No new connections found.")).toBeTruthy();
    expect(map().querySelector(".edge")).toBeNull();
  });

  it("shows connections the model proposed as Arthur's, with where they came from", async () => {
    const { client } = await graph({ inference: { proposals: (objects) => [{ sourceObjectId: objects[0]!.id, targetObjectId: objects[1]!.id, kind: "related_to" }] } });
    await open(client);

    fireEvent.click(screen.getByRole("button", { name: "Find connections" }));
    expect(await screen.findByText("Added 1 connection.")).toBeTruthy();
    fireEvent.click(map().querySelector(".edge-hit") as Element);
    expect(within(details()).getByText("Proposed by Arthur")).toBeTruthy();
    expect(within(details()).getByText(/checked it twice/)).toBeTruthy();
  });

  it("shows a loading state while finding connections and a readable error if the model output is rejected", async () => {
    const gate = deferred();
    const { client } = await graph({ inference: { error: new RelationError("llm_invalid_output", "The language model returned something that could not be trusted. Nothing was saved. Try again."), once: true } });
    const infer = client.inferRelations.bind(client);
    vi.spyOn(client, "inferRelations").mockImplementation(async (ids) => {
      await gate.promise;
      return infer(ids);
    });
    await open(client);

    fireEvent.click(screen.getByRole("button", { name: "Find connections" }));
    expect(await screen.findByText("Looking for connections…")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Finding…" }) as HTMLButtonElement).disabled).toBe(true);
    gate.resolve();
    expect((await screen.findByRole("alert")).textContent).toContain("could not be trusted");
    expect(map().querySelector(".edge")).toBeNull();
  });

  it("can find connections for just the selected idea", async () => {
    const { client, by } = await graph();
    const infer = vi.spyOn(client, "inferRelations");
    await open(client);
    fireEvent.click(node("Email Ignatov"));

    fireEvent.click(within(details()).getByRole("button", { name: "Find for this idea" }));
    await waitFor(() => expect(infer).toHaveBeenCalledWith([by("Email Ignatov").id]));
  });

  it("hiding a relation kind or an origin removes edges but NEVER moves a node", async () => {
    const { client, by } = await graph({ inference: { proposals: (objects) => [{ sourceObjectId: objects[0]!.id, targetObjectId: objects[2]!.id, kind: "related_to" }] } });
    await client.createRelation({ kind: "extends", sourceObjectId: by("Faster capture").id, targetObjectId: by("Graph notes").id });
    await client.inferRelations();
    await open(client);
    const before = positions();
    expect(map().querySelectorAll(".edge")).toHaveLength(2);

    fireEvent.click(within(screen.getByRole("group", { name: "Relation types" })).getByRole("button", { name: /extends/ }));
    expect(map().querySelectorAll(".edge")).toHaveLength(1);
    fireEvent.click(within(screen.getByRole("group", { name: "Show links by origin" })).getByRole("button", { name: "Yours" }));
    expect(map().querySelectorAll(".edge")).toHaveLength(0);
    expect(positions()).toEqual(before);

    fireEvent.click(within(screen.getByRole("group", { name: "Relation types" })).getByRole("button", { name: /extends/ }));
    fireEvent.click(within(screen.getByRole("group", { name: "Show links by origin" })).getByRole("button", { name: "All links" }));
    expect(map().querySelectorAll(".edge")).toHaveLength(2);
    expect(positions()).toEqual(before);
  });

  it("the legend states which relation types are shown, as pressed buttons with text names", async () => {
    const { client } = await graph();
    await open(client);
    const legend = within(screen.getByRole("group", { name: "Relation types" }));
    for (const label of ["related to", "extends", "depends on", "contradicts", "derived from", "duplicates", "supersedes"]) {
      expect(legend.getByRole("button", { name: label }).getAttribute("aria-pressed")).toBe("true");
    }
  });

  it("does not offer actions the client cannot perform: no remove, confirm, or set-current", async () => {
    const { client, by } = await graph();
    await client.createRelation({ kind: "extends", sourceObjectId: by("Faster capture").id, targetObjectId: by("Graph notes").id });
    await open(client);
    fireEvent.click(edge("Faster capture extends Graph notes"));

    expect(screen.queryByRole("button", { name: /remove|delete|dismiss|confirm|accept|make current/i })).toBeNull();
  });

  it("the nodes and edges are identical after the screen is reopened (state comes from the client, not the component)", async () => {
    const { client, by } = await graph();
    await client.createRelation({ kind: "extends", sourceObjectId: by("Faster capture").id, targetObjectId: by("Graph notes").id });
    const first = renderApp(client, "connections");
    await screen.findByRole("group", { name: "Knowledge map" });
    const html = map().innerHTML;
    first.unmount();

    renderApp(client, "connections");
    await screen.findByRole("group", { name: "Knowledge map" });
    expect(map().innerHTML).toBe(html);
  });

  it("never draws an edge whose idea it does not know", async () => {
    const { client, by } = await graph();
    const real = await client.createRelation({ kind: "extends", sourceObjectId: by("Faster capture").id, targetObjectId: by("Graph notes").id });
    const stale: ArthurClient = { ...client, listRelations: () => Promise.resolve([real, { ...real, id: "ghost", sourceObjectId: "gone" }]) };
    await open(stale);
    expect(map().querySelectorAll(".edge")).toHaveLength(1);
  });

  it("fills the map by itself after a capture made from this screen: capture, auto-organize, nodes", async () => {
    const client = createPreviewClient({ distillation: FOUR });
    renderApp(client, "connections");
    await screen.findByText("Nothing to connect yet");

    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    const dialog = screen.getByRole("dialog", { name: "Capture a thought" });
    fireEvent.change(within(dialog).getByLabelText("Thought"), { target: { value: TEXT } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Capture/ }));

    expect(await screen.findByRole("group", { name: "Knowledge map" })).toBeTruthy();
    await waitFor(() => expect(map().querySelectorAll(".node")).toHaveLength(4));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("lists every connection as text too, and choosing one shows its details", async () => {
    const { client, by } = await graph();
    await client.createRelation({ kind: "extends", sourceObjectId: by("Faster capture").id, targetObjectId: by("Graph notes").id });
    await open(client);

    fireEvent.click(screen.getByRole("button", { name: "List" }));
    const list = screen.getByRole("list", { name: "Connections" });
    fireEvent.click(within(list).getByRole("button", { name: /Faster capture extends Graph notes/ }));
    expect(within(details()).getByText("Directional")).toBeTruthy();
    expect(within(details()).getByText("Faster capture → Graph notes")).toBeTruthy();
  });

  it("opens the idea or its history from a selected node", async () => {
    const { client } = await graph();
    await open(client);
    fireEvent.click(node("Email Ignatov"));

    fireEvent.click(within(details()).getByRole("button", { name: /1 revision/ }));
    expect(await screen.findByRole("heading", { name: "Evolution" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Email Ignatov", level: 2 })).toBeTruthy();
  });
});
