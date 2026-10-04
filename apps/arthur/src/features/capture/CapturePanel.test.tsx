import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ArthurClient } from "../../client/arthur-client";
import { VoiceCaptureError } from "../../client/arthur-client";
import { createPreviewClient } from "../../client/preview-client";
import { ArthurProviders } from "../../app/providers";
import { CapturePanel } from "./CapturePanel";

function renderWith(client: ArthurClient) {
  return render(
    <ArthurProviders client={client}>
      <CapturePanel />
    </ArthurProviders>,
  );
}

const typeThought = (text: string) => fireEvent.change(screen.getByLabelText("Thought"), { target: { value: text } });
const save = () => fireEvent.click(screen.getByRole("button", { name: "Save Capture" }));

describe("CapturePanel", () => {
  it("shows an empty state when nothing has been captured", async () => {
    renderWith(createPreviewClient());
    expect(await screen.findByText("No captures yet.")).toBeTruthy();
  });

  it("lists captures that were already persisted, in the order the client returns them", async () => {
    const client = createPreviewClient();
    await client.createCapture({ source: "text", content: "older thought" });
    await client.createCapture({ source: "text", content: "newer thought" });

    renderWith(client);
    const items = await screen.findAllByRole("listitem");
    expect(items.map((item) => item.querySelector(".capture-content")?.textContent)).toEqual(["newer thought", "older thought"]);
  });

  it("saves through ArthurClient.createCapture with the raw text and shows the result", async () => {
    const client = createPreviewClient();
    const createCapture = vi.spyOn(client, "createCapture");
    renderWith(client);
    await screen.findByText("No captures yet.");

    typeThought("  benchmark EMG latency  ");
    save();

    expect(await screen.findByText("benchmark EMG latency")).toBeTruthy();
    expect(createCapture).toHaveBeenCalledExactlyOnceWith({ source: "text", content: "  benchmark EMG latency  " });
    expect((screen.getByLabelText("Thought") as HTMLTextAreaElement).value).toBe("");
  });

  it("does not allow saving a blank thought", async () => {
    const client = createPreviewClient();
    const createCapture = vi.spyOn(client, "createCapture");
    renderWith(client);
    await screen.findByText("No captures yet.");

    typeThought("   ");
    expect((screen.getByRole("button", { name: "Save Capture" }) as HTMLButtonElement).disabled).toBe(true);
    save();
    expect(createCapture).not.toHaveBeenCalled();
  });

  it("keeps the draft and reports the error when saving fails", async () => {
    const client: ArthurClient = { ...createPreviewClient(), createCapture: () => Promise.reject(new Error("disk full")) };
    renderWith(client);
    await screen.findByText("No captures yet.");

    typeThought("keep this");
    save();

    expect((await screen.findByRole("alert")).textContent).toContain("disk full");
    expect((screen.getByLabelText("Thought") as HTMLTextAreaElement).value).toBe("keep this");
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  it("reports a failure to load captures instead of showing an empty list", async () => {
    const client: ArthurClient = { ...createPreviewClient(), listCaptures: () => Promise.reject(new Error("capture database is unreadable")) };
    renderWith(client);

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("unreadable"));
    expect(screen.queryByText("No captures yet.")).toBeNull();
  });
});

const startButton = () => screen.getByRole("button", { name: "Start recording" }) as HTMLButtonElement;
const stopButton = () => screen.getByRole("button", { name: "Stop recording" }) as HTMLButtonElement;

describe("CapturePanel voice capture", () => {
  it("walks idle -> recording -> transcribing -> saved voice capture", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const client = createPreviewClient({ voice: { transcript: () => "remember the milk" } });
    const finish = client.finishVoiceCapture.bind(client);
    client.finishVoiceCapture = async () => {
      await gate;
      return finish();
    };
    renderWith(client);
    await screen.findByText("No captures yet.");

    fireEvent.click(startButton());
    await screen.findByText("Recording…");
    expect(screen.queryByRole("button", { name: "Start recording" })).toBeNull();

    fireEvent.click(stopButton());
    await screen.findByText("Transcribing…");
    expect(startButton().disabled).toBe(true);

    release();
    expect(await screen.findByText("remember the milk")).toBeTruthy();
    expect(screen.getByText(/· voice ·/)).toBeTruthy();
    expect(screen.queryByText("Transcribing…")).toBeNull();
    expect(startButton().disabled).toBe(false);
  });

  it("shows a clear message when the microphone permission is denied and allows trying again", async () => {
    const denied = new VoiceCaptureError("microphone_permission_denied", "Microphone permission was denied. Allow it in settings.");
    const client = createPreviewClient();
    const start = vi.spyOn(client, "startVoiceCapture").mockRejectedValueOnce(denied);
    renderWith(client);
    await screen.findByText("No captures yet.");

    fireEvent.click(startButton());
    expect((await screen.findByRole("alert")).textContent).toContain("Microphone permission was denied");
    expect(startButton().disabled).toBe(false);
    expect(screen.queryByText("Recording…")).toBeNull();

    fireEvent.click(startButton());
    await screen.findByText("Recording…");
    expect(start).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("surfaces a network failure, stores nothing, and a retry succeeds", async () => {
    const offline = new VoiceCaptureError("stt_failed", "Could not reach the speech service. Check the connection and try again.");
    const client = createPreviewClient({ voice: { transcript: () => "second attempt" } });
    const finish = client.finishVoiceCapture.bind(client);
    vi.spyOn(client, "finishVoiceCapture").mockRejectedValueOnce(offline).mockImplementation(finish);
    renderWith(client);
    await screen.findByText("No captures yet.");

    fireEvent.click(startButton());
    await screen.findByText("Recording…");
    fireEvent.click(stopButton());
    expect((await screen.findByRole("alert")).textContent).toContain("Could not reach the speech service");
    expect(screen.queryByRole("listitem")).toBeNull();

    await client.cancelVoiceCapture();
    fireEvent.click(startButton());
    await screen.findByText("Recording…");
    fireEvent.click(stopButton());
    expect(await screen.findByText("second attempt")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports an empty transcript without saving a capture", async () => {
    renderWith(createPreviewClient({ voice: { transcript: () => "   " } }));
    await screen.findByText("No captures yet.");

    fireEvent.click(startButton());
    await screen.findByText("Recording…");
    fireEvent.click(stopButton());

    expect((await screen.findByRole("alert")).textContent).toContain("No speech was recognised");
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  it("goes only through the ArthurClient voice operations", async () => {
    const client = createPreviewClient();
    const start = vi.spyOn(client, "startVoiceCapture");
    const finish = vi.spyOn(client, "finishVoiceCapture");
    renderWith(client);
    await screen.findByText("No captures yet.");

    fireEvent.click(startButton());
    await screen.findByText("Recording…");
    fireEvent.click(stopButton());
    await screen.findByText("Preview voice capture.");

    expect(start).toHaveBeenCalledExactlyOnceWith();
    expect(finish).toHaveBeenCalledExactlyOnceWith();
  });

  it("discards an in-progress recording when the panel goes away", async () => {
    const client = createPreviewClient();
    const cancel = vi.spyOn(client, "cancelVoiceCapture");
    const view = renderWith(client);
    await screen.findByText("No captures yet.");
    fireEvent.click(startButton());
    await screen.findByText("Recording…");

    view.unmount();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not cancel on unmount when nothing is recording", async () => {
    const client = createPreviewClient();
    const cancel = vi.spyOn(client, "cancelVoiceCapture");
    const view = renderWith(client);
    await screen.findByText("No captures yet.");
    view.unmount();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("stops recording and says so when the app is hidden", async () => {
    const client = createPreviewClient();
    const cancel = vi.spyOn(client, "cancelVoiceCapture");
    renderWith(client);
    await screen.findByText("No captures yet.");
    fireEvent.click(startButton());
    await screen.findByText("Recording…");

    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    visibility.mockRestore();

    expect((await screen.findByRole("alert")).textContent).toContain("left the foreground");
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(startButton().disabled).toBe(false);
  });

  it("hides the voice controls when the client cannot capture voice, and text capture still works", async () => {
    const client = { ...createPreviewClient(), capabilities: { voiceCapture: false } };
    renderWith(client);
    await screen.findByText("No captures yet.");
    expect(screen.queryByRole("button", { name: "Start recording" })).toBeNull();

    typeThought("typed thought");
    save();
    expect(await screen.findByText("typed thought")).toBeTruthy();
    expect(screen.getByText(/· text ·/)).toBeTruthy();
  });
});
