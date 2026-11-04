import { INBOX_PROJECT_ID, type KnowledgeObject, type Project } from "@arthur/contracts";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ArthurClient } from "../../client/arthur-client";
import { createPreviewClient, type PreviewClientOptions } from "../../client/preview-client";
import { renderApp } from "../../test/render";

const INBOX_TEXT = "Improve the capture screen. Email Ignatov about the demo.";
const NEXUS_TEXT = "Nexus needs a faster gateway.";
const DISTILLATION: PreviewClientOptions["distillation"] = {
  candidates: (capture) =>
    capture.content === NEXUS_TEXT
      ? [{ kind: "idea", title: "Faster gateway", body: NEXUS_TEXT, evidence: "Nexus needs a faster gateway" }]
      : capture.content !== INBOX_TEXT
        ? [{ kind: "note", title: capture.content, body: capture.content, evidence: capture.content }]
        : [
          { kind: "idea", title: "Improve capture screen", body: "Improve the capture screen.", evidence: "Improve the capture screen" },
          { kind: "task", title: "Email Ignatov", body: "Email Ignatov about the demo.", evidence: "Email Ignatov about the demo" },
        ],
};

/** An Inbox capture with two ideas, and a Nexus capture with one. The Nexus project exists but is NOT active. */
async function world() {
  const client = createPreviewClient({ distillation: DISTILLATION });
  const nexus = await client.createProject("Nexus");
  const inboxCapture = await client.createCapture({ source: "text", content: INBOX_TEXT });
  const nexusCapture = await client.createCapture({ source: "text", content: NEXUS_TEXT, projectId: nexus.id });
  const inboxObjects = await client.distillCapture(inboxCapture.id);
  const nexusObjects = await client.distillCapture(nexusCapture.id);
  return { client, nexus, inboxCapture, nexusCapture, inboxObjects, nexusObjects };
}

const rail = () => screen.getByRole("complementary", { name: "Sidebar" });
const projectButton = () => within(rail()).getByRole("button", { name: /^Project:/ });
const openMenu = async () => {
  fireEvent.click(await within(rail()).findByRole("button", { name: /^Project:/ }));
  return screen.getByRole("group", { name: "Projects" });
};
const switchTo = async (name: string) => {
  const menu = await openMenu();
  fireEvent.click(within(within(menu).getByRole("list", { name: "Switch project" })).getByRole("button", { name: new RegExp(`^${name}`) }));
};
const nav = (name: RegExp | string) => within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name });
const row = (title: string) => within(screen.getByRole("list", { name: "Ideas" })).getByRole("button", { name: new RegExp(title) });

describe("Desktop project selector", () => {
  it("names the active project near the Arthur mark, and the Inbox is set apart quietly", async () => {
    const { client } = await world();
    renderApp(client);
    expect((await within(rail()).findByRole("button", { name: "Project: Inbox" })).textContent).toContain("Inbox");
    expect(projectButton().querySelector(".proj-name.inbox")).not.toBeNull();
    const menu = await openMenu();
    const items = within(within(menu).getByRole("list", { name: "Switch project" })).getAllByRole("listitem");
    expect(items.map((item) => item.textContent?.replace(/\d+$/, ""))).toEqual(["Inbox", "Nexus"]);
    expect(items[0]!.className).toContain("proj-inbox");
    expect(within(items[0]!).getByRole("button").getAttribute("aria-current")).toBe("true");
    // The Inbox cannot be renamed or archived: those actions are not offered for it.
    expect(within(menu).queryByRole("button", { name: "Rename" })).toBeNull();
    expect(within(menu).queryByRole("button", { name: "Archive" })).toBeNull();
  });

  it("switching project updates Home, Ideas and Connections consistently, from one source of truth", async () => {
    const { client } = await world();
    renderApp(client);
    await screen.findByText(/Improve the capture screen\. Email Ignatov/);
    expect(screen.queryByText(/Nexus needs a faster gateway/)).toBeNull();

    await switchTo("Nexus");
    expect(await screen.findByText(NEXUS_TEXT, { selector: "q" })).toBeTruthy();
    expect(screen.queryByText(/Improve the capture screen\. Email/)).toBeNull();
    expect(screen.getByRole("button", { name: "Project: Nexus" })).toBeTruthy();

    fireEvent.click(nav(/^Ideas/));
    await waitFor(() => expect(row("Faster gateway")).toBeTruthy());
    expect(screen.queryByRole("button", { name: /Email Ignatov/ })).toBeNull();
    expect(within(screen.getByRole("group", { name: "Filter by kind" })).getByRole("button", { name: /^All\s*1$/ })).toBeTruthy();

    fireEvent.click(nav(/^Connections/));
    await screen.findByRole("group", { name: "Knowledge map" });
    await waitFor(() => expect(within(screen.getByRole("group", { name: "Knowledge map" })).getAllByRole("button")).toHaveLength(1));
    expect(screen.getByText("1 idea, 0 links")).toBeTruthy();

    await switchTo("Inbox");
    await waitFor(() => expect(screen.getByText("2 ideas, 0 links")).toBeTruthy());
  });

  it("Home is scoped: a nearly empty project says so, and a capture made there goes into it", async () => {
    const { client, nexus } = await world();
    const empty = await client.createProject("School");
    renderApp(client);
    await screen.findByText(/Improve the capture screen\. Email/);
    await switchTo("School");

    expect(await screen.findByText("Nothing captured yet")).toBeTruthy();
    expect(screen.getByText(/Capture your first thought for School\./)).toBeTruthy();
    expect(screen.getByText("Into School")).toBeTruthy();

    const createCapture = vi.spyOn(client, "createCapture");
    fireEvent.change(screen.getByLabelText("Thought"), { target: { value: "School essay outline" } });
    fireEvent.click(within(screen.getByRole("form", { name: "Capture a thought" })).getByRole("button", { name: /^Capture/ }));

    expect(await screen.findByText("School essay outline")).toBeTruthy();
    expect(createCapture).toHaveBeenCalledWith(expect.objectContaining({ projectId: empty.id }));
    expect((await client.listCaptures({ projectId: empty.id })).map((c) => c.content)).toEqual(["School essay outline"]);
    expect((await client.listCaptures({ projectId: nexus.id })).map((c) => c.content)).toEqual([NEXUS_TEXT]);
    // Auto-organize ran, and its objects inherited School without anyone choosing.
    await waitFor(async () => expect((await client.listKnowledgeObjects({ projectId: empty.id })).length).toBeGreaterThan(0));
  });

  it("creates a project from the menu, switches to it, and shows it in the list", async () => {
    const client = createPreviewClient({ distillation: DISTILLATION });
    renderApp(client);
    const menu = await openMenu();
    fireEvent.click(within(menu).getByRole("button", { name: "New project" }));
    const form = screen.getByRole("form", { name: "New project" });
    fireEvent.change(within(form).getByLabelText("Project name"), { target: { value: "A.R.T.H.U.R" } });
    fireEvent.click(within(form).getByRole("button", { name: "Create" }));

    expect(await within(rail()).findByRole("button", { name: "Project: A.R.T.H.U.R" })).toBeTruthy();
    expect((await client.getActiveProject()).name).toBe("A.R.T.H.U.R");
    expect(await screen.findByText(/Capture your first thought for A\.R\.T\.H\.U\.R\./)).toBeTruthy();
  });

  it("refuses a duplicate name with the reason, and changes nothing", async () => {
    const { client } = await world();
    renderApp(client);
    fireEvent.click(await within(rail()).findByRole("button", { name: /^Project:/ }));
    fireEvent.click(screen.getByRole("button", { name: "New project" }));
    fireEvent.change(screen.getByLabelText("Project name"), { target: { value: "nexus" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Another project already has that name");
    expect((await client.listProjects()).map((p) => p.name)).toEqual(["Inbox", "Nexus"]);
  });

  it("renames and archives the active project from the menu; an archived active project falls back to the Inbox; it can be restored", async () => {
    const { client, nexus } = await world();
    await client.setActiveProject(nexus.id);
    renderApp(client);
    await within(rail()).findByRole("button", { name: "Project: Nexus" });

    let menu = await openMenu();
    fireEvent.click(within(menu).getByRole("button", { name: "Rename" }));
    fireEvent.change(screen.getByLabelText("New name"), { target: { value: "Nexus Core" } });
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    expect(await within(rail()).findByRole("button", { name: "Project: Nexus Core" })).toBeTruthy();

    menu = await openMenu();
    fireEvent.click(within(menu).getByRole("button", { name: "Archive" }));
    expect(await within(rail()).findByRole("button", { name: "Project: Inbox" })).toBeTruthy();
    expect(await screen.findByText(/Improve the capture screen\. Email/)).toBeTruthy();
    expect((await client.getActiveProject()).id).toBe(INBOX_PROJECT_ID);

    menu = await openMenu();
    expect(within(within(menu).getByRole("list", { name: "Switch project" })).queryByRole("button", { name: /Nexus Core/ })).toBeNull();
    fireEvent.click(within(menu).getByRole("button", { name: /^Archived \(1\)/ }));
    fireEvent.click(within(menu).getByRole("button", { name: "Restore Nexus Core" }));
    await waitFor(() => expect(within(within(screen.getByRole("group", { name: "Projects" })).getByRole("list", { name: "Switch project" })).getByRole("button", { name: /Nexus Core/ })).toBeTruthy());
  });

  it("starts in whatever project was active last time, and falls back to the Inbox when that project is gone", async () => {
    const { client, nexus } = await world();
    await client.setActiveProject(nexus.id);
    const first = renderApp(client);
    expect(await within(rail()).findByRole("button", { name: "Project: Nexus" })).toBeTruthy();
    expect(await screen.findByText(NEXUS_TEXT, { selector: "q" })).toBeTruthy();
    first.unmount();

    await client.archiveProject(nexus.id); // archived while the app was closed
    renderApp(client);
    expect(await within(rail()).findByRole("button", { name: "Project: Inbox" })).toBeTruthy();
  });

  it("a switch that the store refuses is reported and the active project stays as it was", async () => {
    const { client, nexus } = await world();
    renderApp(client);
    await within(rail()).findByRole("button", { name: "Project: Inbox" });
    await client.archiveProject(nexus.id); // archived behind the screen's back
    await switchTo("Nexus");
    expect((await screen.findByRole("alert")).textContent).toContain("archived");
    expect(await client.getActiveProject()).toMatchObject({ id: INBOX_PROJECT_ID });
  });
});

describe("Ideas inside a project", () => {
  it("searches and filters inside the active project only", async () => {
    const { client, nexus } = await world();
    await client.setActiveProject(nexus.id);
    renderApp(client, "ideas");
    await waitFor(() => expect(row("Faster gateway")).toBeTruthy());
    fireEvent.change(screen.getByLabelText("Search ideas"), { target: { value: "ignatov" } });
    expect(await screen.findByText("Nothing matches")).toBeTruthy(); // Email Ignatov lives in the Inbox
    fireEvent.change(screen.getByLabelText("Search ideas"), { target: { value: "gateway" } });
    expect(row("Faster gateway")).toBeTruthy();
  });

  it("moves an idea to another project from its detail; the idea leaves this project, nothing about it changes, and provenance still opens the original capture", async () => {
    const { client, nexus, inboxCapture, inboxObjects } = await world();
    const idea = inboxObjects.find((object) => object.title === "Email Ignatov") as KnowledgeObject;
    const revise = await client.updateKnowledgeObject(idea.id, { title: "Email Ignatov today" });
    const lineageBefore = await client.getObjectLineage(idea.id);
    renderApp(client, "ideas");
    await waitFor(() => row("Email Ignatov today"));
    fireEvent.click(row("Email Ignatov today"));

    const detail = await screen.findByRole("complementary", { name: "Idea details" });
    expect(within(detail).getByText("Inbox", { selector: "b" })).toBeTruthy();
    fireEvent.click(within(detail).getByRole("button", { name: /Move Email Ignatov today to another project/ }));
    fireEvent.change(within(detail).getByLabelText("Move to"), { target: { value: nexus.id } });
    fireEvent.click(within(detail).getByRole("button", { name: "Move" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: /Email Ignatov today/ })).toBeNull());
    expect(await client.listKnowledgeObjects({ projectId: nexus.id })).toHaveLength(2);
    expect(await client.getObjectLineage(idea.id)).toEqual(lineageBefore); // no revision was made by moving
    expect((await client.getObjectLineage(idea.id)).currentRevisionId).toBe(revise.id);
    expect((await client.getCaptures([inboxCapture.id]))[0]!.projectId).toBe(INBOX_PROJECT_ID);

    // Open it where it lives now: its source is still the ORIGINAL capture, which stays in the Inbox.
    await switchTo("Nexus");
    await waitFor(() => row("Email Ignatov today"));
    fireEvent.click(row("Email Ignatov today"));
    const moved = await screen.findByRole("complementary", { name: "Idea details" });
    await waitFor(() => expect(within(moved).getByLabelText("Original capture text").textContent).toBe(INBOX_TEXT));
    expect(within(moved).getByText("Nexus", { selector: "b" })).toBeTruthy();
  });

  it("shows when every idea of a capture lives in other projects, instead of calling it not organized", async () => {
    const { client, nexus, inboxObjects } = await world();
    for (const object of inboxObjects) await client.moveKnowledgeObject(object.id, nexus.id);
    renderApp(client);
    expect(await screen.findByText("Its ideas are in other projects.")).toBeTruthy();
    expect(screen.queryByText("Not organized yet.")).toBeNull();
  });
});

describe("Connections across projects", () => {
  async function crossed() {
    const w = await world();
    const idea = w.inboxObjects.find((object) => object.title === "Improve capture screen") as KnowledgeObject;
    const far = w.nexusObjects[0] as KnowledgeObject;
    await w.client.createRelation({ kind: "depends_on", sourceObjectId: idea.id, targetObjectId: far.id });
    return { ...w, idea, far };
  }
  const map = () => screen.getByRole("group", { name: "Knowledge map" });

  it("draws the far end of a cross-project relation, marked with its project, and nothing else from that project", async () => {
    const { client, nexus } = await crossed();
    const extra = await client.createCapture({ source: "text", content: "Nexus other thing", projectId: nexus.id });
    await client.distillCapture(extra.id); // a second Nexus idea that is NOT related: it must not appear
    renderApp(client, "connections");
    await screen.findByRole("group", { name: "Knowledge map" });
    await waitFor(() => expect(within(map()).getByRole("button", { name: "Node: Faster gateway, in Nexus" })).toBeTruthy());

    expect(within(map()).getAllByRole("button", { name: /^Node:/ })).toHaveLength(3); // two own ideas + the one far end
    expect(map().querySelectorAll(".node.external")).toHaveLength(1);
    expect(map().textContent).toContain("Nexus ↗");
    expect(map().textContent).not.toContain("Nexus other thing");
    expect(screen.getByText("2 ideas, 1 link")).toBeTruthy(); // the header counts this project's ideas, not the visitor
  });

  it("selecting an external node shows its project clearly and offers to open that project", async () => {
    const { client, nexus } = await crossed();
    renderApp(client, "connections");
    await screen.findByRole("group", { name: "Knowledge map" });
    const far = await within(map()).findByRole("button", { name: "Node: Faster gateway, in Nexus" });
    fireEvent.click(far);

    const inspector = screen.getByRole("complementary", { name: "Connection details" });
    expect(within(inspector).getByRole("heading", { name: "Faster gateway" })).toBeTruthy();
    expect(within(inspector).getByText(/In Nexus ↗/)).toBeTruthy();
    expect(within(inspector).getByText(/belongs to another project/)).toBeTruthy();
    expect(within(inspector).queryByRole("button", { name: /Open idea/ })).toBeNull(); // only the connection reaches across
    fireEvent.click(within(inspector).getByRole("button", { name: /Open Nexus/ }));
    await waitFor(async () => expect((await client.getActiveProject()).id).toBe(nexus.id));
  });

  it("the list view marks external ends too, and a cross-project relation survives moving the idea", async () => {
    const { client, nexus, idea } = await crossed();
    renderApp(client, "connections");
    await screen.findByRole("group", { name: "Knowledge map" });
    fireEvent.click(screen.getByRole("button", { name: "List" }));
    const list = await screen.findByRole("list", { name: "Connections" });
    expect(within(list).getByText(/Nexus ↗/)).toBeTruthy();

    await client.moveKnowledgeObject(idea.id, nexus.id);
    expect(await client.listRelations()).toHaveLength(1); // the same edge, untouched
  });

  it("Find connections asks only about the active project", async () => {
    const { client, nexus } = await crossed();
    const infer = vi.spyOn(client, "inferRelations");
    renderApp(client, "connections");
    await screen.findByRole("group", { name: "Knowledge map" });
    await waitFor(() => expect((screen.getByRole("button", { name: /Find connections/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: /Find connections/ }));
    await waitFor(() => expect(infer).toHaveBeenCalledWith(undefined, { projectId: INBOX_PROJECT_ID }));
    expect(nexus.id).not.toBe(INBOX_PROJECT_ID);
  });
});

describe("Evolution picker", () => {
  it("lists the ideas of the active project only; lineage itself is untouched by project", async () => {
    const { client, nexus, inboxObjects } = await world();
    renderApp(client, "evolution");
    await screen.findByRole("group", { name: "Revision history" });
    await waitFor(() => expect(screen.getAllByText(/Improve capture screen|Email Ignatov/).length).toBeGreaterThan(0));
    expect(screen.queryByText("Faster gateway")).toBeNull();

    await switchTo("Nexus");
    await waitFor(() => expect(screen.getAllByText("Faster gateway").length).toBeGreaterThan(0));
    expect(screen.queryByText("Email Ignatov")).toBeNull();
    // Moving an idea never changed its lineage, so it simply continues where it lives.
    const lineage = await client.getObjectLineage(inboxObjects[0]!.id);
    await client.moveKnowledgeObject(inboxObjects[0]!.id, nexus.id);
    expect(await client.getObjectLineage(inboxObjects[0]!.id)).toEqual(lineage);
  });
});

describe("Capture dialog and scope", () => {
  it("a capture that finishes after the user switched project is not shown in the new project", async () => {
    const { client } = await world();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const original = client.createCapture.bind(client);
    vi.spyOn(client, "createCapture").mockImplementation(async (input) => {
      await gate;
      return original(input);
    });
    renderApp(client);
    await screen.findByText(/Improve the capture screen\. Email/);
    fireEvent.change(screen.getByLabelText("Thought"), { target: { value: "slow thought" } });
    fireEvent.click(within(screen.getByRole("form", { name: "Capture a thought" })).getByRole("button", { name: /^Capture/ }));
    await switchTo("Nexus");
    await screen.findByText(NEXUS_TEXT, { selector: "q" });
    await act(async () => release());
    await waitFor(async () => expect((await client.listCaptures({ projectId: INBOX_PROJECT_ID })).map((c) => c.content)).toContain("slow thought"));
    expect(screen.queryByText("slow thought")).toBeNull();
  });
});

describe("Project type guard", () => {
  it("the type is exported for presentation code", () => {
    const sample: Project = { id: "x", name: "x", isInbox: false, createdAt: "t", updatedAt: "t", archivedAt: null, captureCount: 0, objectCount: 0 };
    expect(sample.isInbox).toBe(false);
  });
});

export type { ArthurClient };
