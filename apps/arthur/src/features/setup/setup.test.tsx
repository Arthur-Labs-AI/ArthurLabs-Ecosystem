import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AiSetupError } from "../../client/arthur-client";
import { createPreviewClient, type PreviewClientOptions } from "../../client/preview-client";
import { NOTHING, TEXT, renderApp, renderMobile } from "../../test/render";
import { usePhoneViewport } from "../../test/viewport";

const phone = usePhoneViewport(390);
const SECRET = "test-openai-secret";

const fresh = (options: PreviewClientOptions = {}) => createPreviewClient({ distillation: NOTHING, ai: { setupCompleted: false, credentials: [] }, ...options });
const mobileFresh = (options: PreviewClientOptions = {}) => {
  phone.start();
  const client = fresh(options);
  renderMobile(client);
  return client;
};

describe("first-run Setup", () => {
  it("opens before anything else on a fresh install, and says nothing is mandatory", async () => {
    renderApp(fresh());
    expect(await screen.findByRole("heading", { name: "Welcome to Arthur" })).toBeTruthy();
    expect(screen.getByText("Your knowledge stays locally on this device.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set up later" })).toBeTruthy();
    expect(screen.queryByRole("navigation")).toBeNull();
  });

  it("does not appear once Setup is done, or for an installation that already has a credential", async () => {
    renderApp(createPreviewClient({ distillation: NOTHING }));
    expect(await screen.findByRole("heading", { name: /Good (morning|afternoon|evening)/ })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Welcome to Arthur" })).toBeNull();
  });

  it("can be skipped: Arthur opens, typed Capture works, and Home says what is off", async () => {
    const client = fresh();
    renderApp(client);
    fireEvent.click(await screen.findByRole("button", { name: "Set up later" }));
    expect(await screen.findByText(/Organizing and Ask Arthur are off until you connect AI/)).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox"), { target: { value: TEXT } });
    const composer = screen.getByRole("textbox").closest("form")!;
    fireEvent.click(within(composer).getByRole("button", { name: /^Capture/ }));
    await waitFor(async () => expect((await client.listCaptures()).length).toBe(1));
    // No model is asked for: nothing was organized, nothing failed.
    expect(await client.listKnowledgeObjects()).toEqual([]);
  });

  it("walks Welcome → Connect AI → Test → Done where there is no microphone, stores the key write-only, and never shows it again", async () => {
    const client = { ...fresh(), capabilities: { voiceCapture: false } };
    const set = vi.spyOn(client, "setCredential");
    renderApp(client);
    fireEvent.click(await screen.findByRole("button", { name: "Connect AI" }));
    const input = (await screen.findByLabelText("OpenAI API key")) as HTMLInputElement;
    expect(input.type).toBe("password");
    expect(input.autocomplete).toBe("off");
    fireEvent.change(input, { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));

    expect(await screen.findByRole("heading", { name: "Test" })).toBeTruthy();
    expect(set).toHaveBeenCalledWith("openai", SECRET);
    expect(await screen.findByText(/Connected\./)).toBeTruthy();
    expect(document.body.textContent).not.toContain(SECRET);

    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Done" })).toBeTruthy();
    expect(screen.getByText(/Semantic Recall is off/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Open Arthur" }));
    expect(await screen.findByRole("heading", { name: /Good (morning|afternoon|evening)/ })).toBeTruthy();
    expect(document.body.textContent).not.toContain(SECRET);
    // Connecting never turned Semantic Recall on.
    expect((await client.getSemanticRecallStatus()).enabled).toBe(false);
  });

  it("includes the speech step on a phone, and Voice Capture is unavailable (typing still works) if no key was added", async () => {
    mobileFresh();
    fireEvent.click(await screen.findByRole("button", { name: "Connect AI" }));
    fireEvent.click(await screen.findByRole("button", { name: "Skip for now" }));
    expect(await screen.findByRole("heading", { name: "Configure speech" })).toBeTruthy();
    expect(screen.getByText(/Voice Capture needs a key\. Typed Capture still works\. Voice Capture is unavailable\./)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByText(/nothing to test yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Open Arthur" }));
    // Home: no Speak button, a plain notice, and typing is offered.
    expect(await screen.findByText(/Voice Capture is off until you connect AI/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Speak" })).toBeNull();
  });

  it("says a bad key is not valid, clears the input, and does not echo what was typed", async () => {
    const client = fresh();
    vi.spyOn(client, "setCredential").mockRejectedValue(new AiSetupError("invalidCredentialFormat", "That doesn’t look like a valid key. Paste it exactly as the provider gave it."));
    renderApp(client);
    fireEvent.click(await screen.findByRole("button", { name: "Connect AI" }));
    const input = (await screen.findByLabelText("OpenAI API key")) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "not a key" } });
    fireEvent.click(screen.getByRole("button", { name: "Save and continue" }));
    expect((await screen.findByRole("alert")).textContent).toContain("doesn’t look like a valid key");
    expect(input.value).toBe("");
    expect(document.body.textContent).not.toContain("not a key");
  });
});

describe("Ask Arthur without a language-model connection", () => {
  it("explains the missing AI provider on the Ask page and offers Connect AI", async () => {
    phone.start();
    renderMobile(createPreviewClient({ distillation: NOTHING, ai: { credentials: [] } }));
    fireEvent.click(await screen.findByRole("button", { name: /^Ask about/ }));
    const page = await screen.findByRole("region", { name: "Ask Arthur" });
    expect(page.textContent).toContain("Ask Arthur can’t write answers until you connect AI");
    fireEvent.click(within(page).getByRole("button", { name: "Connect AI" }));
    expect(await screen.findByRole("heading", { name: "AI & Voice" })).toBeTruthy();
  });

  it("shows nothing extra when AI is connected", async () => {
    phone.start();
    renderMobile(createPreviewClient({ distillation: NOTHING }));
    fireEvent.click(await screen.findByRole("button", { name: /^Ask about/ }));
    const page = await screen.findByRole("region", { name: "Ask Arthur" });
    expect(page.textContent).not.toContain("until you connect AI");
  });
});

describe("Settings → AI & Voice", () => {
  it("shows provider, model and status per capability, a masked key indicator, and never the key", async () => {
    // The native Desktop client cannot record, so it has no speech row.
    const client = { ...createPreviewClient({ distillation: NOTHING }), capabilities: { voiceCapture: false } };
    renderApp(client, "settings");
    const section = (await screen.findByRole("heading", { name: "AI & Voice" })).closest("section")!;
    const text = section.textContent ?? "";
    expect(text).toContain("OpenAI key •••••••• configured");
    expect(text).toContain("gpt-4.1-mini");
    expect(text).toContain("Semantic Recall embeddings");
    expect(text).not.toMatch(/Voice Capture/);
    expect(within(section).getAllByText("Ready").length).toBe(2);
  });

  it("separates 'OpenAI connected' from 'Semantic Recall Off' and never turns consent on", async () => {
    const client = createPreviewClient({ distillation: NOTHING });
    const enable = vi.spyOn(client, "setSemanticRecallEnabled");
    renderApp(client, "settings");
    expect(await screen.findByText(/OpenAI connected · Semantic Recall Off/)).toBeTruthy();
    expect(enable).not.toHaveBeenCalled();
  });

  it("tests a capability and reports each outcome in plain words", async () => {
    for (const [outcome, words] of [
      ["connected", "Connected."],
      ["invalidCredential", "Invalid credential."],
      ["unreachable", "Provider unreachable."],
      ["unavailable", "Capability unavailable."],
    ] as const) {
      const { unmount } = renderApp(createPreviewClient({ distillation: NOTHING, ai: { testOutcomes: { llm: outcome } } }), "settings");
      fireEvent.click(await screen.findByRole("button", { name: "Test Organizing and Ask Arthur" }));
      expect(await screen.findByText(words)).toBeTruthy();
      unmount();
    }
  });

  it("changes the key through a write-only form and clears it", async () => {
    const client = createPreviewClient({ distillation: NOTHING });
    const set = vi.spyOn(client, "setCredential");
    renderApp(client, "settings");
    fireEvent.click(await screen.findByRole("button", { name: "Change key" }));
    const input = screen.getByLabelText("OpenAI API key") as HTMLInputElement;
    expect(input.value).toBe("");
    fireEvent.change(input, { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: "Replace key" }));
    await waitFor(() => expect(set).toHaveBeenCalledWith("openai", SECRET));
    await waitFor(() => expect(screen.queryByLabelText("OpenAI API key")).toBeNull());
    expect(document.body.textContent).not.toContain(SECRET);
  });

  it("removes the credential only after confirming what stops working, leaves knowledge alone, and capabilities become unavailable", async () => {
    const client = createPreviewClient({ distillation: NOTHING });
    await client.createCapture({ source: "text", content: TEXT });
    renderApp(client, "settings");
    fireEvent.click(await screen.findByRole("button", { name: "Remove key" }));
    const confirm = screen.getByRole("group", { name: "Remove the OpenAI key" });
    expect(confirm.textContent).toContain("Your captures and ideas stay exactly as they are");
    expect(await client.hasCredential("openai")).toBe(true);
    fireEvent.click(within(confirm).getByRole("button", { name: "Remove key" }));
    await waitFor(() => expect(screen.getAllByText("Needs a key").length).toBe(3));
    expect(screen.getByText("No OpenAI key")).toBeTruthy();
    expect(await client.hasCredential("openai")).toBe(false);
    expect(screen.getByText(/No OpenAI key · Semantic Recall Off/)).toBeTruthy();
    expect(screen.getByText(/Recall still finds ideas by the words you used/)).toBeTruthy();
    expect((await client.listCaptures()).length).toBe(1);
  });

  it("shows the speech row on a phone and reflects a missing key as unavailable", async () => {
    phone.start();
    renderMobile(createPreviewClient({ distillation: NOTHING, ai: { credentials: [] } }));
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    const section = (await screen.findByRole("heading", { name: "AI & Voice" })).closest("section")!;
    expect(section.textContent).toContain("Voice Capture");
    expect(section.textContent).toContain("Typed Capture still works. Voice Capture is unavailable.");
    expect(within(section).getByRole("button", { name: "Test Voice Capture" }).hasAttribute("disabled")).toBe(true);
  });
});
