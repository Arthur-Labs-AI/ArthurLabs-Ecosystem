import { describe, expect, it, vi } from "vitest";
import { MAX_SUMMARY_IDS } from "@arthur/contracts";
import { VoiceCaptureError } from "./arthur-client";
import { createArthurClient } from "./index";
import { createPreviewClient } from "./preview-client";
import type { Invoke } from "./tauri-ipc";

const android = { isTauri: true, tauriPlatform: "android" } as const;
const linux = { isTauri: true, tauriPlatform: "linux" } as const;
const voiceCapture = { id: "c1", source: "voice", content: "said it", createdAt: "2026-10-05T10:00:00Z", projectId: "00000000-0000-4000-8000-000000000001" };

describe("temporary-audio retry over IPC", () => {
  it("retries through retry_voice_transcription and returns the persisted voice capture", async () => {
    const call = vi.fn<Invoke>().mockResolvedValue(voiceCapture);
    await expect(createArthurClient(android, call).retryVoiceTranscription()).resolves.toEqual(voiceCapture);
    expect(call).toHaveBeenCalledExactlyOnceWith("retry_voice_transcription");
  });

  it("sends no path, id or audio: the native layer owns the recording", async () => {
    const call = vi.fn<Invoke>().mockResolvedValue(voiceCapture);
    await createArthurClient(android, call).retryVoiceTranscription();
    await createArthurClient(android, call.mockResolvedValue(undefined)).discardVoiceRecording();
    for (const [, args] of call.mock.calls) expect(args).toBeUndefined();
  });

  it("maps the retryable and no-recording errors to VoiceCaptureError with their codes", async () => {
    for (const code of ["stt_retryable", "no_retained_recording", "stt_failed", "empty_transcript"] as const) {
      const call = vi.fn<Invoke>().mockRejectedValue({ code, message: "safe text" });
      const error = await createArthurClient(android, call).retryVoiceTranscription().catch((failure: unknown) => failure);
      expect(error).toBeInstanceOf(VoiceCaptureError);
      expect((error as VoiceCaptureError).code).toBe(code);
    }
  });

  it("rejects a retry answer that is not a voice capture", async () => {
    for (const bad of [null, { ...voiceCapture, source: "text" }, {}]) {
      await expect(createArthurClient(android, vi.fn<Invoke>().mockResolvedValue(bad)).retryVoiceTranscription()).rejects.toThrow("invalid voice capture");
    }
  });

  it("discards through discard_voice_recording", async () => {
    const call = vi.fn<Invoke>().mockResolvedValue(undefined);
    await createArthurClient(android, call).discardVoiceRecording();
    expect(call).toHaveBeenCalledExactlyOnceWith("discard_voice_recording");
  });

  it("the desktop client has no recording to retry and cannot open settings", async () => {
    const client = createArthurClient(linux, vi.fn<Invoke>());
    await expect(client.retryVoiceTranscription()).rejects.toMatchObject({ code: "voice_unavailable" });
    await expect(client.openAppSettings()).rejects.toMatchObject({ code: "voice_unavailable" });
    await expect(client.discardVoiceRecording()).resolves.toBeUndefined();
    await expect(client.getMicrophonePermission()).resolves.toBe("unknown");
  });
});

describe("microphone permission over IPC", () => {
  it.each(["unknown", "granted", "denied", "denied_permanently"] as const)("reads %s without any other command", async (state) => {
    const call = vi.fn<Invoke>().mockResolvedValue(state);
    await expect(createArthurClient(android, call).getMicrophonePermission()).resolves.toBe(state);
    expect(call).toHaveBeenCalledExactlyOnceWith("get_microphone_permission");
  });

  it("refuses an answer that is not one of the four states", async () => {
    for (const bad of ["prompt", "", 1, null, { state: "granted" }]) {
      await expect(createArthurClient(android, vi.fn<Invoke>().mockResolvedValue(bad)).getMicrophonePermission()).rejects.toThrow("invalid microphone permission");
    }
  });

  it("opens the app settings through open_app_settings, passing nothing (no intent, no package name)", async () => {
    const call = vi.fn<Invoke>().mockResolvedValue(undefined);
    await createArthurClient(android, call).openAppSettings();
    expect(call).toHaveBeenCalledExactlyOnceWith("open_app_settings");
  });

  it("maps a settings failure to a VoiceCaptureError", async () => {
    const call = vi.fn<Invoke>().mockRejectedValue({ code: "recording_failed", message: "Settings could not be opened" });
    await expect(createArthurClient(android, call).openAppSettings()).rejects.toBeInstanceOf(VoiceCaptureError);
  });
});

describe("durable organization state over IPC", () => {
  const states = [
    { captureId: "a", status: "pending", objectCount: 0, failure: null },
    { captureId: "b", status: "running", objectCount: 0, failure: null },
    { captureId: "c", status: "succeeded", objectCount: 2, failure: null },
    { captureId: "d", status: "succeeded", objectCount: 0, failure: null },
    { captureId: "e", status: "failed", objectCount: 0, failure: { code: "llm_failed", message: "Could not reach the language model.", failedAt: "2026-10-05T10:00:00Z" } },
  ];

  it("lists the five situations in one command", async () => {
    const call = vi.fn<Invoke>().mockResolvedValue(states);
    await expect(createArthurClient(android, call).listOrganizationStates()).resolves.toEqual(states);
    expect(call).toHaveBeenCalledExactlyOnceWith("list_organization_states");
  });

  it("refuses malformed states, including a failure with no reason", async () => {
    for (const bad of [{ captureId: "a", status: "done", objectCount: 0 }, { captureId: "", status: "pending", objectCount: 0 }, { captureId: "a", status: "failed", objectCount: 0, failure: null }, { captureId: "a", status: "succeeded", objectCount: -1 }, { captureId: "a", status: "pending", objectCount: 0, failure: { code: "llm_failed", message: "x", failedAt: "t" } }]) {
      await expect(createArthurClient(android, vi.fn<Invoke>().mockResolvedValue([bad])).listOrganizationStates()).rejects.toThrow("invalid organization states");
    }
  });
});

describe("batched knowledge summaries over IPC", () => {
  const summary = { objectId: "o1", relationCount: 3, revisionCount: 2, updatedAt: "2026-10-05T10:00:00Z", currentRevisionId: "r2" };

  it("asks for every object with one command and no arguments", async () => {
    const call = vi.fn<Invoke>().mockResolvedValue([summary]);
    await expect(createArthurClient(android, call).getKnowledgeSummaries()).resolves.toEqual([summary]);
    expect(call).toHaveBeenCalledExactlyOnceWith("get_knowledge_summaries", {});
  });

  it("passes the ids it is given, in the same single command", async () => {
    const call = vi.fn<Invoke>().mockResolvedValue([summary]);
    await createArthurClient(android, call).getKnowledgeSummaries(["o1", "o2"]);
    expect(call).toHaveBeenCalledExactlyOnceWith("get_knowledge_summaries", { objectIds: ["o1", "o2"] });
  });

  it("refuses malformed summaries", async () => {
    for (const bad of [{ ...summary, relationCount: -1 }, { ...summary, revisionCount: 1.5 }, { ...summary, updatedAt: "" }, { objectId: "o1" }]) {
      await expect(createArthurClient(android, vi.fn<Invoke>().mockResolvedValue([bad])).getKnowledgeSummaries()).rejects.toThrow("invalid knowledge summaries");
    }
  });

  it("the bound the native layer enforces is the one in the contract", () => {
    expect(MAX_SUMMARY_IDS).toBe(1000);
  });
});

describe("the preview client behaves like the native layer", () => {
  const retryable = new VoiceCaptureError("stt_retryable", "Could not reach the speech service. Your recording is kept for up to 15 minutes so you can try again without speaking again.");

  it("keeps the recording after a retryable failure, retries without recording again, and keeps nothing afterwards", async () => {
    const client = createPreviewClient({ voice: { finishError: retryable, transcript: () => "second try" } });
    await client.startVoiceCapture();
    await expect(client.finishVoiceCapture()).rejects.toMatchObject({ code: "stt_retryable" });
    const start = vi.spyOn(client, "startVoiceCapture");
    const capture = await client.retryVoiceTranscription();
    expect(capture).toMatchObject({ source: "voice", content: "second try" });
    expect(start).not.toHaveBeenCalled();
    expect((await client.listCaptures()).length).toBe(1);
    await expect(client.retryVoiceTranscription()).rejects.toMatchObject({ code: "no_retained_recording" });
  });

  it("a final failure keeps nothing, discard keeps nothing, and starting again keeps nothing", async () => {
    const final = createPreviewClient({ voice: { finishError: new VoiceCaptureError("stt_failed", "rejected") } });
    await final.startVoiceCapture();
    await final.finishVoiceCapture().catch(() => undefined);
    await expect(final.retryVoiceTranscription()).rejects.toMatchObject({ code: "no_retained_recording" });

    const discarded = createPreviewClient({ voice: { finishError: retryable } });
    await discarded.startVoiceCapture();
    await discarded.finishVoiceCapture().catch(() => undefined);
    await discarded.discardVoiceRecording();
    await expect(discarded.retryVoiceTranscription()).rejects.toMatchObject({ code: "no_retained_recording" });

    const restarted = createPreviewClient({ voice: { finishError: retryable } });
    await restarted.startVoiceCapture();
    await restarted.finishVoiceCapture().catch(() => undefined);
    await restarted.startVoiceCapture();
    await expect(restarted.retryVoiceTranscription()).rejects.toMatchObject({ code: "no_retained_recording" });
  });

  it("a retry that fails again keeps the recording; a final retry failure deletes it", async () => {
    const client = createPreviewClient({ voice: { finishError: retryable, retryErrors: [retryable, new VoiceCaptureError("stt_failed", "rejected")] } });
    await client.startVoiceCapture();
    await client.finishVoiceCapture().catch(() => undefined);
    await expect(client.retryVoiceTranscription()).rejects.toMatchObject({ code: "stt_retryable" });
    await expect(client.retryVoiceTranscription()).rejects.toMatchObject({ code: "stt_failed" });
    await expect(client.retryVoiceTranscription()).rejects.toMatchObject({ code: "no_retained_recording" });
    expect((await client.listCaptures()).length).toBe(0);
  });

  it("reads the permission without starting anything, and a start changes what it reports", async () => {
    const client = createPreviewClient();
    const start = vi.spyOn(client, "startVoiceCapture");
    expect(await client.getMicrophonePermission()).toBe("unknown");
    expect(start).not.toHaveBeenCalled();
    await client.startVoiceCapture();
    expect(await client.getMicrophonePermission()).toBe("granted");
  });
});
