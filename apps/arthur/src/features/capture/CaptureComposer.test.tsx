import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ArthurClient } from "../../client/arthur-client";
import { VoiceCaptureError } from "../../client/arthur-client";
import { createPreviewClient } from "../../client/preview-client";
import { ArthurProviders } from "../../app/providers";
import { NOTHING, deferred, renderApp } from "../../test/render";
import { INBOX_PROJECT_ID } from "@arthur/contracts";
import { useCaptures } from "./captures-context";

const quiet = (extra: Parameters<typeof createPreviewClient>[0] = {}) => createPreviewClient({ distillation: NOTHING, ...extra });
const thought = () => screen.getByLabelText("Thought") as HTMLTextAreaElement;
const typeThought = (text: string) => fireEvent.change(thought(), { target: { value: text } });
const composer = () => screen.getByRole("form", { name: "Capture a thought" });
const captureButton = () => within(composer()).getByRole("button", { name: /^Capture/ }) as HTMLButtonElement;
const capture = () => fireEvent.click(captureButton());
const startButton = () => screen.getByRole("button", { name: "Start recording" }) as HTMLButtonElement;
const stopButton = () => screen.getByRole("button", { name: "Stop recording" }) as HTMLButtonElement;
const captureArticles = () => screen.queryAllByRole("article");

describe("Home composer: text capture", () => {
  it("shows an empty state when nothing has been captured", async () => {
    renderApp(quiet());
    expect(await screen.findByText("Nothing captured yet")).toBeTruthy();
  });

  it("lists captures that were already persisted, newest first, as the client returns them", async () => {
    const client = quiet();
    await client.createCapture({ source: "text", content: "older thought" });
    await client.createCapture({ source: "text", content: "newer thought" });

    renderApp(client);
    await screen.findByText("newer thought");
    expect(captureArticles().map((article) => article.querySelector("q")?.textContent)).toEqual(["newer thought", "older thought"]);
  });

  it("saves through ArthurClient.createCapture with the raw text and shows the result", async () => {
    const client = quiet();
    const createCapture = vi.spyOn(client, "createCapture");
    renderApp(client);
    await screen.findByText("Nothing captured yet");

    typeThought("  benchmark EMG latency  ");
    capture();

    expect(await screen.findByText("benchmark EMG latency")).toBeTruthy();
    expect(createCapture).toHaveBeenCalledExactlyOnceWith({ source: "text", content: "  benchmark EMG latency  ", projectId: INBOX_PROJECT_ID });
    expect(thought().value).toBe("");
  });

  it("captures with Ctrl+Enter from the keyboard", async () => {
    const client = quiet();
    const createCapture = vi.spyOn(client, "createCapture");
    renderApp(client);
    await screen.findByText("Nothing captured yet");

    typeThought("keyboard capture");
    fireEvent.keyDown(thought(), { key: "Enter", ctrlKey: true });

    await screen.findByText("keyboard capture");
    expect(createCapture).toHaveBeenCalledTimes(1);
  });

  it("does not allow capturing a blank thought", async () => {
    const client = quiet();
    const createCapture = vi.spyOn(client, "createCapture");
    renderApp(client);
    await screen.findByText("Nothing captured yet");

    typeThought("   ");
    expect(captureButton().disabled).toBe(true);
    fireEvent.keyDown(thought(), { key: "Enter", ctrlKey: true });
    expect(createCapture).not.toHaveBeenCalled();
  });

  it("keeps the draft and reports the error when saving fails, and never starts organizing", async () => {
    const base = quiet();
    const distill = vi.spyOn(base, "distillCapture");
    const client: ArthurClient = { ...base, createCapture: () => Promise.reject(new Error("disk full")) };
    renderApp(client);
    await screen.findByText("Nothing captured yet");

    typeThought("keep this");
    capture();

    expect((await screen.findByRole("alert")).textContent).toContain("disk full");
    expect(thought().value).toBe("keep this");
    expect(captureArticles()).toHaveLength(0);
    expect(distill).not.toHaveBeenCalled();
  });

  it("reports a failure to load captures instead of showing an empty list", async () => {
    const client: ArthurClient = { ...quiet(), listCaptures: () => Promise.reject(new Error("capture database is unreadable")) };
    renderApp(client);

    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("unreadable"));
    expect(screen.queryByText("Nothing captured yet")).toBeNull();
  });
});

describe("Home composer: voice capture", () => {
  it("walks idle -> recording -> transcribing -> saved voice capture", async () => {
    const gate = deferred();
    const client = quiet({ voice: { transcript: () => "remember the milk" } });
    const finish = client.finishVoiceCapture.bind(client);
    client.finishVoiceCapture = async () => {
      await gate.promise;
      return finish();
    };
    renderApp(client);
    await screen.findByText("Nothing captured yet");

    fireEvent.click(startButton());
    await screen.findByText("Recording…");
    expect(screen.queryByRole("button", { name: "Start recording" })).toBeNull();

    fireEvent.click(stopButton());
    await screen.findByText("Transcribing…");
    expect(startButton().disabled).toBe(true);

    gate.resolve();
    expect(await screen.findByText("remember the milk")).toBeTruthy();
    expect(screen.getByText("Voice")).toBeTruthy();
    expect(screen.queryByText("Transcribing…")).toBeNull();
    expect(startButton().disabled).toBe(false);
  });

  it("shows a clear message when the microphone permission is denied and allows trying again", async () => {
    const denied = new VoiceCaptureError("microphone_permission_denied", "Microphone permission was denied. Allow it in settings.");
    const client = quiet();
    const start = vi.spyOn(client, "startVoiceCapture").mockRejectedValueOnce(denied);
    renderApp(client);
    await screen.findByText("Nothing captured yet");

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
    const client = quiet({ voice: { transcript: () => "second attempt" } });
    const finish = client.finishVoiceCapture.bind(client);
    vi.spyOn(client, "finishVoiceCapture").mockRejectedValueOnce(offline).mockImplementation(finish);
    renderApp(client);
    await screen.findByText("Nothing captured yet");

    fireEvent.click(startButton());
    await screen.findByText("Recording…");
    fireEvent.click(stopButton());
    expect((await screen.findByRole("alert")).textContent).toContain("Could not reach the speech service");
    expect(captureArticles()).toHaveLength(0);

    await client.cancelVoiceCapture();
    fireEvent.click(startButton());
    await screen.findByText("Recording…");
    fireEvent.click(stopButton());
    expect(await screen.findByText("second attempt")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports an empty transcript without saving a capture", async () => {
    renderApp(quiet({ voice: { transcript: () => "   " } }));
    await screen.findByText("Nothing captured yet");

    fireEvent.click(startButton());
    await screen.findByText("Recording…");
    fireEvent.click(stopButton());

    expect((await screen.findByRole("alert")).textContent).toContain("No speech was recognised");
    expect(captureArticles()).toHaveLength(0);
  });

  it("goes only through the ArthurClient voice operations", async () => {
    const client = quiet();
    const start = vi.spyOn(client, "startVoiceCapture");
    const finish = vi.spyOn(client, "finishVoiceCapture");
    renderApp(client);
    await screen.findByText("Nothing captured yet");

    fireEvent.click(startButton());
    await screen.findByText("Recording…");
    fireEvent.click(stopButton());
    await screen.findByText("Preview voice capture.");

    expect(start).toHaveBeenCalledExactlyOnceWith();
    expect(finish).toHaveBeenCalledExactlyOnceWith(INBOX_PROJECT_ID); // the capture goes into the active project
  });

  it("discards an in-progress recording when the app goes away", async () => {
    const client = quiet();
    const cancel = vi.spyOn(client, "cancelVoiceCapture");
    const view = renderApp(client);
    await screen.findByText("Nothing captured yet");
    fireEvent.click(startButton());
    await screen.findByText("Recording…");

    view.unmount();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("does not cancel on unmount when nothing is recording", async () => {
    const client = quiet();
    const cancel = vi.spyOn(client, "cancelVoiceCapture");
    const view = renderApp(client);
    await screen.findByText("Nothing captured yet");
    view.unmount();
    expect(cancel).not.toHaveBeenCalled();
  });

  it("stops recording and says so when the app is hidden", async () => {
    const client = quiet();
    const cancel = vi.spyOn(client, "cancelVoiceCapture");
    renderApp(client);
    await screen.findByText("Nothing captured yet");
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
    const client = { ...quiet(), capabilities: { voiceCapture: false } };
    renderApp(client);
    await screen.findByText("Nothing captured yet");
    expect(screen.queryByRole("button", { name: "Start recording" })).toBeNull();

    typeThought("typed thought");
    capture();
    expect(await screen.findByText("typed thought")).toBeTruthy();
    expect(screen.getByText("Typed")).toBeTruthy();
  });
});

describe("capture subscribers", () => {
  function Probe({ listener }: { listener: () => void }) {
    const { subscribe, save, captures } = useCaptures();
    return (
      <>
        <button type="button" onClick={() => subscribe(listener)}>
          subscribe
        </button>
        <button type="button" onClick={() => void save("saved anyway")}>
          save
        </button>
        <p>{captures.length} saved</p>
      </>
    );
  }

  it("a subscriber that throws can never fail or undo a capture", async () => {
    const client = quiet();
    const listener = vi.fn(() => {
      throw new Error("subscriber exploded");
    });
    render(
      <ArthurProviders client={client}>
        <Probe listener={listener} />
      </ArthurProviders>,
    );
    fireEvent.click(screen.getByText("subscribe"));
    fireEvent.click(screen.getByText("save"));

    expect(await screen.findByText("1 saved")).toBeTruthy();
    expect(listener).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(await client.listCaptures()).toHaveLength(1);
  });
});
