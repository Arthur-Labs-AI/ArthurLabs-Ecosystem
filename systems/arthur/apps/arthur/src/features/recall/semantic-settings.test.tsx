import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createPreviewClient } from "../../client/preview-client";
import { NOTHING, renderApp, renderMobile } from "../../test/render";
import { usePhoneViewport } from "../../test/viewport";

const phone = usePhoneViewport(390);

function client(semantic: Parameters<typeof createPreviewClient>[0] = {}) {
  return createPreviewClient({ distillation: NOTHING, ...semantic });
}
const toggle = () => screen.findByRole("switch", { name: /Use semantic Recall/ }) as Promise<HTMLInputElement>;

describe("Semantic Recall settings (desktop)", () => {
  it("is OFF by default, says lexical Recall still works, and states exactly what leaves and what stays", async () => {
    renderApp(client(), "settings");
    const box = await toggle();
    expect(box.checked).toBe(false);
    const section = screen.getByRole("heading", { name: "Semantic Recall" }).closest("section")!;
    expect(within(section).getByText("Off")).toBeTruthy();
    const text = section.textContent ?? "";
    expect(text).toContain("always finds ideas by the words you used");
    expect(text).toContain("It is off until you turn it on");
    expect(text).toContain("sends the text of your ideas, and of the questions you ask, to the embedding service");
    expect(text).toContain("The index built from that text stays on this device");
    expect(text).toContain("stops new embedding requests straight away");
    expect(text).toContain("stored index is kept but ignored");
    expect(within(section).getByRole("button", { name: "Delete semantic index" }).hasAttribute("disabled")).toBe(true);
  });

  it("does not depend on an API key: the setting is only the user's choice", async () => {
    const c = client();
    const spy = vi.spyOn(c, "setSemanticRecallEnabled");
    renderApp(c, "settings");
    fireEvent.click(await toggle());
    await waitFor(() => expect(spy).toHaveBeenCalledWith(true));
    expect(JSON.stringify(spy.mock.calls)).not.toMatch(/key/i);
  });

  it("enables, shows indexing progress, then disables and keeps the stored vectors visibly ignored", async () => {
    const c = client({ recall: { semantic: { storedVectorsAllKeys: 12, storedVectors: 12, pendingObjects: 0 } } });
    renderApp(c, "settings");
    const box = await toggle();
    expect(screen.getByText(/12 stored vectors are kept on this device but ignored while this is off/)).toBeTruthy();
    fireEvent.click(box);
    await waitFor(() => expect(box.checked).toBe(true));
    expect(await screen.findByText("Semantic Recall is on.")).toBeTruthy();
    expect(screen.getByText("12 ideas are indexed on this device.")).toBeTruthy();
    fireEvent.click(box);
    await waitFor(() => expect(box.checked).toBe(false));
    expect(await screen.findByText("Semantic Recall is off.")).toBeTruthy();
    expect((await c.getSemanticRecallStatus()).enabled).toBe(false);
    expect((await c.getSemanticRecallStatus()).storedVectors).toBe(12); // kept, not deleted
  });

  it("shows indexing progress while ideas are still waiting", async () => {
    renderApp(client({ recall: { semantic: { enabled: true, savedEnabled: true, storedVectors: 3, storedVectorsAllKeys: 3, pendingObjects: 5 } } }), "settings");
    expect(await screen.findByText("Indexing: 3 ideas done, 5 waiting.")).toBeTruthy();
  });

  it("deletes the semantic index only after a confirmation, and says it did", async () => {
    const c = client({ recall: { semantic: { storedVectorsAllKeys: 4, storedVectors: 4 } } });
    const purge = vi.spyOn(c, "purgeSemanticIndex");
    renderApp(c, "settings");
    fireEvent.click(await screen.findByRole("button", { name: "Delete semantic index" }));
    expect(purge).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep" }));
    expect(purge).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete semantic index" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete 4 vectors" }));
    expect(await screen.findByText("The semantic index was deleted from this device.")).toBeTruthy();
    expect(purge).toHaveBeenCalledTimes(1);
    expect((await c.getSemanticRecallStatus()).storedVectorsAllKeys).toBe(0);
    expect(screen.getByRole("button", { name: "Delete semantic index" }).hasAttribute("disabled")).toBe(true);
  });

  it("reports a corrupt saved preference honestly and a failed change without pretending it worked", async () => {
    const c = client({ recall: { semantic: { settingsCorrupt: true } } });
    vi.spyOn(c, "setSemanticRecallEnabled").mockRejectedValue(new Error("the preference could not be saved"));
    renderApp(c, "settings");
    expect(await screen.findByText(/saved preference couldn’t be read/)).toBeTruthy();
    const box = await toggle();
    fireEvent.click(box);
    expect(await screen.findByText(/could not be saved/)).toBeTruthy();
    expect(box.checked).toBe(false);
  });

  it("is a setting, never a prompt: Ask Arthur has no consent modal or upsell", async () => {
    renderApp(client(), "ask");
    await screen.findByRole("heading", { name: "Ask Arthur", level: 1 });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText(/semantic/i)).toBeNull();
  });
});

describe("Semantic Recall settings (mobile)", () => {
  it("lives in Settings, off by default, with 48px-class controls", async () => {
    phone.start();
    renderMobile(client());
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    const box = await toggle();
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(box.checked).toBe(true));
    const section = screen.getByRole("heading", { name: "Semantic Recall" }).closest("section")!;
    expect(section.querySelector(".m-pbtn")).not.toBeNull();
  });
});
