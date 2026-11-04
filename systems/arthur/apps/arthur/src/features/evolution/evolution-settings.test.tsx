import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createPreviewClient } from "../../client/preview-client";
import { NOTHING, renderApp, renderMobile } from "../../test/render";
import { usePhoneViewport } from "../../test/viewport";
import { EVOLUTION_DESCRIPTION, EVOLUTION_EXPERIMENTAL, EVOLUTION_MODE } from "./EvolutionSettings";

const phone = usePhoneViewport(390);
const SECRET = "ts-SECRET-never-shown-again-123";
const client = (evolution = {}) => createPreviewClient({ distillation: NOTHING, evolution });
const toggle = () => screen.findByRole("switch", { name: /Suggest new versions of my ideas/ }) as Promise<HTMLInputElement>;
const permission = (name: RegExp) => screen.getByRole("group", { name });

async function allow(name: RegExp) {
  const group = permission(name);
  fireEvent.click(within(group).getByRole("button", { name: /Read and allow/ }));
  fireEvent.click(within(group).getByRole("button", { name: /I understand/ }));
  await waitFor(() => expect(within(permission(name)).getByText("Allowed")).toBeTruthy());
}

describe("Automatic Thought Evolution settings (desktop)", () => {
  it("is OFF by default, review-first, described, and cannot be switched on while anything is missing", async () => {
    renderApp(client(), "settings");
    const box = await toggle();
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(true);
    expect(screen.getByText(EVOLUTION_DESCRIPTION)).toBeTruthy();
    expect(screen.getByText(EVOLUTION_MODE)).toBeTruthy();
    expect(screen.queryByText(EVOLUTION_EXPERIMENTAL)).toBeNull();
    // what is missing is listed in plain words
    for (const todo of [/Allow TypeSafe to match notes to ideas/, /Add your TypeSafe key/, /Allow your AI provider to write suggestions/, /Allow your AI provider to check suggestions/]) expect(screen.getByText(todo)).toBeTruthy();
    // there is no setting that would let it apply changes on its own
    expect(screen.queryByText(/automatically apply|apply automatically|auto-apply/i)).toBeNull();
  });

  it("shows the exact explanation before agreeing, names the self-check, and records nothing until the person agrees", async () => {
    const c = client();
    const spy = vi.spyOn(c, "setEvolutionConsent");
    renderApp(c, "settings");
    await toggle();
    const group = permission(/Check suggestions/);
    fireEvent.click(within(group).getByRole("button", { name: /Read and allow/ }));
    expect(within(group).getByText(/Before you agree, this is exactly what happens/)).toBeTruthy();
    expect(within(group).getAllByText(/same model family/).length).toBeGreaterThan(1); // the purpose line and the explanation both say it
    expect(within(group).getAllByText(/self-check, not an independent review/).length).toBeGreaterThan(0);
    expect(spy).not.toHaveBeenCalled();
    fireEvent.click(within(group).getByRole("button", { name: "Cancel" }));
    expect(within(permission(/Check suggestions/)).queryByText(/Before you agree/)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
    fireEvent.click(within(permission(/Check suggestions/)).getByRole("button", { name: /Read and allow/ }));
    fireEvent.click(within(permission(/Check suggestions/)).getByRole("button", { name: /I understand/ }));
    await waitFor(() => expect(spy).toHaveBeenCalledWith("verification", true, "openai-verification-samefamily-2026-10-v1"));
  });

  it("can be switched on only after every permission and the TypeSafe key exist, and turning it off keeps suggestions", async () => {
    const c = client();
    renderApp(c, "settings");
    const box = await toggle();
    await allow(/Match notes to ideas/);
    await allow(/Write suggestions/);
    await allow(/Check suggestions/);
    expect(box.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/TypeSafe API key/), { target: { value: SECRET } });
    fireEvent.click(screen.getByRole("button", { name: "Save key" }));
    await waitFor(() => expect(screen.getByText("Saved")).toBeTruthy());
    // the key is gone from the field and is shown nowhere
    expect((screen.getByLabelText(/TypeSafe API key/) as HTMLInputElement).value).toBe("");
    expect(document.body.textContent).not.toContain(SECRET);
    await waitFor(() => expect(box.disabled).toBe(false));
    fireEvent.click(box);
    await waitFor(() => expect(box.checked).toBe(true));
    expect(screen.getByText(EVOLUTION_EXPERIMENTAL)).toBeTruthy();
    expect((await c.getEvolutionStatus()).active).toBe(true);
    // withdrawing one permission pauses it at once, and says so
    fireEvent.click(within(permission(/Check suggestions/)).getByRole("button", { name: "Withdraw permission" }));
    expect(await screen.findByText(/Paused: a permission or key is missing/)).toBeTruthy();
    expect((await c.getEvolutionStatus()).active).toBe(false);
    expect(document.body.textContent).toMatch(/does not delete anything a provider may already hold/);
  });

  it("a granting that names an outdated explanation is refused by the client and nothing changes", async () => {
    const c = client();
    await expect(c.setEvolutionConsent("typesafe", true, "old-version")).rejects.toMatchObject({ code: "disclosure_outdated" });
    expect((await c.getEvolutionStatus()).typesafe.consented).toBe(false);
  });

  it("a failed save is an error and is never displayed as the requested state", async () => {
    const c = client({ consents: { typesafe: true, synthesis: true, verification: true }, hasTypesafeKey: true });
    vi.spyOn(c, "setEvolutionEnabled").mockRejectedValue(new Error("The setting could not be saved."));
    renderApp(c, "settings");
    const box = await toggle();
    await waitFor(() => expect(box.disabled).toBe(false));
    fireEvent.click(box);
    expect((await screen.findAllByRole("alert")).some((a) => /could not be saved/.test(a.textContent ?? ""))).toBe(true);
    expect(box.checked).toBe(false);
  });

  it("shows the saved state on load, including a paused feature", async () => {
    renderApp(client({ enabled: true, consents: { typesafe: true } }), "settings");
    const box = await toggle();
    expect(box.checked).toBe(true);
    expect(screen.getByText(/Paused: a permission or key is missing/)).toBeTruthy();
  });
});

describe("Automatic Thought Evolution settings (phone)", () => {
  it("is in Settings, off by default and review-first, with the same permissions", async () => {
    phone.start();
    renderMobile(client(), "home");
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    const box = await toggle();
    expect(box.checked).toBe(false);
    expect(screen.getByText(EVOLUTION_MODE)).toBeTruthy();
    expect(screen.getAllByRole("group").filter((g) => /Match notes|Write suggestions|Check suggestions/.test(g.textContent ?? "")).length).toBe(3);
    fireEvent.click(within(permission(/Check suggestions/)).getByRole("button", { name: /Read and allow/ }));
    expect(within(permission(/Check suggestions/)).getByText(/Before you agree, this is exactly what happens/)).toBeTruthy();
  });
});
