import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { KnowledgeObject } from "@arthur/contracts";
import { ArthurProviders } from "../../app/providers";
import { DistillationError, type ArthurClient } from "../../client/arthur-client";
import { createPreviewClient } from "../../client/preview-client";
import { TEXT, TWO_OBJECTS, deferred, renderApp } from "../../test/render";
import { useKnowledge } from "../knowledge/knowledge-context";

const thought = () => screen.getByLabelText("Thought") as HTMLTextAreaElement;
const typeAndCapture = (text: string) => {
  fireEvent.change(thought(), { target: { value: text } });
  fireEvent.click(within(screen.getByRole("form", { name: "Capture a thought" })).getByRole("button", { name: /^Capture/ }));
};
const articleFor = async (text: string) => {
  const quote = await screen.findByText((_, node) => node?.tagName === "Q" && (node.textContent ?? "").includes(text));
  return quote.closest("article") as HTMLElement;
};

describe("auto-organize: after a successful capture", () => {
  it("persists the Capture FIRST, then starts distillation with that capture's id", async () => {
    const client = createPreviewClient({ distillation: TWO_OBJECTS });
    const order: string[] = [];
    const create = client.createCapture.bind(client);
    const distill = client.distillCapture.bind(client);
    vi.spyOn(client, "createCapture").mockImplementation(async (input) => {
      const saved = await create(input);
      order.push(`persisted:${saved.id}`);
      return saved;
    });
    vi.spyOn(client, "distillCapture").mockImplementation((id) => {
      order.push(`distill:${id}`);
      return distill(id);
    });
    renderApp(client);
    await screen.findByText("Nothing captured yet");

    typeAndCapture(TEXT);
    await screen.findByText("Improve capture screen");

    const saved = (await client.listCaptures())[0]!;
    expect(order).toEqual([`persisted:${saved.id}`, `distill:${saved.id}`]);
  });

  it("shows a lightweight 'Arthur is organizing…' state, then the ideas under the capture they came from", async () => {
    const gate = deferred();
    const client = createPreviewClient({ distillation: TWO_OBJECTS });
    const distill = client.distillCapture.bind(client);
    vi.spyOn(client, "distillCapture").mockImplementation(async (id) => {
      await gate.promise;
      return distill(id);
    });
    renderApp(client);
    await screen.findByText("Nothing captured yet");

    typeAndCapture(TEXT);
    const article = await articleFor("improve the Arthur capture screen");
    // The raw words are on screen immediately, before any model answers.
    expect(within(article).getByText("Arthur is organizing…")).toBeTruthy();
    expect(within(article).queryByText("Improve capture screen")).toBeNull();
    expect(thought().value).toBe("");

    gate.resolve();
    expect(await within(article).findByText("Improve capture screen")).toBeTruthy();
    expect(within(article).getByText("Email Ignatov")).toBeTruthy();
    expect(within(article).queryByText("Arthur is organizing…")).toBeNull();
  });

  it("capture success never depends on the model: a failing model leaves the capture saved and visible", async () => {
    const client = createPreviewClient({ distillation: { ...TWO_OBJECTS, error: new DistillationError("llm_failed", "Could not reach the language model. Nothing was saved."), once: true } });
    renderApp(client);
    await screen.findByText("Nothing captured yet");

    typeAndCapture(TEXT);
    const article = await articleFor("improve the Arthur capture screen");

    // The capture itself succeeded: persisted, shown, draft cleared. The failure belongs to organizing only.
    const stored = await client.listCaptures();
    expect(stored).toHaveLength(1);
    expect(stored[0]!.content).toBe(TEXT);
    expect(thought().value).toBe("");
    expect((await within(article).findByRole("alert")).textContent).toContain("Your words are saved");
    expect(within(article).getByText(/Could not reach the language model/)).toBeTruthy();
    // No alert about the capture, only about organizing.
    expect(screen.getAllByRole("alert")).toHaveLength(1);
  });

  it("on failure the Capture is preserved UNCHANGED, no knowledge object exists, and a retry is offered", async () => {
    const client = createPreviewClient({ distillation: { ...TWO_OBJECTS, error: new DistillationError("llm_failed", "Could not reach the language model."), once: true } });
    renderApp(client);
    await screen.findByText("Nothing captured yet");
    typeAndCapture(TEXT);
    const article = await articleFor("improve the Arthur capture screen");
    await within(article).findByRole("alert");

    const [stored] = await client.listCaptures();
    expect(stored).toMatchObject({ source: "text", content: TEXT });
    expect(await client.listKnowledgeObjects()).toEqual([]);
    expect(within(article).getByRole("button", { name: /Retry organizing capture/ })).toBeTruthy();
    // The capture's own text is still shown verbatim.
    expect(article.querySelector("q")?.textContent).toContain("improve the Arthur capture screen");
  });

  it("retry runs distillation again for the same capture and then shows the ideas", async () => {
    const client = createPreviewClient({ distillation: { ...TWO_OBJECTS, error: new DistillationError("llm_failed", "Could not reach the language model."), once: true } });
    const distill = vi.spyOn(client, "distillCapture");
    renderApp(client);
    await screen.findByText("Nothing captured yet");
    typeAndCapture(TEXT);
    const article = await articleFor("improve the Arthur capture screen");
    fireEvent.click(await within(article).findByRole("button", { name: /Retry organizing capture/ }));

    expect(await within(article).findByText("Improve capture screen")).toBeTruthy();
    expect(within(article).queryByRole("alert")).toBeNull();
    const id = (await client.listCaptures())[0]!.id;
    expect(distill).toHaveBeenCalledTimes(2);
    expect(distill).toHaveBeenNthCalledWith(1, id);
    expect(distill).toHaveBeenNthCalledWith(2, id);
    expect(await client.listKnowledgeObjects()).toHaveLength(2);
  });

  it("untrustworthy model output creates NO partial objects, says so, and offers a retry", async () => {
    const client = createPreviewClient({
      distillation: {
        candidates: () => [
          { kind: "idea", title: "Real one", body: "Improve the Arthur capture screen.", evidence: "improve the Arthur capture screen" },
          { kind: "note", title: "Invented", body: "x", evidence: "never said this" },
        ],
      },
    });
    renderApp(client);
    await screen.findByText("Nothing captured yet");
    typeAndCapture(TEXT);
    const article = await articleFor("improve the Arthur capture screen");

    expect((await within(article).findByText(/could not be trusted/)).textContent).toBeTruthy();
    // One valid candidate plus one invalid: all or nothing. The valid one must not leak through.
    expect(within(article).queryByText("Real one")).toBeNull();
    expect(await client.listKnowledgeObjects()).toEqual([]);
    expect(within(article).getByRole("button", { name: /Retry organizing capture/ })).toBeTruthy();
  });

  it("a capture with nothing to structure says so and is not retried automatically", async () => {
    const client = createPreviewClient({ distillation: { candidates: () => [] } });
    const distill = vi.spyOn(client, "distillCapture");
    renderApp(client);
    await screen.findByText("Nothing captured yet");

    typeAndCapture("hmm");
    expect(await screen.findByText("Nothing to structure in this capture.")).toBeTruthy();
    expect(distill).toHaveBeenCalledTimes(1);
  });

  it("organizes voice captures too, right after the transcript is saved", async () => {
    const client = createPreviewClient({ voice: { transcript: () => "Spoken: email Ignatov tomorrow." }, distillation: { candidates: (c) => [{ kind: "task", title: "Email Ignatov", body: c.content, evidence: "email Ignatov tomorrow" }] } });
    const distill = vi.spyOn(client, "distillCapture");
    renderApp(client);
    await screen.findByText("Nothing captured yet");

    fireEvent.click(screen.getByRole("button", { name: "Start recording" }));
    await screen.findByText("Recording…");
    fireEvent.click(screen.getByRole("button", { name: "Stop recording" }));

    expect(await screen.findByText("Email Ignatov")).toBeTruthy();
    const voice = (await client.listCaptures())[0]!;
    expect(voice.source).toBe("voice");
    expect(distill).toHaveBeenCalledExactlyOnceWith(voice.id);
  });

  it("never organizes a capture that failed to save", async () => {
    const base = createPreviewClient({ distillation: TWO_OBJECTS });
    const distill = vi.spyOn(base, "distillCapture");
    const client: ArthurClient = { ...base, createCapture: () => Promise.reject(new Error("disk full")) };
    renderApp(client);
    await screen.findByText("Nothing captured yet");

    typeAndCapture(TEXT);
    await screen.findByRole("alert");
    expect(distill).not.toHaveBeenCalled();
  });

  it("organizes one capture at a time, in order: a second capture waits its turn", async () => {
    const gates = [deferred(), deferred()];
    let active = 0;
    let peak = 0;
    const started: string[] = [];
    const client = createPreviewClient({ distillation: { candidates: (c) => [{ kind: "note", title: `Note: ${c.content}`, body: c.content, evidence: c.content }] } });
    const distill = client.distillCapture.bind(client);
    vi.spyOn(client, "distillCapture").mockImplementation(async (id) => {
      const turn = started.length;
      started.push(id);
      active += 1;
      peak = Math.max(peak, active);
      await gates[turn]?.promise;
      active -= 1;
      return distill(id);
    });
    renderApp(client);
    await screen.findByText("Nothing captured yet");

    typeAndCapture("first thought");
    const first = await articleFor("first thought");
    await within(first).findByText("Arthur is organizing…");
    typeAndCapture("second thought");
    const second = await articleFor("second thought");
    expect(within(second).getByText("Waiting to organize…")).toBeTruthy();
    expect(started).toHaveLength(1);

    gates[0]!.resolve();
    await within(first).findByText("Note: first thought");
    await within(second).findByText("Arthur is organizing…");
    gates[1]!.resolve();
    await within(second).findByText("Note: second thought");
    expect(peak).toBe(1);
    expect(started).toHaveLength(2);
  });

  it("does not organize captures that existed before the app opened, but offers to", async () => {
    const client = createPreviewClient({ distillation: TWO_OBJECTS });
    const old = await client.createCapture({ source: "text", content: TEXT });
    const distill = vi.spyOn(client, "distillCapture");
    renderApp(client);

    const article = await articleFor("improve the Arthur capture screen");
    expect(await within(article).findByText("Not organized yet.")).toBeTruthy();
    expect(distill).not.toHaveBeenCalled();

    fireEvent.click(within(article).getByRole("button", { name: /Organize capture/ }));
    expect(await within(article).findByText("Improve capture screen")).toBeTruthy();
    expect(distill).toHaveBeenCalledExactlyOnceWith(old.id);
  });

  it("does not organize an already organized capture again", async () => {
    const client = createPreviewClient({ distillation: TWO_OBJECTS });
    const old = await client.createCapture({ source: "text", content: TEXT });
    await client.distillCapture(old.id);
    const distill = vi.spyOn(client, "distillCapture");
    renderApp(client);

    expect(await screen.findByText("Improve capture screen")).toBeTruthy();
    expect(screen.queryByText("Not organized yet.")).toBeNull();
    expect(distill).not.toHaveBeenCalled();
  });
});

describe("knowledge queue", () => {
  function Probe({ onState }: { onState: (state: ReturnType<typeof useKnowledge>) => void }) {
    onState(useKnowledge());
    return null;
  }
  async function mount(client: ArthurClient) {
    let latest!: ReturnType<typeof useKnowledge>;
    render(
      <ArthurProviders client={client}>
        <Probe onState={(state) => (latest = state)} />
      </ArthurProviders>,
    );
    await waitFor(() => expect(latest.status).toBe("ready"));
    return () => latest;
  }

  it("a request made right after the queue drained is still served (no request is lost between drains)", async () => {
    const client = createPreviewClient({ distillation: { candidates: (c) => [{ kind: "note", title: `N:${c.content}`, body: c.content, evidence: c.content }] } });
    const a = await client.createCapture({ source: "text", content: "alpha" });
    const b = await client.createCapture({ source: "text", content: "beta" });
    const state = await mount(client);

    let second: Promise<void> = Promise.resolve();
    await act(async () => {
      // Chained on the first drain's own completion: the narrowest possible gap.
      await state().distill(a.id).then(() => {
        second = state().distill(b.id);
      });
      await second;
    });

    await waitFor(() => expect(state().objects.map((o: KnowledgeObject) => o.title).sort()).toEqual(["N:alpha", "N:beta"]));
    expect(state().jobs.size).toBe(0);
    expect(state().distilling).toBeNull();
  });

  it("asking twice for a capture that is already queued or running does not run it twice", async () => {
    const gate = deferred();
    const client = createPreviewClient({ distillation: TWO_OBJECTS });
    const cap = await client.createCapture({ source: "text", content: TEXT });
    const real = client.distillCapture.bind(client);
    const distill = vi.spyOn(client, "distillCapture").mockImplementation(async (id) => {
      await gate.promise;
      return real(id);
    });
    const state = await mount(client);

    await act(async () => {
      void state().distill(cap.id);
      void state().distill(cap.id);
      void state().distill(cap.id);
      gate.resolve();
      await state().distill(cap.id);
    });
    expect(distill).toHaveBeenCalledTimes(1);
  });
});
