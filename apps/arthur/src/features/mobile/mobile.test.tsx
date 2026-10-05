import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { Capture } from "@arthur/contracts";
import { describe, expect, it, vi } from "vitest";
import { DistillationError, VoiceCaptureError, type ArthurClient } from "../../client/arthur-client";
import { createPreviewClient } from "../../client/preview-client";
import { NOTHING, TWO_OBJECTS, deferred, renderMobile, seeded } from "../../test/render";
import { usePhoneViewport } from "../../test/viewport";

const phone = usePhoneViewport(390);
const tabs = () => screen.getByRole("navigation", { name: "Primary" });
const tab = (name: RegExp | string) => within(tabs()).getByRole("button", { name });
const mobile = (client: ArthurClient, screenName: Parameters<typeof renderMobile>[1] = "home") => {
  phone.start();
  return renderMobile(client, screenName);
};

describe("mobile shell and navigation", () => {
  it("shows the five tabs in the approved order, Capture in the middle, and Settings at the top right", async () => {
    mobile(createPreviewClient({ distillation: NOTHING }));
    expect(within(tabs()).getAllByRole("button").map((b) => b.textContent)).toEqual(["Home", "Ideas", "Capture", "Connections", "Evolution"]);
    expect(tab("Home").getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("button", { name: "Settings" })).toBeTruthy();
    expect(screen.queryByRole("complementary", { name: "Sidebar" })).toBeNull();
    expect(screen.queryByText(/Ask Arthur/)).toBeNull();
    expect(await screen.findByRole("button", { name: "Speak" })).toBeTruthy();
  });

  it("moves between the four screens and marks the current tab", async () => {
    mobile(createPreviewClient({ distillation: NOTHING }));
    for (const [name, heading] of [["Ideas", "Ideas"], ["Connections", "Connections"], ["Evolution", "Evolution"]] as const) {
      fireEvent.click(tab(name));
      expect(await screen.findByRole("heading", { name: heading, level: 1 })).toBeTruthy();
      expect(tab(name).getAttribute("aria-current")).toBe("page");
    }
    fireEvent.click(tab("Home"));
    expect(await screen.findByRole("heading", { name: /What’s on your mind/ })).toBeTruthy();
  });

  it("picks the layout from the width alone and keeps the user's place when the width crosses the breakpoint", async () => {
    mobile(createPreviewClient({ distillation: NOTHING }));
    fireEvent.click(tab("Ideas"));
    expect(await screen.findByRole("heading", { name: "Ideas", level: 1 })).toBeTruthy();
    act(() => phone.setWidth(1200));
    expect(await screen.findByRole("complementary", { name: "Sidebar" })).toBeTruthy();
    expect(within(screen.getByRole("navigation", { name: "Primary" })).getByRole("button", { name: /^Ideas/ }).getAttribute("aria-current")).toBe("page");
    act(() => phone.setWidth(360));
    expect(await screen.findByRole("button", { name: "Settings" })).toBeTruthy();
    expect(tab("Ideas").getAttribute("aria-current")).toBe("page");
  });
});

describe("the Capture tab", () => {
  it("does not start the microphone before the user has used Speak: it opens Home and says how Speak asks", async () => {
    const client = createPreviewClient({ distillation: NOTHING });
    const start = vi.spyOn(client, "startVoiceCapture");
    mobile(client, "ideas");
    fireEvent.click(tab("Capture"));
    expect(await screen.findByRole("button", { name: "Speak" })).toBeTruthy();
    expect(tab("Home").getAttribute("aria-current")).toBe("page");
    expect(screen.getByText(/Tap Speak and the microphone will be requested/)).toBeTruthy();
    expect(start).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: "Recording" })).toBeNull();
  });

  it("records straight away once the microphone is known to work, from any screen", async () => {
    const client = createPreviewClient({ distillation: NOTHING });
    const start = vi.spyOn(client, "startVoiceCapture");
    mobile(client);
    fireEvent.click(await screen.findByRole("button", { name: "Speak" }));
    expect(await screen.findByRole("dialog", { name: "Recording" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Recording" })).toBeNull());
    expect(start).toHaveBeenCalledTimes(1);

    fireEvent.click(tab("Evolution"));
    fireEvent.click(tab("Capture"));
    expect(await screen.findByRole("dialog", { name: "Recording" })).toBeTruthy();
    expect(start).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeTruthy();
  });

  it("never records after the microphone was refused, and says what to do", async () => {
    const client = createPreviewClient({ distillation: NOTHING, voice: { startError: new VoiceCaptureError("microphone_permission_denied", "Microphone permission was denied. Allow microphone access for Arthur in the system settings and try again.") } });
    const start = vi.spyOn(client, "startVoiceCapture");
    mobile(client);
    fireEvent.click(await screen.findByRole("button", { name: "Speak" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Microphone is off")).toBeTruthy();
    expect(alert.textContent).toMatch(/You can still type your thought/);
    expect(within(alert).queryByRole("button", { name: /Record again/ })).toBeNull();
    fireEvent.click(tab("Capture"));
    expect(start).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog", { name: "Recording" })).toBeNull();
    fireEvent.click(within(alert).getByRole("button", { name: "Type instead" }));
    expect(await screen.findByLabelText("Thought")).toBeTruthy();
  });
});

describe("Home capture states", () => {
  it("types a thought: the composer takes focus, Capture waits for words, and the capture is saved before it is organized", async () => {
    const gate = deferred<import("@arthur/contracts").KnowledgeObject[]>();
    const base = createPreviewClient({ distillation: TWO_OBJECTS });
    const client: ArthurClient = { ...base, distillCapture: () => gate.promise };
    mobile(client);
    fireEvent.click(await screen.findByRole("button", { name: "Type a thought" }));
    const box = (await screen.findByLabelText("Thought")) as HTMLTextAreaElement;
    expect(document.activeElement).toBe(box);
    const submit = screen.getByRole("button", { name: "Capture", description: undefined, hidden: false }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(box, { target: { value: "I want to improve the Arthur capture screen." } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(await screen.findByText(/I want to improve the Arthur capture screen/)).toBeTruthy();
    expect(await screen.findByText(/Capture saved · waiting to organize|Arthur is organizing/)).toBeTruthy();
    expect((await client.listCaptures()).length).toBe(1);
    expect(screen.queryByLabelText("Thought")).toBeNull();
  });

  it("Cancel leaves typing mode without saving", async () => {
    const client = createPreviewClient({ distillation: NOTHING });
    mobile(client);
    fireEvent.click(await screen.findByRole("button", { name: "Type a thought" }));
    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
    expect(await screen.findByRole("button", { name: "Speak" })).toBeTruthy();
    expect((await client.listCaptures()).length).toBe(0);
  });

  it("goes idle → recording → transcribing → saved → organizing → organized, drawing the thread to the ideas", async () => {
    const transcript = deferred<Capture>();
    const organize = deferred<import("@arthur/contracts").KnowledgeObject[]>();
    const base = createPreviewClient({ distillation: TWO_OBJECTS, voice: { transcript: () => "I want to improve the Arthur capture screen. Tomorrow I also need to email Ignatov about the competition." } });
    const client: ArthurClient = {
      ...base,
      finishVoiceCapture: async () => {
        await transcript.promise;
        return base.finishVoiceCapture();
      },
      distillCapture: async (id) => {
        await organize.promise;
        return base.distillCapture(id);
      },
    };
    mobile(client);
    fireEvent.click(await screen.findByRole("button", { name: "Speak" }));
    expect(await screen.findByRole("dialog", { name: "Recording" })).toBeTruthy();
    expect(screen.getByRole("timer")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Stop and save/ }));
    expect(await screen.findByText("Transcribing…")).toBeTruthy();
    expect(screen.getByText(/It isn’t kept/)).toBeTruthy();
    await act(async () => transcript.resolve(undefined as never));
    expect(await screen.findByText(/waiting to organize|Arthur is organizing/)).toBeTruthy();
    await act(async () => organize.resolve(undefined as never));
    const kid = await screen.findByRole("button", { name: /Improve capture screen/ });
    expect(kid).toBeTruthy();
    expect(kid.className).toContain("draw");
    expect(await screen.findByText("Organized")).toBeTruthy();
  });

  it("keeps the capture and offers a retry when organizing fails", async () => {
    const client = createPreviewClient({ distillation: { candidates: TWO_OBJECTS?.candidates ?? (() => []), error: new DistillationError("llm_failed", "Could not reach the model."), once: true } });
    mobile(client);
    fireEvent.click(await screen.findByRole("button", { name: "Type a thought" }));
    fireEvent.change(await screen.findByLabelText("Thought"), { target: { value: "I want to improve the Arthur capture screen. Tomorrow I also need to email Ignatov about the competition." } });
    fireEvent.click(screen.getByRole("button", { name: "Capture" }));
    expect(await screen.findByText("Your thought is saved.")).toBeTruthy();
    expect(screen.getByText(/Nothing was lost/)).toBeTruthy();
    expect((await client.listCaptures()).length).toBe(1);
    fireEvent.click(screen.getByRole("button", { name: /Retry organizing/ }));
    expect(await screen.findByRole("button", { name: /Improve capture screen/ })).toBeTruthy();
    expect(screen.queryByText("Your thought is saved.")).toBeNull();
  });

  it("says plainly that a failed transcription is not retryable, because the recording is not kept", async () => {
    const client = createPreviewClient({ distillation: NOTHING, voice: { finishError: new VoiceCaptureError("stt_failed", "Could not reach the speech service. Check the connection and try again.") } });
    mobile(client);
    fireEvent.click(await screen.findByRole("button", { name: "Speak" }));
    fireEvent.click(await screen.findByRole("button", { name: /Stop and save/ }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Couldn’t transcribe")).toBeTruthy();
    expect(alert.textContent).toMatch(/The recording isn’t kept, so say it again or type it/);
    expect(within(alert).queryByRole("button", { name: /Retry transcription/ })).toBeNull();
    expect((await client.listCaptures()).length).toBe(0);
    fireEvent.click(within(alert).getByRole("button", { name: "Dismiss" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("shows the capture's Recent group with its ideas, and opens an idea from it", async () => {
    const { client } = await seeded();
    mobile(client);
    const kid = await screen.findByRole("button", { name: /Email Ignatov/ });
    expect(screen.getByText(/improve the Arthur capture screen/)).toBeTruthy();
    fireEvent.click(kid);
    expect(await screen.findByRole("region", { name: /Idea: Email Ignatov/ })).toBeTruthy();
  });
});

describe("Ideas", () => {
  it("searches, filters by kind and says when nothing matches", async () => {
    const { client } = await seeded();
    mobile(client, "ideas");
    const list = await screen.findByRole("list", { name: "Ideas" });
    expect(within(list).getAllByRole("button").length).toBe(2);
    fireEvent.click(screen.getByRole("button", { name: /^Tasks/ }));
    expect(within(screen.getByRole("list", { name: "Ideas" })).getAllByRole("button").length).toBe(1);
    expect(screen.getByRole("button", { name: /^Tasks/ }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    fireEvent.change(screen.getByLabelText("Search ideas"), { target: { value: "ignatov" } });
    expect(within(screen.getByRole("list", { name: "Ideas" })).getAllByRole("button").length).toBe(1);
    fireEvent.change(screen.getByLabelText("Search ideas"), { target: { value: "zzzz" } });
    expect(await screen.findByText("Nothing matches")).toBeTruthy();
  });

  it("shows source, connections and revisions on every row", async () => {
    const { client } = await seeded();
    mobile(client, "ideas");
    const row = (await screen.findByRole("button", { name: /Email Ignatov/ })) as HTMLElement;
    expect(within(row).getByLabelText("0 connections")).toBeTruthy();
    await waitFor(() => expect(within(row).getByLabelText("1 revision")).toBeTruthy());
    expect(within(row).getByText("Typed")).toBeTruthy();
  });
});

describe("Idea detail", () => {
  async function open() {
    const { client, objects } = await seeded();
    const other = objects[0]!;
    const task = objects.find((o) => o.title === "Email Ignatov")!;
    await client.createRelation({ kind: "depends_on", sourceObjectId: task.id, targetObjectId: other.id });
    mobile(client, "ideas");
    fireEvent.click(await screen.findByRole("button", { name: /Email Ignatov/ }));
    return { client, task, other };
  }

  it("is a full-screen page with the words, the exact source, connections, evolution, Revise and Branch", async () => {
    await open();
    const page = await screen.findByRole("region", { name: /Idea: Email Ignatov/ });
    expect(within(page).getByRole("heading", { name: "Email Ignatov", level: 1 })).toBeTruthy();
    expect(within(page).getByLabelText("Original capture text").textContent).toContain("Tomorrow I also need to email Ignatov");
    expect(within(page).getByRole("heading", { name: "Connections" })).toBeTruthy();
    expect(within(page).getByRole("heading", { name: "Evolution" })).toBeTruthy();
    expect(within(page).getByRole("button", { name: "Revise" })).toBeTruthy();
    expect(within(page).getByRole("button", { name: "Branch" })).toBeTruthy();
    expect(within(page).getByRole("button", { name: /Improve capture screen, depends on/ })).toBeTruthy();
    for (const unsupported of [/delete/i, /remove connection/i, /confirm/i, /make current/i]) expect(page.textContent).not.toMatch(unsupported);
    expect(screen.queryByRole("navigation", { name: "Primary" })).toBeNull();
  });

  it("Back closes the page, and so does the system Back gesture", async () => {
    await open();
    fireEvent.click(await screen.findByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: /Idea:/ })).toBeNull());
    expect(await screen.findByRole("heading", { name: "Ideas", level: 1 })).toBeTruthy();

    fireEvent.click(await screen.findByRole("button", { name: /Email Ignatov/ }));
    await screen.findByRole("region", { name: /Idea: Email Ignatov/ });
    act(() => {
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(screen.queryByRole("region", { name: /Idea:/ })).toBeNull());
  });

  it("revises the idea in a sheet: a new revision becomes current and the old one is untouched", async () => {
    const { client, task } = await open();
    fireEvent.click(await screen.findByRole("button", { name: "Revise" }));
    const sheet = await screen.findByRole("dialog", { name: "Revise" });
    const save = within(sheet).getByRole("button", { name: /Save as R2/ });
    fireEvent.click(save);
    expect(await within(sheet).findByText("Nothing changed.")).toBeTruthy();
    fireEvent.change(within(sheet).getByLabelText("Title"), { target: { value: "Email Ignatov today" } });
    fireEvent.click(save);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Revise" })).toBeNull());
    expect(await screen.findByRole("heading", { name: "Email Ignatov today", level: 1 })).toBeTruthy();
    expect(await screen.findByText("New revision saved.")).toBeTruthy();
    const lineage = await client.getObjectLineage(task.id);
    expect(lineage.revisions.length).toBe(2);
    expect(lineage.revisions[0]!.title).toBe("Email Ignatov");
  });

  it("branches from the current revision without changing which one is current", async () => {
    const { client, task } = await open();
    fireEvent.click(await screen.findByRole("button", { name: "Branch" }));
    const sheet = await screen.findByRole("dialog", { name: "Branch" });
    fireEvent.change(within(sheet).getByLabelText("Text"), { target: { value: "Email Ignatov and Petrova about the competition." } });
    fireEvent.click(within(sheet).getByRole("button", { name: /Create branch R2/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Branch" })).toBeNull());
    const lineage = await client.getObjectLineage(task.id);
    expect(lineage.revisions.length).toBe(2);
    expect(lineage.currentRevisionId).toBe(lineage.revisions[0]!.id);
    expect(await screen.findByText(/Branch saved\. The current revision is unchanged/)).toBeTruthy();
  });
});

describe("Connections", () => {
  async function connected() {
    const { client, objects } = await seeded();
    const [a, b] = [objects[0]!, objects[1]!];
    await client.createRelation({ kind: "depends_on", sourceObjectId: b.id, targetObjectId: a.id });
    return { client, a, b };
  }

  it("opens on the List: each idea with its connections, the relation, its direction and who made it", async () => {
    await connected().then(({ client }) => mobile(client, "connections"));
    expect(screen.getByRole("button", { name: "List" }).getAttribute("aria-pressed")).toBe("true");
    const hub = await screen.findByRole("button", { name: /Improve capture screen, 1 connection/ });
    expect(hub.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(hub);
    const row = await screen.findByRole("button", { name: /Email Ignatov, needed by, yours/ });
    expect(row.querySelector("svg.relsw")).toBeTruthy();
    expect(row.textContent).toContain("← needed by");
    expect(row.querySelector(".m-origin")).toBeTruthy();
    fireEvent.click(row);
    const sheet = await screen.findByRole("dialog", { name: "Connection" });
    expect(sheet.textContent).toContain("depends on");
    expect(sheet.textContent).toContain("Created by you");
    expect(sheet.textContent).toMatch(/Email Ignatov → Improve capture screen/);
  });

  it("switches to the Map, which has stable nodes, edge labels only on selection, and a peek sheet on selecting an idea", async () => {
    await connected().then(({ client }) => mobile(client, "connections"));
    fireEvent.click(await screen.findByRole("button", { name: "Map" }));
    const map = await screen.findByRole("group", { name: /Connections map/ });
    expect(map.querySelectorAll("[data-node]").length).toBe(2);
    expect(map.querySelector(".m-elabel-in")).toBeNull();
    const node = screen.getByRole("button", { name: "Node: Improve capture screen" });
    fireEvent.click(node);
    const sheet = await screen.findByRole("dialog", { name: "Improve capture screen" });
    expect(within(sheet).getByRole("button", { name: "Open idea" })).toBeTruthy();
    expect(node.getAttribute("aria-pressed")).toBe("true");
    expect(map.querySelectorAll(".m-edge.dim").length).toBe(0);
    fireEvent.click(within(sheet).getByRole("button", { name: /1 connection/ }));
    expect(within(sheet).getByRole("button", { name: /Email Ignatov, needed by/ })).toBeTruthy();
  });

  it("selects an edge from the map: the relation is named on the line and explained in the sheet", async () => {
    await connected().then(({ client }) => mobile(client, "connections"));
    fireEvent.click(await screen.findByRole("button", { name: "Map" }));
    const edge = await screen.findByRole("button", { name: "Edge: Email Ignatov depends on Improve capture screen" });
    fireEvent.click(edge);
    const sheet = await screen.findByRole("dialog", { name: "Connection" });
    expect(sheet.textContent).toContain("The first needs the second to work");
    expect(document.querySelector(".m-elabel-t")?.textContent).toBe("depends on");
    expect(within(sheet).getByRole("button", { name: /Open “Email Ignatov”/ })).toBeTruthy();
  });

  it("filters by who made the links and by kind, in a sheet, for both views", async () => {
    await connected().then(({ client }) => mobile(client, "connections"));
    fireEvent.click(await screen.findByRole("button", { name: /^Filter/ }));
    const sheet = await screen.findByRole("dialog", { name: "Show connections" });
    fireEvent.click(within(sheet).getByRole("button", { name: "Arthur’s" }));
    fireEvent.click(within(sheet).getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Show connections" })).toBeNull());
    expect(screen.getByText("No connections match this filter.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Filter · 1/ })).toBeTruthy();
  });

  it("explains an empty graph and finds connections on request", async () => {
    const { client } = await seeded();
    mobile(client, "connections");
    expect(await screen.findByText(/No connections yet/)).toBeTruthy();
    const find = screen.getByRole("button", { name: "Find connections" }) as HTMLButtonElement;
    expect(find.disabled).toBe(false);
    fireEvent.click(find);
    expect(await screen.findByText("No new connections found.")).toBeTruthy();
  });
});

describe("Map gestures", () => {
  const transformOf = (): string => (document.querySelector(".m-world") as SVGGElement).style.transform;
  const scaleOf = (): number => Number(/scale\(([\d.]+)\)/.exec(transformOf())?.[1]);
  const translateOf = (): [number, number] => {
    const match = /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(transformOf());
    return [Number(match?.[1]), Number(match?.[2])];
  };
  const pointer = (type: string, init: { id: number; x: number; y: number }) => {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.assign(event, { pointerId: init.id, clientX: init.x, clientY: init.y, pointerType: "touch" });
    return event;
  };

  async function map() {
    const { client, objects } = await seeded();
    await client.createRelation({ kind: "related_to", sourceObjectId: objects[0]!.id, targetObjectId: objects[1]!.id });
    mobile(client, "connections");
    fireEvent.click(await screen.findByRole("button", { name: "Map" }));
    return screen.findByRole("group", { name: /Connections map/ });
  }

  it("zooms with the + and − buttons, within limits, and never fits itself to the screen", async () => {
    await map();
    expect(scaleOf()).toBe(1);
    const zoomIn = screen.getByRole("button", { name: "Zoom in" });
    const zoomOut = screen.getByRole("button", { name: "Zoom out" });
    fireEvent.click(zoomIn);
    expect(scaleOf()).toBeGreaterThan(1.2);
    for (let i = 0; i < 12; i += 1) fireEvent.click(zoomOut);
    expect(scaleOf()).toBeCloseTo(0.4, 1);
    for (let i = 0; i < 20; i += 1) fireEvent.click(zoomIn);
    expect(scaleOf()).toBeLessThanOrEqual(2.8);
  });

  it("zooms with the wheel", async () => {
    const svg = await map();
    const before = scaleOf();
    act(() => {
      svg.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, bubbles: true, cancelable: true }));
    });
    expect(scaleOf()).toBeGreaterThan(before);
  });

  it("pans with one finger and does not select what the finger started on", async () => {
    const svg = await map();
    const [x0, y0] = translateOf();
    const node = screen.getByRole("button", { name: "Node: Improve capture screen" });
    act(() => {
      node.dispatchEvent(pointer("pointerdown", { id: 1, x: 100, y: 100 }));
      svg.dispatchEvent(pointer("pointermove", { id: 1, x: 160, y: 140 }));
      svg.dispatchEvent(pointer("pointerup", { id: 1, x: 160, y: 140 }));
    });
    const [x1, y1] = translateOf();
    expect(x1 - x0).toBeCloseTo(60, 3);
    expect(y1 - y0).toBeCloseTo(40, 3);
    fireEvent.click(node); // the click that ends a drag is not a tap
    expect(screen.queryByRole("dialog", { name: "Improve capture screen" })).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 5));
    fireEvent.click(node);
    expect(await screen.findByRole("dialog", { name: "Improve capture screen" })).toBeTruthy();
  });

  it("pinches with two fingers", async () => {
    const svg = await map();
    const before = scaleOf();
    act(() => {
      svg.dispatchEvent(pointer("pointerdown", { id: 1, x: 100, y: 200 }));
      svg.dispatchEvent(pointer("pointerdown", { id: 2, x: 140, y: 200 }));
      svg.dispatchEvent(pointer("pointermove", { id: 2, x: 220, y: 200 }));
      svg.dispatchEvent(pointer("pointerup", { id: 2, x: 220, y: 200 }));
      svg.dispatchEvent(pointer("pointerup", { id: 1, x: 100, y: 200 }));
    });
    expect(scaleOf()).toBeCloseTo(before * 3, 0);
  });
});

describe("Evolution", () => {
  async function lineage() {
    const { client, objects } = await seeded();
    const object = objects.find((o) => o.title === "Improve capture screen")!;
    await client.updateKnowledgeObject(object.id, { body: "Improve the Arthur capture screen so it is voice first." });
    const [first, second] = (await client.getObjectLineage(object.id)).revisions;
    await client.createRevisionFrom({ objectId: object.id, parentRevisionId: first!.id, changes: { body: "Improve the Arthur capture screen and keep it calm." }, makeCurrent: false });
    const third = (await client.getObjectLineage(object.id)).revisions[2]!;
    await client.mergeRevisions({ objectId: object.id, parentRevisionIds: [second!.id, third.id], result: { kind: "idea", title: "Improve capture screen", body: "Improve the Arthur capture screen so it is voice first and calm." }, makeCurrent: true });
    return { client, object };
  }

  it("draws a vertical rail with parents above children, a branch, a merge and one current revision", async () => {
    const { client, object } = await lineage();
    mobile(client, "evolution");
    const rail = await screen.findByRole("list", { name: "Revisions, oldest first" });
    const rows = within(rail).getAllByRole("button");
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "Revision R1, First capture",
      "Revision R2, Your edit",
      "Revision R3, Your edit",
      "Revision R4, Merge, current",
    ]);
    expect(screen.getByText(/4 revisions · 1 branch · 1 merge/)).toBeTruthy();
    expect(screen.getByText("R4 is current")).toBeTruthy();
    expect(rail.querySelectorAll(".m-vnode.cur").length).toBe(1);
    expect(rail.querySelectorAll(".m-vnode.merge").length).toBe(1);
    expect(rail.querySelectorAll(".m-varrow").length).toBe(3);
    expect(object.id).toBeTruthy();
  });

  it("expands the chosen revision in place with its deterministic diff, and lets a merge pick its parent", async () => {
    const { client } = await lineage();
    mobile(client, "evolution");
    const rail = await screen.findByRole("list", { name: "Revisions, oldest first" });
    fireEvent.click(within(rail).getByRole("button", { name: /Revision R2/ }));
    const detail = await screen.findByLabelText("Revision R2");
    const inserted = (root: Element): string => [...root.querySelectorAll("ins")].map((node) => node.textContent).join("");
    await waitFor(() => expect(inserted(detail)).toContain("so it is voice first"));
    expect(within(rail).getAllByRole("button", { expanded: true }).length).toBe(1);

    fireEvent.click(within(rail).getByRole("button", { name: /Revision R4/ }));
    const merge = await screen.findByLabelText("Revision R4");
    const compare = within(merge).getByRole("group", { name: "Compare with" });
    expect(within(compare).getByRole("button", { name: "R2" }).getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(inserted(merge)).toContain("and calm"));
    fireEvent.click(within(compare).getByRole("button", { name: "R3" }));
    expect(within(compare).getByRole("button", { name: "R3" }).getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(inserted(merge)).toContain("voice first"));
    expect(merge.textContent).toContain("Merged text is written by you");
  });

  it("branches from a chosen revision and merges chosen revisions through sheets", async () => {
    const { client, object } = await lineage();
    mobile(client, "evolution");
    const rail = await screen.findByRole("list", { name: "Revisions, oldest first" });
    fireEvent.click(within(rail).getByRole("button", { name: /Revision R1/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Branch from R1" }));
    const sheet = await screen.findByRole("dialog", { name: "Branch" });
    expect(within(sheet).getByRole("heading", { name: "Branch from R1" })).toBeTruthy();
    fireEvent.change(within(sheet).getByLabelText("Text"), { target: { value: "A different direction." } });
    fireEvent.click(within(sheet).getByRole("button", { name: /Create branch R5/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Branch" })).toBeNull());
    expect((await client.getObjectLineage(object.id)).revisions.length).toBe(5);

    fireEvent.click(await screen.findByRole("button", { name: "Merge…" }));
    const merge = await screen.findByRole("dialog", { name: "Merge" });
    expect(within(merge).getAllByRole("button", { pressed: true }).length).toBe(2);
    fireEvent.click(within(merge).getByRole("button", { name: /^Merge R/ }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Merge" })).toBeNull());
    expect((await client.getObjectLineage(object.id)).revisions.length).toBe(6);
  });

  it("chooses another idea from a sheet", async () => {
    const { client } = await lineage();
    mobile(client, "evolution");
    fireEvent.click(await screen.findByRole("button", { name: /Choose an idea\. Now: Improve capture screen/ }));
    const sheet = await screen.findByRole("dialog", { name: "Choose an idea" });
    fireEvent.click(within(sheet).getByRole("button", { name: /Email Ignatov/ }));
    expect(await screen.findByRole("button", { name: /Choose an idea\. Now: Email Ignatov/ })).toBeTruthy();
  });
});

describe("Settings", () => {
  it("opens from the top-right control, says only what is true, and Back returns", async () => {
    mobile(createPreviewClient({ distillation: NOTHING, info: { appVersion: "1.2.3", platform: "linux" } }));
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    const page = await screen.findByRole("region", { name: "Settings" });
    expect(page.textContent).toContain("Knowledge stored locally");
    expect(page.textContent).toContain("Speech is transcribed by a cloud speech service");
    expect(page.textContent).toContain("send the text of your captures and ideas to a cloud model");
    await waitFor(() => expect(page.textContent).toContain("1.2.3"));
    expect(page.textContent).not.toMatch(/never leaves|no data leaves|fully local|on-device ai|home node|sync(ed|ing)? (is|with)/i);
    fireEvent.click(within(page).getByRole("button", { name: "Back" }));
    await waitFor(() => expect(screen.queryByRole("region", { name: "Settings" })).toBeNull());
    expect(await screen.findByRole("button", { name: "Speak" })).toBeTruthy();
  });
});

describe("accessibility", () => {
  it("gives every control on every screen an accessible name", async () => {
    const { client } = await seeded();
    mobile(client);
    for (const name of ["Home", "Ideas", "Connections", "Evolution"]) {
      fireEvent.click(tab(name));
      await screen.findByRole("heading", { level: 1 });
      for (const button of screen.getAllByRole("button")) {
        const label = button.getAttribute("aria-label") ?? button.textContent ?? "";
        expect(label.trim().length, `${name}: ${button.outerHTML.slice(0, 120)}`).toBeGreaterThan(0);
      }
    }
  });
});
