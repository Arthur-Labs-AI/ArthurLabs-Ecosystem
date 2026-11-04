import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { MicrophonePermissionState } from "@arthur/contracts";
import { describe, expect, it, vi } from "vitest";
import { DistillationError, VoiceCaptureError, type ArthurClient } from "../../client/arthur-client";
import { createPreviewClient } from "../../client/preview-client";
import { NOTHING, TEXT, TWO_OBJECTS, renderMobile, seeded } from "../../test/render";
import { usePhoneViewport } from "../../test/viewport";

const phone = usePhoneViewport(390);
const tab = (name: RegExp | string) => within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name });
const mobile = (client: ArthurClient, screenName: Parameters<typeof renderMobile>[1] = "home") => {
  phone.start();
  return renderMobile(client, screenName);
};
const retryable = new VoiceCaptureError("stt_retryable", "Could not reach the speech service. Check the connection and try again. Your recording is kept for up to 15 minutes so you can try again without speaking again.");

async function failToTranscribe() {
  fireEvent.click(await screen.findByRole("button", { name: "Speak" }));
  fireEvent.click(await screen.findByRole("button", { name: /Stop and save/ }));
  return screen.findByRole("alert");
}

describe("retrying a transcription without speaking again", () => {
  it("offers Retry transcription and Discard recording, says how long the recording is kept, and saves no capture yet", async () => {
    const client = createPreviewClient({ distillation: NOTHING, voice: { finishError: retryable } });
    mobile(client);
    const alert = await failToTranscribe();

    expect(within(alert).getByText("Couldn’t transcribe yet")).toBeTruthy();
    expect(alert.textContent).toContain("kept for up to 15 minutes");
    expect(within(alert).getByRole("button", { name: "Retry transcription" })).toBeTruthy();
    expect(within(alert).getByRole("button", { name: "Discard recording" })).toBeTruthy();
    expect(within(alert).queryByRole("button", { name: "Dismiss" })).toBeNull();
    expect((await client.listCaptures()).length).toBe(0);
  });

  it("retries the same recording: no second recording, one Capture, and the card goes away", async () => {
    const client = createPreviewClient({ distillation: NOTHING, voice: { finishError: retryable, transcript: () => "what I said" } });
    const start = vi.spyOn(client, "startVoiceCapture");
    const retry = vi.spyOn(client, "retryVoiceTranscription");
    mobile(client);
    const alert = await failToTranscribe();

    fireEvent.click(within(alert).getByRole("button", { name: "Retry transcription" }));

    expect(await screen.findByText(/what I said/)).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(start).toHaveBeenCalledTimes(1);
    expect(retry).toHaveBeenCalledTimes(1);
    expect((await client.listCaptures()).length).toBe(1);
  });

  it("stays on the retry card when the retry fails the same way, and moves to an honest final card when it fails for good", async () => {
    const client = createPreviewClient({ distillation: NOTHING, voice: { finishError: retryable, retryErrors: [retryable, new VoiceCaptureError("stt_failed", "The speech service rejected the configured credentials.")] } });
    mobile(client);
    let alert = await failToTranscribe();

    fireEvent.click(within(alert).getByRole("button", { name: "Retry transcription" }));
    await waitFor(() => expect(screen.getByRole("alert").getAttribute("data-code")).toBe("stt_retryable"));
    alert = screen.getByRole("alert");
    expect(within(alert).getByRole("button", { name: "Retry transcription" })).toBeTruthy();

    fireEvent.click(within(alert).getByRole("button", { name: "Retry transcription" }));
    await waitFor(() => expect(screen.getByRole("alert").getAttribute("data-code")).toBe("stt_failed"));
    expect(screen.getByRole("alert").textContent).toMatch(/The recording isn’t kept/);
    expect(screen.queryByRole("button", { name: "Retry transcription" })).toBeNull();
    expect((await client.listCaptures()).length).toBe(0);
  });

  it("Discard recording deletes the kept audio and clears the card", async () => {
    const client = createPreviewClient({ distillation: NOTHING, voice: { finishError: retryable } });
    const discard = vi.spyOn(client, "discardVoiceRecording");
    mobile(client);
    const alert = await failToTranscribe();

    fireEvent.click(within(alert).getByRole("button", { name: "Discard recording" }));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(discard).toHaveBeenCalledTimes(1);
    await expect(client.retryVoiceTranscription()).rejects.toMatchObject({ code: "no_retained_recording" });
  });

  it("leaving Home leaves the retry flow, and the kept audio is deleted", async () => {
    const client = createPreviewClient({ distillation: NOTHING, voice: { finishError: retryable } });
    const discard = vi.spyOn(client, "discardVoiceRecording");
    mobile(client);
    await failToTranscribe();

    fireEvent.click(tab("Ideas"));

    await waitFor(() => expect(discard).toHaveBeenCalledTimes(1));
    fireEvent.click(tab("Home"));
    expect(screen.queryByRole("button", { name: "Retry transcription" })).toBeNull();
    await expect(client.retryVoiceTranscription()).rejects.toMatchObject({ code: "no_retained_recording" });
  });

  it("opening Settings, or an idea, from the retry card also leaves the flow", async () => {
    const client = createPreviewClient({ distillation: NOTHING, voice: { finishError: retryable } });
    const discard = vi.spyOn(client, "discardVoiceRecording");
    mobile(client);
    await failToTranscribe();

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));

    await waitFor(() => expect(discard).toHaveBeenCalled());
  });

  it("typing the thought instead leaves the flow and deletes the audio", async () => {
    const client = createPreviewClient({ distillation: NOTHING, voice: { finishError: retryable } });
    const discard = vi.spyOn(client, "discardVoiceRecording");
    mobile(client);
    await failToTranscribe();

    fireEvent.click(screen.getByRole("button", { name: "Type a thought" }));
    fireEvent.change(await screen.findByLabelText("Thought"), { target: { value: "typed instead" } });
    fireEvent.click(screen.getByRole("button", { name: "Capture" }));

    await waitFor(() => expect(discard).toHaveBeenCalledTimes(1));
    expect((await client.listCaptures()).map((c) => c.source)).toEqual(["text"]);
  });

  it("recording again replaces the kept audio (the native layer deletes the old one first)", async () => {
    const client = createPreviewClient({ distillation: NOTHING, voice: { finishError: retryable } });
    mobile(client);
    await failToTranscribe();
    // the card is on Home; a new recording started from the Capture tab leaves the retry flow
    fireEvent.click(tab("Capture"));
    await screen.findByRole("dialog", { name: "Recording" });
    await expect(client.retryVoiceTranscription()).rejects.toMatchObject({ code: "no_retained_recording" });
  });

  it("a terminal failure never offers a retry and never calls discard", async () => {
    for (const code of ["stt_failed", "stt_not_configured", "empty_transcript"] as const) {
      const client = createPreviewClient({ distillation: NOTHING, voice: { finishError: new VoiceCaptureError(code, "Nothing was saved.") } });
      const discard = vi.spyOn(client, "discardVoiceRecording");
      mobile(client);
      await failToTranscribe();
      expect(screen.queryByRole("button", { name: "Retry transcription" }), code).toBeNull();
      expect(discard).not.toHaveBeenCalled();
      cleanup();
      phone.start();
    }
  });
});

describe("microphone permission and the Capture tab", () => {
  const permissionRef = (current: MicrophonePermissionState) => ({ current });

  it("a granted microphone lets the Capture tab record at once, from any screen, with no earlier Speak", async () => {
    const client = createPreviewClient({ distillation: NOTHING, voice: { permission: permissionRef("granted") } });
    const start = vi.spyOn(client, "startVoiceCapture");
    mobile(client, "ideas");
    await waitFor(() => expect(client.getMicrophonePermission()).resolves.toBe("granted"));
    await screen.findByRole("heading", { name: "Ideas", level: 1 });
    await act(async () => undefined);

    fireEvent.click(tab("Capture"));

    expect(await screen.findByRole("dialog", { name: "Recording" })).toBeTruthy();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it.each<MicrophonePermissionState>(["unknown", "denied"])("%s: the Capture tab only opens Home and never starts or asks", async (state) => {
    const client = createPreviewClient({ distillation: NOTHING, voice: { permission: permissionRef(state) } });
    const start = vi.spyOn(client, "startVoiceCapture");
    mobile(client, "evolution");
    await act(async () => undefined);

    fireEvent.click(tab("Capture"));

    expect(await screen.findByRole("button", { name: "Speak" })).toBeTruthy();
    expect(screen.getByText(/Tap Speak and the microphone will be requested/)).toBeTruthy();
    expect(start).not.toHaveBeenCalled();
  });

  it("reading the permission never starts a recording, however often the app comes back to the foreground", async () => {
    const client = createPreviewClient({ distillation: NOTHING, voice: { permission: permissionRef("granted") } });
    const start = vi.spyOn(client, "startVoiceCapture");
    const read = vi.spyOn(client, "getMicrophonePermission");
    mobile(client);
    await act(async () => undefined);
    const before = read.mock.calls.length;

    for (let i = 0; i < 3; i += 1) {
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
      document.dispatchEvent(new Event("visibilitychange"));
      Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
      document.dispatchEvent(new Event("visibilitychange"));
    }

    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(before));
    expect(start).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Recording" })).toBeNull();
  });

  it("refused for good: Home says so up front and Open settings is the way back, without any attempt", async () => {
    const opened = vi.fn();
    const client = createPreviewClient({ distillation: NOTHING, voice: { permission: permissionRef("denied_permanently"), onOpenSettings: opened } });
    const start = vi.spyOn(client, "startVoiceCapture");
    mobile(client);

    const card = await screen.findByRole("alert");
    expect(within(card).getByText("Microphone is off")).toBeTruthy();
    expect(card.textContent).toContain("won’t ask again");
    fireEvent.click(within(card).getByRole("button", { name: "Open settings" }));

    expect(opened).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
    fireEvent.click(tab("Capture"));
    expect(start).not.toHaveBeenCalled();
  });

  it("returning from the system settings with the microphone allowed removes the card and lets the Capture tab record", async () => {
    const permission = permissionRef("denied_permanently");
    const client = createPreviewClient({ distillation: NOTHING, voice: { permission } });
    const start = vi.spyOn(client, "startVoiceCapture");
    mobile(client);
    await screen.findByRole("button", { name: "Open settings" });

    permission.current = "granted"; // the user allowed it in the system settings
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Open settings" })).toBeNull());
    fireEvent.click(tab("Capture"));
    expect(await screen.findByRole("dialog", { name: "Recording" })).toBeTruthy();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("a refusal card from an earlier attempt disappears once the microphone has been allowed in the settings", async () => {
    const permission = permissionRef("unknown");
    const client = createPreviewClient({ distillation: NOTHING, voice: { permission, startError: new VoiceCaptureError("microphone_permission_denied", "Microphone permission was denied.") } });
    mobile(client);
    fireEvent.click(await screen.findByRole("button", { name: "Speak" }));
    await screen.findByRole("alert");

    permission.current = "granted";
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));

    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("an ordinary refusal (the system will still ask) shows the type-instead card without Open settings", async () => {
    const permission = permissionRef("unknown");
    const client = createPreviewClient({ distillation: NOTHING, voice: { permission, startError: new VoiceCaptureError("microphone_permission_denied", "Microphone permission was denied. Allow microphone access for Arthur in the system settings and try again.") } });
    mobile(client);
    fireEvent.click(await screen.findByRole("button", { name: "Speak" }));
    const card = await screen.findByRole("alert");
    expect(within(card).getByText("Microphone is off")).toBeTruthy();
    expect(within(card).queryByRole("button", { name: "Open settings" })).toBeNull();
  });

  it("a refusal that turns out to be permanent adds Open settings once the permission is re-read", async () => {
    const permission = permissionRef("denied_permanently");
    const client = createPreviewClient({ distillation: NOTHING, voice: { permission, startError: new VoiceCaptureError("microphone_permission_denied", "Microphone permission was denied.") } });
    mobile(client);
    const card = await screen.findByRole("alert");
    expect(within(card).getByRole("button", { name: "Open settings" })).toBeTruthy();
  });

  it("typing stays available when the microphone is off for good", async () => {
    const client = createPreviewClient({ distillation: NOTHING, voice: { permission: permissionRef("denied_permanently") } });
    mobile(client);
    await screen.findByRole("button", { name: "Open settings" });
    fireEvent.click(screen.getByRole("button", { name: "Type instead" }));
    expect(await screen.findByLabelText("Thought")).toBeTruthy();
  });
});

describe("organization state that survives a restart", () => {
  const failing = () => createPreviewClient({ distillation: { candidates: TWO_OBJECTS?.candidates ?? (() => []), error: new DistillationError("llm_failed", "Could not reach the language model. Check the connection and try again."), once: true } });

  it("tells apart never organized, organized into nothing, organized, and failed", async () => {
    const client = createPreviewClient({ distillation: { candidates: (capture) => (capture.content.startsWith("alpha") ? TWO_OBJECTS!.candidates!(capture) : []) } });
    const alpha = await client.createCapture({ source: "text", content: `alpha ${TEXT}` });
    const chatter = await client.createCapture({ source: "text", content: "hmm" });
    const untouched = await client.createCapture({ source: "text", content: "never organized" });
    const broken = await client.createCapture({ source: "text", content: "will fail" });
    await client.distillCapture(alpha.id);
    await client.distillCapture(chatter.id);
    const failing = createPreviewClient({ distillation: { error: new DistillationError("llm_failed", "Could not reach the language model."), once: true } });
    void failing;
    expect((await client.listOrganizationStates()).map((s) => [s.captureId === alpha.id ? "alpha" : s.captureId === chatter.id ? "chatter" : s.captureId === untouched.id ? "untouched" : "broken", s.status, s.objectCount])).toEqual([
      ["broken", "pending", 0],
      ["untouched", "pending", 0],
      ["chatter", "succeeded", 0],
      ["alpha", "succeeded", 2],
    ]);
    expect(broken.id).toBeTruthy();
  });

  it("a failure is still a failure after the app is closed and reopened, and Retry organizing reuses the capture", async () => {
    const client = failing();
    const capture = await client.createCapture({ source: "text", content: TEXT });
    await client.distillCapture(capture.id).catch(() => undefined);

    mobile(client); // first run: the failure is on screen
    expect(await screen.findByText("Your thought is saved.")).toBeTruthy();
    cleanup(); // the app is closed

    phone.start();
    renderMobile(client, "home"); // the app is opened again: a new tree reads only the durable state
    expect(await screen.findByText("Your thought is saved.")).toBeTruthy();
    expect(screen.getByText(/Could not reach the language model/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Retry organizing/ }));

    expect(await screen.findByRole("button", { name: /Improve capture screen/ })).toBeTruthy();
    expect(screen.queryByText("Your thought is saved.")).toBeNull();
    expect((await client.listCaptures()).length, "no duplicate capture").toBe(1);
    expect((await client.listKnowledgeObjects()).length, "no duplicate objects").toBe(2);
    const [state] = await client.listOrganizationStates();
    expect([state!.status, state!.objectCount, state!.failure ?? null]).toEqual(["succeeded", 2, null]);
  });

  it("retrying a capture that was already organized adds nothing", async () => {
    const { client, capture } = await seeded();
    await client.distillCapture(capture.id);
    await client.distillCapture(capture.id);
    expect((await client.listKnowledgeObjects()).length).toBe(2);
    expect((await client.listCaptures()).length).toBe(1);
  });

  it("a capture organized into nothing reads as organized, not as 'not organized yet', after a restart", async () => {
    const client = createPreviewClient({ distillation: NOTHING });
    const capture = await client.createCapture({ source: "text", content: "hmm" });
    await client.distillCapture(capture.id);
    mobile(client);
    expect(await screen.findByText("Nothing to organize in this one.")).toBeTruthy();
    expect(screen.queryByText("Not organized yet.")).toBeNull();
  });

  it("a capture nobody organized reads as 'Not organized yet' with Organize now, only after the states are known", async () => {
    const client = createPreviewClient({ distillation: NOTHING });
    await client.createCapture({ source: "text", content: "never organized" });
    mobile(client);
    expect(await screen.findByText("Not organized yet.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Organize capture/ })).toBeTruthy();
  });

  it("a read of the states that fails changes nothing: the screens behave as before", async () => {
    const client = createPreviewClient({ distillation: NOTHING });
    await client.createCapture({ source: "text", content: "x" });
    vi.spyOn(client, "listOrganizationStates").mockRejectedValue(new Error("boom"));
    mobile(client);
    expect(await screen.findByText("Not organized yet.")).toBeTruthy();
  });
});

describe("batched summaries on the Ideas screen", () => {
  async function fortyNine() {
    const client = createPreviewClient({
      distillation: {
        candidates: (capture) => {
          const words = capture.content.split(" ");
          return words.map((word) => ({ kind: "idea" as const, title: `Idea ${word}`, body: `About ${word}.`, evidence: word }));
        },
      },
    });
    for (let batch = 0; batch < 5; batch += 1) {
      const count = batch < 4 ? 12 : 1;
      const capture = await client.createCapture({ source: "text", content: Array.from({ length: count }, (_, i) => `w${batch}x${i}`).join(" ") });
      await client.distillCapture(capture.id);
    }
    return client;
  }

  it("reads 49 ideas' counts with ONE summaries request and no per-idea history read", async () => {
    const client = await fortyNine();
    const summaries = vi.spyOn(client, "getKnowledgeSummaries");
    const lineage = vi.spyOn(client, "getObjectLineage");
    mobile(client, "ideas");

    await waitFor(() => expect(within(screen.getByRole("list", { name: "Ideas" })).getAllByRole("button").length).toBe(49));
    await waitFor(() => expect(screen.getAllByLabelText("1 revision").length).toBe(49));
    expect(summaries).toHaveBeenCalledTimes(1);
    expect(lineage).not.toHaveBeenCalled();
  });

  it("reads a full history only for an idea that has one, and only when a screen draws it", async () => {
    const client = await fortyNine();
    const [first] = await client.listKnowledgeObjects();
    await client.updateKnowledgeObject(first!.id, { title: "Edited once" });
    await client.updateKnowledgeObject(first!.id, { title: "Edited twice" });
    const lineage = vi.spyOn(client, "getObjectLineage");
    mobile(client, "ideas");
    await waitFor(() => expect(screen.getAllByLabelText(/^\d+ revisions?$/).length).toBeGreaterThan(40), { timeout: 4000 });

    expect(lineage).not.toHaveBeenCalled();
    expect(await screen.findByLabelText("3 revisions")).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: /Edited twice/ }));
    await screen.findByRole("region", { name: /Idea: Edited twice/ });
    await waitFor(() => expect(lineage).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole("list", { name: "Revisions" })).toBeTruthy();
  });

  it("keeps connection counts right: one idea with several, others with none", async () => {
    const client = await fortyNine();
    const objects = await client.listKnowledgeObjects();
    const hub = objects[0]!;
    for (const other of objects.slice(1, 6)) await client.createRelation({ kind: "related_to", sourceObjectId: hub.id, targetObjectId: other.id });
    const summaries = await client.getKnowledgeSummaries();
    expect(summaries.find((s) => s.objectId === hub.id)!.relationCount).toBe(5);
    expect(summaries.filter((s) => s.relationCount === 1).length).toBe(5);
    expect(summaries.filter((s) => s.relationCount === 0).length).toBe(43);
    mobile(client, "ideas");
    expect(await screen.findAllByLabelText("5 connections")).toHaveLength(1);
  });
});

describe("the app going to the background and coming back", () => {
  it("keeps the screen, the open page and the typed words, and only re-reads the permission", async () => {
    const { client } = await seeded();
    const read = vi.spyOn(client, "getMicrophonePermission");
    mobile(client, "ideas");
    fireEvent.click(await screen.findByRole("button", { name: /Email Ignatov/ }));
    await screen.findByRole("region", { name: /Idea: Email Ignatov/ });
    await act(async () => undefined);
    const before = read.mock.calls.length;

    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));

    expect(screen.getByRole("region", { name: /Idea: Email Ignatov/ })).toBeTruthy();
    await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(before));
  });

  it("a recording in progress is discarded when the app goes to the background, with a plain explanation", async () => {
    const client = createPreviewClient({ distillation: NOTHING });
    const cancel = vi.spyOn(client, "cancelVoiceCapture");
    mobile(client);
    fireEvent.click(await screen.findByRole("button", { name: "Speak" }));
    await screen.findByRole("dialog", { name: "Recording" });

    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Recording stopped");
    expect(cancel).toHaveBeenCalled();
  });
});
