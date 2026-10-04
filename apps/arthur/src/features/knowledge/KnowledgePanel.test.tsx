import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ArthurProviders } from "../../app/providers";
import { DistillationError, type ArthurClient } from "../../client/arthur-client";
import { createPreviewClient, type PreviewClientOptions } from "../../client/preview-client";
import { CapturePanel } from "../capture/CapturePanel";
import { KnowledgePanel } from "./KnowledgePanel";

const TEXT = "I want to improve the Arthur capture screen. Tomorrow I also need to email Ignatov about the competition.";

const TWO_OBJECTS: PreviewClientOptions["distillation"] = {
  candidates: () => [
    { kind: "idea", title: "Improve capture screen", body: "Improve the Arthur capture screen.", evidence: "improve the Arthur capture screen" },
    { kind: "task", title: "Email Ignatov", body: "Email Ignatov about the competition.", evidence: "email Ignatov about the competition" },
  ],
};

async function setup(options: PreviewClientOptions = {}, content = TEXT) {
  const client = createPreviewClient(options);
  const capture = await client.createCapture({ source: "text", content });
  render(
    <ArthurProviders client={client}>
      <CapturePanel />
      <KnowledgePanel />
    </ArthurProviders>,
  );
  await screen.findByLabelText("Captures to distill");
  return { client, capture };
}

const distillButton = (id: string) => screen.getByRole("button", { name: `Distill capture ${id.slice(0, 8)}` }) as HTMLButtonElement;

describe("KnowledgePanel", () => {
  it("distills a capture and shows each object's kind, title, body and source capture", async () => {
    const { capture } = await setup({ distillation: TWO_OBJECTS });
    expect(await screen.findByText("No knowledge objects yet.")).toBeTruthy();

    fireEvent.click(distillButton(capture.id));
    const list = await screen.findByLabelText("Knowledge objects");
    const items = within(list).getAllByRole("listitem");

    expect(items).toHaveLength(2);
    expect(within(items[0]!).getByText("idea")).toBeTruthy();
    expect(within(items[0]!).getByText("Improve capture screen")).toBeTruthy();
    expect(within(items[0]!).getByText("Improve the Arthur capture screen.")).toBeTruthy();
    expect(within(items[1]!).getByText("task")).toBeTruthy();
    expect(within(items[1]!).getByText("Email Ignatov")).toBeTruthy();
    for (const item of items) expect(within(item).getByText(new RegExp(`From capture ${capture.id.slice(0, 8)}`))).toBeTruthy();
    expect(distillButton(capture.id).disabled).toBe(true);
    expect(distillButton(capture.id).textContent).toBe("Distilled");
  });

  it("shows a loading state while distilling and allows only one distillation at a time", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const client = createPreviewClient({ distillation: TWO_OBJECTS });
    const first = await client.createCapture({ source: "text", content: TEXT });
    const second = await client.createCapture({ source: "text", content: "another thought about nothing" });
    const real = client.distillCapture.bind(client);
    const distill = vi.spyOn(client, "distillCapture").mockImplementation(async (id) => {
      await gate;
      return real(id);
    });
    render(
      <ArthurProviders client={client}>
        <KnowledgePanel />
      </ArthurProviders>,
    );
    await screen.findByLabelText("Captures to distill");

    fireEvent.click(distillButton(first.id));
    expect(await screen.findAllByText("Distilling…")).toBeTruthy();
    expect(distillButton(second.id).disabled).toBe(true);
    fireEvent.click(distillButton(first.id));
    expect(distill).toHaveBeenCalledTimes(1);

    release();
    expect(await screen.findByLabelText("Knowledge objects")).toBeTruthy();
    expect(screen.queryByText("Distilling…")).toBeNull();
  });

  it("View source highlights exactly the span the object came from, inside the untouched capture text", async () => {
    const { capture } = await setup({ distillation: TWO_OBJECTS });
    fireEvent.click(distillButton(capture.id));
    const items = within(await screen.findByLabelText("Knowledge objects")).getAllByRole("listitem");

    fireEvent.click(within(items[1]!).getByRole("button", { name: "View source" }));
    const source = within(items[1]!).getByLabelText("Original capture text");

    expect(source.textContent).toBe(TEXT);
    expect(source.querySelector("mark")?.textContent).toBe("email Ignatov about the competition");
    expect(within(items[1]!).getByRole("button", { name: "Hide source" }).getAttribute("aria-expanded")).toBe("true");
    // The first object is unaffected.
    expect(within(items[0]!).queryByLabelText("Original capture text")).toBeNull();

    fireEvent.click(within(items[1]!).getByRole("button", { name: "Hide source" }));
    expect(within(items[1]!).queryByLabelText("Original capture text")).toBeNull();
  });

  it("highlights the exact characters for Bulgarian text containing an emoji", async () => {
    const content = "Искам да подобря екрана 😀 и утре да пиша на Игнатов.";
    const { capture } = await setup(
      { distillation: { candidates: () => [{ kind: "task", title: "Пиша на Игнатов", body: "Да пиша на Игнатов.", evidence: "да пиша на Игнатов" }] } },
      content,
    );
    fireEvent.click(distillButton(capture.id));
    fireEvent.click(await screen.findByRole("button", { name: "View source" }));

    const source = screen.getByLabelText("Original capture text");
    expect(source.textContent).toBe(content);
    expect(source.querySelector("mark")?.textContent).toBe("да пиша на Игнатов");
  });

  it("says so when a capture has nothing to structure, and does not retry", async () => {
    const { client, capture } = await setup({ distillation: { candidates: () => [] } }, "hmm");
    const distill = vi.spyOn(client, "distillCapture");

    fireEvent.click(distillButton(capture.id));
    expect(await screen.findByText("Nothing to structure in this capture.")).toBeTruthy();
    expect(screen.getByText("No knowledge objects yet.")).toBeTruthy();
    expect(distill).toHaveBeenCalledTimes(1);
  });

  it("surfaces a provider failure, stores nothing, and a retry succeeds", async () => {
    const { capture } = await setup({ distillation: { ...TWO_OBJECTS, error: new DistillationError("llm_failed", "Could not reach the language model. Check the connection and try again."), once: true } });

    fireEvent.click(distillButton(capture.id));
    expect((await screen.findByRole("alert")).textContent).toContain("Could not reach the language model");
    expect(screen.queryByLabelText("Knowledge objects")).toBeNull();
    expect(distillButton(capture.id).disabled).toBe(false);

    fireEvent.click(distillButton(capture.id));
    expect(await screen.findByLabelText("Knowledge objects")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("reports untrustworthy model output without showing anything", async () => {
    const { capture } = await setup({ distillation: { candidates: () => [{ kind: "note", title: "x", body: "x", evidence: "never said" }] } });
    fireEvent.click(distillButton(capture.id));
    expect((await screen.findByRole("alert")).textContent).toContain("could not be trusted");
    expect(screen.queryByLabelText("Knowledge objects")).toBeNull();
  });

  it("lists objects that were already persisted when it opens, and never offers to distill them again", async () => {
    const client = createPreviewClient({ distillation: TWO_OBJECTS });
    const capture = await client.createCapture({ source: "voice", content: TEXT });
    await client.distillCapture(capture.id);
    const distill = vi.spyOn(client, "distillCapture");

    render(
      <ArthurProviders client={client}>
        <KnowledgePanel />
      </ArthurProviders>,
    );

    expect(await screen.findByLabelText("Knowledge objects")).toBeTruthy();
    expect(distillButton(capture.id).disabled).toBe(true);
    fireEvent.click(distillButton(capture.id));
    expect(distill).not.toHaveBeenCalled();
  });

  it("reports a failure to load knowledge instead of showing an empty list", async () => {
    const client: ArthurClient = { ...createPreviewClient(), listKnowledgeObjects: () => Promise.reject(new Error("knowledge database is unreadable")) };
    render(
      <ArthurProviders client={client}>
        <KnowledgePanel />
      </ArthurProviders>,
    );
    await waitFor(() => expect(screen.getByRole("alert").textContent).toContain("unreadable"));
    expect(screen.queryByText("No knowledge objects yet.")).toBeNull();
  });

  it("only goes through the ArthurClient distillation operations", async () => {
    const { client, capture } = await setup({ distillation: TWO_OBJECTS });
    const distill = vi.spyOn(client, "distillCapture");
    fireEvent.click(distillButton(capture.id));
    await screen.findByLabelText("Knowledge objects");
    expect(distill).toHaveBeenCalledExactlyOnceWith(capture.id);
  });
});

describe("Capture and Knowledge panels together", () => {
  it("a capture created in the Capture panel appears for distillation, for text and for voice, and both stay intact", async () => {
    const client = createPreviewClient({ voice: { transcript: () => "Spoken: email Ignatov tomorrow." } });
    render(
      <ArthurProviders client={client}>
        <CapturePanel />
        <KnowledgePanel />
      </ArthurProviders>,
    );
    await screen.findByText("No captures yet.");

    fireEvent.change(screen.getByLabelText("Thought"), { target: { value: "Typed: improve the screen." } });
    fireEvent.click(screen.getByRole("button", { name: "Save Capture" }));
    fireEvent.click(await screen.findByRole("button", { name: "Start recording" }));
    await screen.findByText("Recording…");
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));

    const distillList = await screen.findByLabelText("Captures to distill");
    await waitFor(() => expect(within(distillList).getAllByRole("listitem")).toHaveLength(2));
    expect(within(distillList).getByText("Typed: improve the screen.")).toBeTruthy();
    expect(within(distillList).getByText("Spoken: email Ignatov tomorrow.")).toBeTruthy();
    expect(within(screen.getByLabelText("Captures")).getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText(/· voice ·/)).toBeTruthy();
    expect(screen.getByText(/· text ·/)).toBeTruthy();
  });
});
