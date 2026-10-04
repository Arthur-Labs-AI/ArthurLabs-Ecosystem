import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ArthurClient } from "../../client/arthur-client";
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
