import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createPreviewClient } from "../../client/preview-client";
import { TEXT, TWO_OBJECTS, renderApp, seeded } from "../../test/render";
import { spaceSummary } from "./HomeScreen";

describe("spaceSummary", () => {
  it("counts only what exists and pluralises", () => {
    expect(spaceSummary(0, 0)).toBe("0 thoughts · 0 connections");
    expect(spaceSummary(1, 1)).toBe("1 thought · 1 connection");
    expect(spaceSummary(42, 14)).toBe("42 thoughts · 14 connections");
  });
});

describe("HomeScreen", () => {
  it("groups the ideas under the capture they came from, with the original words", async () => {
    const { client } = await seeded();
    renderApp(client);

    const article = (await screen.findByText("Improve capture screen")).closest("article") as HTMLElement;
    expect(within(article).getByText("Email Ignatov")).toBeTruthy();
    expect(article.querySelector("q")?.textContent).toContain("improve the Arthur capture screen");
    expect(within(article).getByText("Typed")).toBeTruthy();
    // each idea shows kind (by shape, with a text name), body, connections and revisions
    expect(within(article).getByRole("img", { name: "Idea" })).toBeTruthy();
    expect(within(article).getByRole("img", { name: "Task" })).toBeTruthy();
    expect(within(article).getAllByLabelText("0 connections")).toHaveLength(2);
    await waitFor(() => expect(within(article).getAllByLabelText("1 revision")).toHaveLength(2));
  });

  it("opens the idea in Ideas when it is chosen", async () => {
    const { client } = await seeded();
    renderApp(client);

    fireEvent.click(await screen.findByRole("button", { name: /Email Ignatov/ }));
    expect(await screen.findByRole("heading", { name: "Ideas" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Email Ignatov", level: 2 })).toBeTruthy();
  });

  it("guides the user when there is nothing to show in the side panels", async () => {
    renderApp(createPreviewClient());
    expect(await screen.findByText(/Links between your ideas show up here/)).toBeTruthy();
    expect(screen.getByText("Ideas you revise show their history here.")).toBeTruthy();
  });

  it("shows a connected neighbourhood around the best-connected idea", async () => {
    const { client, objects } = await seeded();
    await client.createRelation({ kind: "extends", sourceObjectId: objects[0]!.id, targetObjectId: objects[1]!.id });
    renderApp(client);

    expect(await screen.findByRole("img", { name: /Connections around/ })).toBeTruthy();
    expect(screen.getByText(/1 idea, 1 link/)).toBeTruthy();
  });

  it("shows ideas that have been revised under 'Recently evolving', with the idea's real history shape", async () => {
    const { client, objects } = await seeded();
    await client.updateKnowledgeObject(objects[0]!.id, { body: "Improve the Arthur capture screen, and make it faster." });
    renderApp(client);

    const section = (await screen.findByRole("heading", { name: "Recently evolving" })).closest("section") as HTMLElement;
    await waitFor(() => expect(within(section).getByText(/r2 current/)).toBeTruthy());
    expect(within(section).getByText("Improve capture screen")).toBeTruthy();
  });

  it("shows the capture's own failure to organize, not a blank list", async () => {
    const client = createPreviewClient({ distillation: TWO_OBJECTS });
    await client.createCapture({ source: "text", content: TEXT });
    renderApp(client);
    expect(await screen.findByText("Not organized yet.")).toBeTruthy();
  });
});
