import { INBOX_PROJECT_ID, type KnowledgeObject } from "@arthur/contracts";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ArthurClient } from "../../client/arthur-client";
import { createPreviewClient, type PreviewClientOptions } from "../../client/preview-client";
import { renderMobile } from "../../test/render";
import { usePhoneViewport } from "../../test/viewport";

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

async function world() {
  const client = createPreviewClient({ distillation: DISTILLATION });
  const nexus = await client.createProject("Nexus");
  const inboxCapture = await client.createCapture({ source: "text", content: INBOX_TEXT });
  const nexusCapture = await client.createCapture({ source: "text", content: NEXUS_TEXT, projectId: nexus.id });
  const inboxObjects = await client.distillCapture(inboxCapture.id);
  const nexusObjects = await client.distillCapture(nexusCapture.id);
  return { client, nexus, inboxCapture, inboxObjects, nexusObjects };
}

const phone = usePhoneViewport(390);
const mobile = (client: ArthurClient, screenName: Parameters<typeof renderMobile>[1] = "home") => {
  phone.start();
  return renderMobile(client, screenName);
};
const tabs = () => screen.getByRole("navigation", { name: "Primary" });
const tab = (name: RegExp | string) => within(tabs()).getByRole("button", { name });
const chip = (name: RegExp | string = /^Project:/) => screen.findByRole("button", { name });
const openSheet = async () => {
  fireEvent.click(await chip());
  return screen.findByRole("dialog", { name: "Projects" });
};
const choose = async (name: string) => {
  const sheet = await openSheet();
  fireEvent.click(within(within(sheet).getByRole("list", { name: "Switch project" })).getByRole("button", { name: new RegExp(`^${name}`) }));
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Projects" })).toBeNull());
};

describe.each([360, 390, 412])("Mobile project switcher at %ipx", (width) => {
  const start = (client: ArthurClient, screenName?: Parameters<typeof renderMobile>[1]) => {
    phone.start();
    window.innerWidth = width;
    return renderMobile(client, screenName);
  };

  it("puts the active project in the top chrome of every tab and takes no slot in the bottom bar", async () => {
    const { client } = await world();
    start(client);
    expect((await chip("Project: Inbox. Change project")).textContent).toContain("Inbox");
    expect(within(tabs()).getAllByRole("button").map((b) => b.textContent)).toEqual(["Home", "Ideas", "Capture", "Connections", "Evolution"]);
    for (const name of ["Ideas", "Connections", "Evolution", "Home"]) {
      fireEvent.click(tab(name));
      expect(await chip("Project: Inbox. Change project")).toBeTruthy();
      expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy(); // ⚙ stays beside it
    }
  });

  it("opens a sheet, switches project, and Home, Ideas and Connections follow", async () => {
    const { client } = await world();
    start(client);
    await screen.findByText(/Improve the capture screen\. Email Ignatov/);
    await choose("Nexus");

    expect((await chip("Project: Nexus. Change project")).textContent).toContain("Nexus");
    expect(await screen.findByText(NEXUS_TEXT, { selector: "q" })).toBeTruthy();
    expect(screen.queryByText(/Improve the capture screen\. Email/)).toBeNull();

    fireEvent.click(tab("Ideas"));
    await waitFor(() => expect(within(screen.getByRole("list", { name: "Ideas" })).getAllByRole("button")).toHaveLength(1));
    expect(screen.getByRole("button", { name: /Faster gateway/ })).toBeTruthy();

    fireEvent.click(tab("Connections"));
    expect(await screen.findByText("1 idea · 0 links")).toBeTruthy();
    expect((await client.getActiveProject()).name).toBe("Nexus"); // persisted natively, not only on screen
  });

  it("creates a project from the sheet, switches to it and shows the empty state for it", async () => {
    const { client } = await world();
    start(client);
    const sheet = await openSheet();
    fireEvent.click(within(sheet).getByRole("button", { name: "New project" }));
    fireEvent.change(within(sheet).getByLabelText("Project name"), { target: { value: "School" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Create" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Projects" })).toBeNull());
    expect((await chip("Project: School. Change project")).textContent).toContain("School");
    expect(await screen.findByText(/Capture your first thought for School\./)).toBeTruthy();
  });

  it("renames and archives from a secondary action, falls back to the Inbox, and restores from Archived", async () => {
    const { client, nexus } = await world();
    await client.setActiveProject(nexus.id);
    start(client);
    await chip("Project: Nexus. Change project");

    let sheet = await openSheet();
    expect(within(sheet).queryByRole("button", { name: "Manage Inbox" })).toBeNull(); // the Inbox has no secondary actions
    fireEvent.click(within(sheet).getByRole("button", { name: "Manage Nexus" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Rename" }));
    fireEvent.change(within(sheet).getByLabelText("New name"), { target: { value: "Nexus Core" } });
    fireEvent.click(within(sheet).getByRole("button", { name: "Rename" }));
    await within(sheet).findByRole("button", { name: "Manage Nexus Core" });
    expect((await client.getProject(nexus.id)).name).toBe("Nexus Core");

    fireEvent.click(within(sheet).getByRole("button", { name: "Manage Nexus Core" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Archive" }));
    await within(sheet).findByRole("button", { name: "Restore Nexus Core" });
    expect(await chip("Project: Inbox. Change project")).toBeTruthy(); // the archived active project fell back to the Inbox
    expect((await client.getActiveProject()).id).toBe(INBOX_PROJECT_ID);

    fireEvent.click(within(sheet).getByRole("button", { name: "Restore Nexus Core" }));
    await within(sheet).findByRole("button", { name: "Manage Nexus Core" });
    sheet = screen.getByRole("dialog", { name: "Projects" });
    expect(within(sheet).queryByRole("list", { name: "Archived projects" })).toBeNull();
  });

  it("moves an idea from its page; the page closes, the idea leaves this project, and its provenance still opens the original capture", async () => {
    const { client, nexus, inboxCapture, inboxObjects } = await world();
    const task = inboxObjects.find((o) => o.title === "Email Ignatov") as KnowledgeObject;
    start(client, "ideas");
    fireEvent.click(await screen.findByRole("button", { name: /Email Ignatov/ }));
    const page = await screen.findByRole("region", { name: /Idea: Email Ignatov/ });
    expect(within(page).getByText("Inbox")).toBeTruthy();

    fireEvent.click(within(page).getByRole("button", { name: /Move Email Ignatov to another project/ }));
    const sheet = await screen.findByRole("dialog", { name: "Move to project" });
    expect(sheet.textContent).toContain("keeps its words, its source and its history");
    expect(within(sheet).queryByRole("button", { name: /^Inbox/ })).toBeNull();
    fireEvent.click(within(sheet).getByRole("button", { name: /^Nexus/ }));

    await waitFor(() => expect(screen.queryByRole("region", { name: /Idea:/ })).toBeNull());
    await waitFor(() => expect(screen.queryByRole("button", { name: /Email Ignatov/ })).toBeNull());
    expect((await client.listKnowledgeObjects({ projectId: nexus.id })).map((o) => o.id)).toContain(task.id);
    expect((await client.getObjectLineage(task.id)).revisions).toHaveLength(1);
    expect((await client.getCaptures([inboxCapture.id]))[0]!.projectId).toBe(INBOX_PROJECT_ID);

    await choose("Nexus");
    fireEvent.click(await screen.findByRole("button", { name: /Email Ignatov/ }));
    const moved = await screen.findByRole("region", { name: /Idea: Email Ignatov/ });
    await waitFor(() => expect(within(moved).getByLabelText("Original capture text").textContent).toBe(INBOX_TEXT));
  });

  it("marks the far end of a cross-project relation on the map and in the list, and says which project it belongs to", async () => {
    const { client, nexus, inboxObjects, nexusObjects } = await world();
    await client.createRelation({ kind: "depends_on", sourceObjectId: inboxObjects[0]!.id, targetObjectId: nexusObjects[0]!.id });
    start(client, "connections");
    fireEvent.click(await screen.findByRole("button", { name: "Map" }));
    const map = await screen.findByRole("group", { name: /Connections map/ });
    const far = await screen.findByRole("button", { name: "Node: Faster gateway, in Nexus" });
    expect(map.querySelectorAll("[data-node]")).toHaveLength(3); // two own ideas and the far end only
    expect(map.querySelectorAll(".m-node.external")).toHaveLength(1);

    fireEvent.click(far);
    const peek = await screen.findByRole("dialog", { name: "Faster gateway" });
    expect(peek.textContent).toContain("In Nexus ↗");
    expect(within(peek).queryByRole("button", { name: "Open idea" })).toBeNull();
    fireEvent.click(within(peek).getByRole("button", { name: "Open Nexus" }));
    await waitFor(async () => expect((await client.getActiveProject()).id).toBe(nexus.id));
  });
});

describe("Mobile project sheet and Back", () => {
  it("Back closes the project sheet before anything else, and a refused switch keeps the sheet open with the reason", async () => {
    const { client, nexus } = await world();
    mobile(client);
    await openSheet();
    window.history.back();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Projects" })).toBeNull());
    expect(await chip("Project: Inbox. Change project")).toBeTruthy();

    const sheet = await openSheet();
    await client.archiveProject(nexus.id); // archived behind the screen's back
    fireEvent.click(within(within(sheet).getByRole("list", { name: "Switch project" })).getByRole("button", { name: /^Nexus/ }));
    expect((await within(sheet).findByRole("alert")).textContent).toContain("archived");
    expect(screen.getByRole("dialog", { name: "Projects" })).toBeTruthy();
  });
});
