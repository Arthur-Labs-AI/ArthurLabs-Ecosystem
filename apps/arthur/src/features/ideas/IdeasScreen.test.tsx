import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ArthurClient } from "../../client/arthur-client";
import { createPreviewClient } from "../../client/preview-client";
import { renderApp, seeded } from "../../test/render";

const inspector = () => screen.getByRole("complementary", { name: "Idea details" });
const row = (title: string) => within(screen.getByRole("list", { name: "Ideas" })).getByRole("button", { name: new RegExp(title) });

describe("IdeasScreen", () => {
  it("guides the user when there are no ideas, and offers to capture", async () => {
    renderApp(createPreviewClient(), "ideas");
    expect(await screen.findByText("No ideas yet")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Capture a thought" }));
    expect(screen.getByRole("dialog", { name: "Capture a thought" })).toBeTruthy();
  });

  it("lists each idea with its kind, body and margin, and counts kinds in the filter", async () => {
    const { client } = await seeded();
    renderApp(client, "ideas");

    expect(await screen.findByRole("button", { name: /Improve capture screen/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Email Ignatov/ })).toBeTruthy();
    const filter = screen.getByRole("group", { name: "Filter by kind" });
    expect(within(filter).getByRole("button", { name: /^All\s*2$/ })).toBeTruthy();
    expect(within(filter).getByRole("button", { name: /^Ideas\s*1$/ })).toBeTruthy();
    expect(within(filter).getByRole("button", { name: /^Tasks\s*1$/ })).toBeTruthy();
    expect(within(filter).getByRole("button", { name: /^Notes\s*0$/ })).toBeTruthy();
  });

  it("filters by kind and by search, and says when nothing matches", async () => {
    const { client } = await seeded();
    renderApp(client, "ideas");
    await waitFor(() => row("Email Ignatov"));

    fireEvent.click(within(screen.getByRole("group", { name: "Filter by kind" })).getByRole("button", { name: /^Tasks/ }));
    expect(screen.queryByRole("button", { name: /Improve capture screen/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Email Ignatov/ })).toBeTruthy();

    fireEvent.click(within(screen.getByRole("group", { name: "Filter by kind" })).getByRole("button", { name: /^All/ }));
    fireEvent.change(screen.getByLabelText("Search ideas"), { target: { value: "competition" } });
    expect(screen.queryByRole("button", { name: /Improve capture screen/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Email Ignatov/ })).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Search ideas"), { target: { value: "zebra" } });
    expect(screen.getByText("Nothing matches")).toBeTruthy();
  });

  it("selecting an idea shows its words, source, connections and revisions in one inspector", async () => {
    const { client, objects } = await seeded();
    await client.createRelation({ kind: "depends_on", sourceObjectId: objects[1]!.id, targetObjectId: objects[0]!.id });
    renderApp(client, "ideas");
    await waitFor(() => row("Email Ignatov"));

    fireEvent.click(row("Email Ignatov"));
    const panel = within(inspector());
    expect(panel.getByRole("heading", { name: "Email Ignatov", level: 2 })).toBeTruthy();
    expect(panel.getByText("Email Ignatov about the competition.")).toBeTruthy();
    expect(panel.getByRole("heading", { name: "Source" })).toBeTruthy();
    expect(panel.getByRole("heading", { name: "Connections" })).toBeTruthy();
    expect(panel.getByRole("button", { name: "Improve capture screen, depends on" })).toBeTruthy();
    expect(await panel.findByRole("list", { name: "Revisions" })).toBeTruthy();
    expect(panel.getByText(/Current · First captured/)).toBeTruthy();
  });

  it("reads a connection from the OTHER idea's side with the inverse wording", async () => {
    const { client, objects } = await seeded();
    await client.createRelation({ kind: "depends_on", sourceObjectId: objects[1]!.id, targetObjectId: objects[0]!.id });
    renderApp(client, "ideas");
    await waitFor(() => row("Improve capture screen"));

    fireEvent.click(row("Improve capture screen"));
    expect(within(inspector()).getByRole("button", { name: "Email Ignatov, needed by" })).toBeTruthy();
  });

  it("marks a connection proposed by the model differently from one the user made", async () => {
    const { client, objects } = await seeded();
    await client.createRelation({ kind: "related_to", sourceObjectId: objects[0]!.id, targetObjectId: objects[1]!.id });
    renderApp(client, "ideas");
    await waitFor(() => row("Improve capture screen"));
    fireEvent.click(row("Improve capture screen"));

    const connection = within(inspector()).getByRole("button", { name: "Email Ignatov, related to" });
    expect(connection.querySelector(".origin.model")).toBeNull(); // user-made: solid
    expect(connection.querySelector(".origin")).not.toBeNull();
  });

  it("highlights exactly the span the idea came from, inside the untouched capture text", async () => {
    const { client } = await seeded();
    renderApp(client, "ideas");
    await waitFor(() => row("Email Ignatov"));
    fireEvent.click(row("Email Ignatov"));

    const source = within(inspector()).getByLabelText("Original capture text");
    expect(source.textContent).toBe("I want to improve the Arthur capture screen. Tomorrow I also need to email Ignatov about the competition.");
    expect(source.querySelector("mark")?.textContent).toBe("email Ignatov about the competition");
  });

  it("highlights the exact characters for Bulgarian text containing an emoji", async () => {
    const content = "Искам да подобря екрана 😀 и утре да пиша на Игнатов.";
    const { client } = await seeded({ distillation: { candidates: () => [{ kind: "task", title: "Пиша на Игнатов", body: "Да пиша на Игнатов.", evidence: "да пиша на Игнатов" }] } }, content);
    renderApp(client, "ideas");
    await screen.findByRole("button", { name: /Пиша на Игнатов/ });

    const source = within(inspector()).getByLabelText("Original capture text");
    expect(source.textContent).toBe(content);
    expect(source.querySelector("mark")?.textContent).toBe("да пиша на Игнатов");
  });

  it("says so when the original text cannot be found", async () => {
    const { client } = await seeded();
    const broken: ArthurClient = { ...client, listCaptures: () => Promise.resolve([]) };
    renderApp(broken, "ideas");
    await waitFor(() => row("Email Ignatov"));
    expect((await within(inspector()).findByRole("alert")).textContent).toContain("original text");
  });

  it("revising makes a new current revision, shows the new text, and the source still points at the first capture", async () => {
    const { client, objects } = await seeded();
    const update = vi.spyOn(client, "updateKnowledgeObject");
    renderApp(client, "ideas");
    await waitFor(() => row("Email Ignatov"));
    fireEvent.click(row("Email Ignatov"));

    fireEvent.click(within(inspector()).getByRole("button", { name: "Revise" }));
    const form = within(inspector()).getByRole("form", { name: "Revise this idea" });
    fireEvent.change(within(form).getByLabelText("Title"), { target: { value: "Email Ignatov today" } });
    fireEvent.click(within(form).getByRole("button", { name: "Save revision" }));

    expect(await screen.findByRole("heading", { name: "Email Ignatov today", level: 2 })).toBeTruthy();
    expect(update).toHaveBeenCalledExactlyOnceWith(objects[1]!.id, { title: "Email Ignatov today" });
    await waitFor(() => expect(within(inspector()).getByText(/Current · \+/)).toBeTruthy());
    expect(within(inspector()).getByLabelText("Original capture text").querySelector("mark")?.textContent).toBe("email Ignatov about the competition");
  });

  it("refuses a revision that changes nothing and says so", async () => {
    const { client } = await seeded();
    const update = vi.spyOn(client, "updateKnowledgeObject");
    renderApp(client, "ideas");
    await waitFor(() => row("Email Ignatov"));
    fireEvent.click(row("Email Ignatov"));
    fireEvent.click(within(inspector()).getByRole("button", { name: "Revise" }));

    fireEvent.click(within(inspector()).getByRole("button", { name: "Save revision" }));
    expect((await within(inspector()).findByRole("alert")).textContent).toBe("Nothing changed.");
    expect(update).not.toHaveBeenCalled();
  });

  it("shows a loading state, and reports a failure to load instead of an empty list", async () => {
    const client: ArthurClient = { ...createPreviewClient(), listKnowledgeObjects: () => Promise.reject(new Error("knowledge database is unreadable")) };
    renderApp(client, "ideas");
    expect(screen.getByLabelText("Loading ideas")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("unreadable"));
    expect(screen.queryByText("No ideas yet")).toBeNull();
  });

  it("'/' focuses the search box, but not while typing elsewhere", async () => {
    const { client } = await seeded();
    renderApp(client, "ideas");
    await waitFor(() => row("Email Ignatov"));

    fireEvent.keyDown(window, { key: "/" });
    expect(document.activeElement).toBe(screen.getByLabelText("Search ideas"));
    fireEvent.change(screen.getByLabelText("Search ideas"), { target: { value: "a" } });
    fireEvent.keyDown(screen.getByLabelText("Search ideas"), { key: "/" });
    expect((screen.getByLabelText("Search ideas") as HTMLInputElement).value).toBe("a");
  });
});
