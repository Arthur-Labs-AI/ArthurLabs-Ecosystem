import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { createPreviewClient } from "../client/preview-client";
import type { ArthurClient } from "../client/arthur-client";
import { useArthurClient } from "../hooks/use-arthur-client";
import { App } from "./App";
import { ArthurProviders } from "./providers";

describe("App shell", () => {
  it("shows runtime information obtained through the ArthurClient", async () => {
    const client = createPreviewClient({ info: { appVersion: "9.9.9", platform: "android" } });
    render(
      <ArthurProviders client={client}>
        <App />
      </ArthurProviders>,
    );

    expect(screen.getByRole("heading", { name: "A.R.T.H.U.R." })).toBeTruthy();
    expect(screen.getByText("Loading runtime information…")).toBeTruthy();

    expect(await screen.findByText("9.9.9")).toBeTruthy();
    expect(screen.getByText("android")).toBeTruthy();
    expect(screen.getByText("preview")).toBeTruthy();
  });

  it("surfaces a native failure instead of crashing", async () => {
    const failing: ArthurClient = {
      ...createPreviewClient(),
      kind: "desktop",
      getRuntimeInfo: () => Promise.reject(new Error("ipc down")),
    };
    render(
      <ArthurProviders client={failing}>
        <App />
      </ArthurProviders>,
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("ipc down");
  });

  it("falls back to the preview client when no native layer exists", async () => {
    render(
      <ArthurProviders>
        <App />
      </ArthurProviders>,
    );
    expect(await screen.findByText("0.0.0-preview")).toBeTruthy();
  });

  it("refuses to render UI that has no ArthurClient provider", () => {
    function NeedsClient() {
      useArthurClient();
      return null;
    }
    expect(() => render(<NeedsClient />)).toThrow("useArthurClient must be used inside <ArthurProviders>");
  });
});
