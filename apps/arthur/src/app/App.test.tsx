import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createPreviewClient } from "../client/preview-client";
import { DistillationError, type ArthurClient } from "../client/arthur-client";
import { useArthurClient } from "../hooks/use-arthur-client";
import { NOTHING, deferred, renderApp } from "../test/render";
import { App } from "./App";
import { ArthurProviders } from "./providers";
import { BOUND, RESERVED } from "./shortcuts";

const nav = () => screen.getByRole("navigation", { name: "Primary" });

describe("App shell", () => {
  it("shows Arthur, the primary screens (Ask Arthur last) and Settings, and starts on Home", async () => {
    renderApp(createPreviewClient({ distillation: NOTHING }));

    expect(within(nav()).getAllByRole("button").map((b) => b.textContent?.replace(/\d+$/, ""))).toEqual(["Home", "Ideas", "Connections", "Evolution", "Review", "Ask ArthurCtrl K"]);
    expect(within(screen.getByRole("navigation", { name: "Secondary" })).getByRole("button", { name: "Settings" })).toBeTruthy();
    expect(within(nav()).getByRole("button", { name: "Home" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByText("Arthur", { selector: "b" })).toBeTruthy();
    expect(await screen.findByLabelText("Thought")).toBeTruthy();
  });

  it("shows Ask Arthur in the rail but not the long product name in everyday chrome", () => {
    renderApp(createPreviewClient());
    expect(within(nav()).getByRole("button", { name: /^Ask Arthur/ })).toBeTruthy();
    expect(screen.queryByText(/A\.R\.T\.H\.U\.R\./)).toBeNull();
    expect(screen.queryByText(/Cognitive Runtime/)).toBeNull();
  });

  it("says knowledge is stored locally, and does not claim nothing leaves the device", () => {
    renderApp(createPreviewClient());
    expect(screen.getByText("Knowledge stored locally")).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/never leaves|no data|offline only|local only/i);
  });

  it("moves between screens with the rail and marks the current one", async () => {
    renderApp(createPreviewClient({ distillation: NOTHING }));
    for (const name of ["Ideas", "Connections", "Evolution"]) {
      fireEvent.click(within(nav()).getByRole("button", { name: new RegExp(`^${name}`) }));
      expect(await screen.findByRole("heading", { name: new RegExp(`^${name}`), level: 1 })).toBeTruthy();
      expect(within(nav()).getByRole("button", { name: new RegExp(`^${name}`) }).getAttribute("aria-current")).toBe("page");
    }
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    expect(await screen.findByLabelText("Thought")).toBeTruthy();
  });

  it("counts ideas next to Ideas", async () => {
    const client = createPreviewClient();
    const capture = await client.createCapture({ source: "text", content: "one" });
    await client.distillCapture(capture.id);
    renderApp(client);
    await waitFor(() => expect(within(nav()).getByRole("button", { name: /^Ideas/ }).textContent).toContain("1"));
  });
});

describe("global Capture", () => {
  it("Ctrl+N opens a capture dialog from any screen, focused on the thought", async () => {
    renderApp(createPreviewClient({ distillation: NOTHING }), "connections");
    await screen.findByText("Nothing to connect yet");

    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    const dialog = screen.getByRole("dialog", { name: "Capture a thought" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByLabelText("Thought")));
  });

  it("the Capture button in the rail opens the same dialog", async () => {
    renderApp(createPreviewClient({ distillation: NOTHING }), "ideas");
    fireEvent.click(within(screen.getByRole("complementary", { name: "Sidebar" })).getByRole("button", { name: /^Capture/ }));
    expect(screen.getByRole("dialog", { name: "Capture a thought" })).toBeTruthy();
  });

  it("Escape closes it without saving anything, and returns focus", async () => {
    const client = createPreviewClient({ distillation: NOTHING });
    const create = vi.spyOn(client, "createCapture");
    renderApp(client, "ideas");
    const opener = screen.getAllByRole("button", { name: /^Capture/ })[0]!;
    opener.focus();
    fireEvent.click(opener);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(create).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
  });

  it("captures a thought from the dialog, closes itself, and the thought is saved and organized", async () => {
    const client = createPreviewClient({ distillation: { candidates: (c) => [{ kind: "idea", title: "From the dialog", body: c.content, evidence: c.content }] } });
    renderApp(client, "ideas");
    fireEvent.keyDown(window, { key: "n", metaKey: true });
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Thought"), { target: { value: "dialog thought" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Capture/ }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect((await client.listCaptures())[0]).toMatchObject({ source: "text", content: "dialog thought" });
    expect(await screen.findByRole("heading", { name: "From the dialog", level: 2 })).toBeTruthy();
  });

  it("keeps the dialog open and the words in it when saving fails", async () => {
    const client: ArthurClient = { ...createPreviewClient(), createCapture: () => Promise.reject(new Error("disk full")) };
    renderApp(client);
    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Thought"), { target: { value: "do not lose me" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Capture/ }));

    expect((await within(dialog).findByRole("alert")).textContent).toContain("disk full");
    expect((within(dialog).getByLabelText("Thought") as HTMLTextAreaElement).value).toBe("do not lose me");
  });

  it("cannot be dismissed while a recording is in progress, so a recording is never invisible", async () => {
    renderApp(createPreviewClient({ distillation: NOTHING }), "ideas");
    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Start recording" }));
    await within(dialog).findByText("Recording…");

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect((within(dialog).getByRole("button", { name: "Close" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows an active recording in the rail when the composer is not on screen", async () => {
    renderApp(createPreviewClient({ distillation: NOTHING }));
    fireEvent.click(await screen.findByRole("button", { name: "Start recording" }));
    await screen.findByText("Recording…");
    expect(screen.queryByRole("button", { name: "Stop recording from the sidebar" })).toBeNull(); // the composer itself is visible

    fireEvent.click(within(nav()).getByRole("button", { name: /^Ideas/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Stop recording from the sidebar" }));
    expect(await screen.findByText("No ideas yet")).toBeTruthy();
  });

  it("shows from any screen that Arthur is organizing, and when a capture could not be organized, with a way back", async () => {
    const gate = deferred();
    const client = createPreviewClient({ distillation: { error: new DistillationError("llm_failed", "Could not reach the language model."), once: true } });
    const real = client.distillCapture.bind(client);
    vi.spyOn(client, "distillCapture").mockImplementation(async (id) => {
      await gate.promise;
      return real(id);
    });
    renderApp(client, "ideas");
    await screen.findByText("No ideas yet");
    expect(screen.getByText("Ready")).toBeTruthy();

    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    const dialog = screen.getByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Thought"), { target: { value: "Capture from another screen" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /^Capture/ }));
    expect(await screen.findByText("Organizing…")).toBeTruthy();

    gate.resolve();
    const alert = await screen.findByRole("button", { name: "1 capture couldn't be organized" });
    fireEvent.click(alert);
    expect(await screen.findByText("Couldn't organize this capture. Your words are saved.")).toBeTruthy();
    expect((await client.listCaptures())[0]!.content).toBe("Capture from another screen");
  });

  it("traps Tab inside the dialog", async () => {
    renderApp(createPreviewClient({ distillation: NOTHING }), "ideas");
    fireEvent.keyDown(window, { key: "n", ctrlKey: true });
    const dialog = screen.getByRole("dialog");
    const buttons = within(dialog).getAllByRole("button").filter((b) => !(b as HTMLButtonElement).disabled);
    buttons[buttons.length - 1]!.focus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(dialog.contains(document.activeElement)).toBe(true);
  });
});

describe("shortcuts", () => {
  it("binds Mod+K to Ask Arthur only, alongside Mod+N for Capture, with nothing else reserved", async () => {
    expect(BOUND.askArthur).toBe("Mod+K");
    expect(Object.values(BOUND).filter((chord) => chord === "Mod+K")).toHaveLength(1);
    expect(Object.keys(RESERVED)).toEqual([]);
    renderApp(createPreviewClient({ distillation: NOTHING }));
    await screen.findByLabelText("Thought");

    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(await screen.findByRole("heading", { name: "Ask Arthur", level: 1 })).toBeTruthy();
    expect(screen.queryByRole("dialog")).toBeNull();
  });});

describe("Settings", () => {
  it("shows runtime information obtained through the ArthurClient, and the full product name", async () => {
    const client = createPreviewClient({ info: { appVersion: "9.9.9", platform: "android" } });
    renderApp(client, "settings");

    expect(screen.getByText("A.R.T.H.U.R. Cognitive Runtime")).toBeTruthy();
    expect(screen.getByText("Loading runtime information…")).toBeTruthy();
    expect(await screen.findByText("9.9.9")).toBeTruthy();
    expect(screen.getByText("android")).toBeTruthy();
    expect(screen.getByText("preview")).toBeTruthy();
    expect(screen.getByText(/Knowledge stored locally\./)).toBeTruthy();
  });

  it("surfaces a native failure instead of crashing", async () => {
    const failing: ArthurClient = { ...createPreviewClient(), kind: "desktop", getRuntimeInfo: () => Promise.reject(new Error("ipc down")) };
    renderApp(failing, "settings");
    expect((await screen.findByRole("alert")).textContent).toContain("ipc down");
  });
});

describe("providers", () => {
  it("falls back to the preview client when no native layer exists", async () => {
    render(
      <ArthurProviders initialScreen="settings">
        <App />
      </ArthurProviders>,
    );
    expect(await screen.findByText("0.0.0-preview")).toBeTruthy();
  });

  it("refuses to render UI that has no ArthurClient provider", () => {
    function NeedsClient() {
      useArthurClient();
      return null;
    }
    expect(() => render(<NeedsClient />)).toThrow("useArthurClient must be used inside <ArthurProviders>");
  });
});
