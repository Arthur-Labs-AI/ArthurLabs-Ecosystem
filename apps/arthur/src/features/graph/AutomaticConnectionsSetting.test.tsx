import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createPreviewClient } from "../../client/preview-client";
import { NOTHING, renderApp, renderMobile } from "../../test/render";
import { usePhoneViewport } from "../../test/viewport";
import { AUTOMATIC_CONNECTIONS_DESCRIPTION, AUTOMATIC_CONNECTIONS_WARNING } from "./AutomaticConnectionsSetting";

const phone = usePhoneViewport(390);
const toggle = () => screen.findByRole("switch", { name: /Automatic Connections/ }) as Promise<HTMLInputElement>;
const client = () => createPreviewClient({ distillation: NOTHING });

describe("Automatic Connections setting (desktop)", () => {
  it("is OFF by default, described, and shows no warning until enabled", async () => {
    renderApp(client(), "settings");
    const box = await toggle();
    expect(box.checked).toBe(false);
    expect(screen.getByText(AUTOMATIC_CONNECTIONS_DESCRIPTION)).toBeTruthy();
    expect(screen.queryByText(AUTOMATIC_CONNECTIONS_WARNING)).toBeNull();
  });

  it("enabling saves through the client, shows the experimental warning, and disabling hides it", async () => {
    const c = client();
    const spy = vi.spyOn(c, "setGraphIntegrationEnabled");
    renderApp(c, "settings");
    const box = await toggle();
    fireEvent.click(box);
    await waitFor(() => expect(box.checked).toBe(true));
    expect(spy).toHaveBeenCalledWith(true);
    expect(screen.getByText(AUTOMATIC_CONNECTIONS_WARNING)).toBeTruthy();
    fireEvent.click(box);
    await waitFor(() => expect(box.checked).toBe(false));
    expect(screen.queryByText(AUTOMATIC_CONNECTIONS_WARNING)).toBeNull();
  });

  it("shows the saved state reported by the client on load", async () => {
    const c = client();
    await c.setGraphIntegrationEnabled(true);
    renderApp(c, "settings");
    expect((await toggle()).checked).toBe(true);
  });

  it("a failed save is an error and is never displayed as the requested state", async () => {
    const c = client();
    vi.spyOn(c, "setGraphIntegrationEnabled").mockRejectedValue(new Error("the preference could not be saved: disk full"));
    renderApp(c, "settings");
    const box = await toggle();
    fireEvent.click(box);
    expect((await screen.findByRole("alert")).textContent).toContain("could not be saved");
    expect(box.checked).toBe(false);
    expect(screen.queryByText(AUTOMATIC_CONNECTIONS_WARNING)).toBeNull();
  });
});

describe("Automatic Connections setting (mobile)", () => {
  it("lives in Settings, off by default, and enables", async () => {
    phone.start();
    renderMobile(client());
    fireEvent.click(await screen.findByRole("button", { name: "Settings" }));
    const box = await toggle();
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(box.checked).toBe(true));
    expect(screen.getByText(AUTOMATIC_CONNECTIONS_WARNING)).toBeTruthy();
  });
});
