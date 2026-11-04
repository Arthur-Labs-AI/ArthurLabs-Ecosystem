import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createPreviewClient, type PreviewClientOptions } from "../../client/preview-client";
import { answer, paragraph } from "../../test/recall-fixtures";
import { NOTHING, renderApp, renderMobile } from "../../test/render";
import { usePhoneViewport } from "../../test/viewport";

const phone = usePhoneViewport(390);

const BULGARIAN = "Трябва да изпратиш имейл на Игнатов утре. Срокът за състезанието е в петък.";
const ANSWER = answer({ answer: { paragraphs: [paragraph("You decided to retry the audio upload three times.", ["E1"]), paragraph(BULGARIAN, ["E1"])], gaps: [] } });

function client(extra: PreviewClientOptions = {}) {
  return createPreviewClient({ distillation: NOTHING, ...extra, recall: { answer: (q, scope) => ({ ...ANSWER, query: q.query, scope }) } });
}

async function askQuestion() {
  const box = await screen.findByRole("textbox", { name: "Your question" });
  fireEvent.change(box, { target: { value: "What did I decide?" } });
  fireEvent.click(screen.getByRole("button", { name: "Ask" }));
  await screen.findByRole("heading", { name: "Answer" });
}

const listen = () => screen.getByRole("button", { name: "Listen to this answer" });

describe("Listen on an Ask Arthur answer", () => {
  it("is offered under the answer, never plays by itself, and reads the answer text in order, English and Bulgarian untouched", async () => {
    const spoken: string[] = [];
    renderApp(client({ speech: { onSpeak: (text) => spoken.push(text) } }), "ask");
    await askQuestion();
    expect(spoken).toEqual([]);
    fireEvent.click(listen());
    await waitFor(() => expect(spoken.length).toBe(1));
    expect(spoken[0]).toBe(`You decided to retry the audio upload three times.\n\n${BULGARIAN}`);
  });

  it("stops on request, and can be started again, without leaving the previous audio running", async () => {
    const c = client({ speech: { hold: true } });
    const stop = vi.spyOn(c, "stopSpeech");
    const speak = vi.spyOn(c, "speakText");
    renderApp(c, "ask");
    await askQuestion();
    fireEvent.click(listen());
    fireEvent.click(await screen.findByRole("button", { name: "Stop listening" }));
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("button", { name: "Listen to this answer" })).toBeTruthy();
    fireEvent.click(listen());
    await waitFor(() => expect(speak).toHaveBeenCalledTimes(2));
    expect((await c.getSpeechStatus()).state).toBe("playing");
  });

  it("returns to Listen by itself when the audio finishes", async () => {
    renderApp(client(), "ask");
    await askQuestion();
    fireEvent.click(listen());
    expect(await screen.findByRole("button", { name: "Listen to this answer" }, { timeout: 2000 })).toBeTruthy();
  });

  it("stops the audio when the answer goes away (a new question, or leaving the screen)", async () => {
    const c = client({ speech: { hold: true } });
    const stop = vi.spyOn(c, "stopSpeech");
    renderApp(c, "ask");
    await askQuestion();
    fireEvent.click(listen());
    await screen.findByRole("button", { name: "Stop listening" });
    fireEvent.click(screen.getByRole("button", { name: "Home" }));
    await waitFor(() => expect(stop).toHaveBeenCalled());
    expect((await c.getSpeechStatus()).state).toBe("idle");
  });

  it("shows one fixed sentence for each failure and leaves the text answer exactly as it was", async () => {
    const cases = [
      ["invalidCredential", /rejected the saved key/],
      ["unreachable", /Couldn’t reach the voice service/],
      ["unsupported", /doesn’t offer that voice/],
      ["synthesisFailed", /couldn’t produce speech/],
      ["playbackFailed", /couldn’t play the audio/],
    ] as const;
    for (const [failure, words] of cases) {
      const { unmount } = renderApp(client({ speech: { failure } }), "ask");
      await askQuestion();
      fireEvent.click(listen());
      expect((await screen.findByText(words)).textContent).not.toMatch(/sk-|Authorization|Bearer/);
      expect(screen.getByRole("heading", { name: "Answer" })).toBeTruthy();
      expect(screen.getByText(/retry the audio upload three times/)).toBeTruthy();
      unmount();
    }
  });

  it("is absent when text-to-speech has no credential or the device cannot play audio, and the answer is untouched", async () => {
    const { unmount } = renderApp(client({ ai: { credentials: [] } }), "ask");
    await askQuestion();
    expect(screen.queryByRole("button", { name: /Listen/ })).toBeNull();
    expect(screen.getByText(/retry the audio upload three times/)).toBeTruthy();
    unmount();

    renderApp({ ...client(), capabilities: { voiceCapture: true, speechOutput: false } }, "ask");
    await askQuestion();
    expect(screen.queryByRole("button", { name: /Listen/ })).toBeNull();
  });

  it("also works in the mobile Ask page", async () => {
    phone.start();
    const spoken: string[] = [];
    renderMobile(client({ speech: { onSpeak: (text) => spoken.push(text) } }));
    fireEvent.click(await screen.findByRole("button", { name: /^Ask about/ }));
    const page = await screen.findByRole("region", { name: "Ask Arthur" });
    fireEvent.change(within(page).getByRole("textbox"), { target: { value: "What did I decide?" } });
    fireEvent.click(within(page).getByRole("button", { name: "Ask" }));
    fireEvent.click(await within(page).findByRole("button", { name: "Listen to this answer" }));
    await waitFor(() => expect(spoken.length).toBe(1));
  });
});

describe("Settings → AI & Voice → Text to speech", () => {
  it("shows provider, model, voice and status on the existing connection, with no second key field", async () => {
    renderApp(client(), "settings");
    const section = (await screen.findByRole("heading", { name: "AI & Voice" })).closest("section")!;
    const row = within(section).getByRole("heading", { name: "Text to speech" }).closest("li")!;
    expect(row.textContent).toContain("OpenAI");
    expect(row.textContent).toContain("gpt-4o-mini-tts");
    expect(row.textContent).toContain("alloy");
    expect(within(row).getByText("Ready")).toBeTruthy();
    expect(row.textContent).toContain("sends the text of the answer you choose to OpenAI to be spoken");
    expect(section.querySelectorAll('input[type="password"]').length).toBe(0);
    expect(within(section).getAllByText(/OpenAI key •••••••• configured/).length).toBe(1);
  });

  it("Test voice speaks one short fixed sentence and shows no text of the user's", async () => {
    const spoken: string[] = [];
    renderApp(client({ speech: { onSpeak: (text) => spoken.push(text) } }), "settings");
    fireEvent.click(await screen.findByRole("button", { name: "Test voice" }));
    await waitFor(() => expect(spoken).toEqual(["Hello, I'm Arthur. This is how I sound."]));
  });

  it("without a credential, Text to speech needs a key and Test voice is unavailable", async () => {
    renderApp(client({ ai: { credentials: [] } }), "settings");
    const row = (await screen.findByRole("heading", { name: "Text to speech" })).closest("li")!;
    expect(row.textContent).toContain("Needs a key");
    expect(row.textContent).toContain("Listening is unavailable");
    expect(within(row).getByRole("button", { name: "Test voice" }).hasAttribute("disabled")).toBe(true);
  });

  it("is not shown on a device that cannot play audio", async () => {
    renderApp({ ...client(), capabilities: { voiceCapture: false, speechOutput: false } }, "settings");
    await screen.findByRole("heading", { name: "AI & Voice" });
    expect(screen.queryByRole("heading", { name: "Text to speech" })).toBeNull();
  });

  it("is independent of Semantic Recall consent", async () => {
    const c = client();
    const enable = vi.spyOn(c, "setSemanticRecallEnabled");
    renderApp(c, "settings");
    fireEvent.click(await screen.findByRole("button", { name: "Test voice" }));
    await waitFor(() => expect(c.getSpeechStatus()).resolves.toBeTruthy());
    expect(enable).not.toHaveBeenCalled();
    expect((await c.getSemanticRecallStatus()).enabled).toBe(false);
  });
});
