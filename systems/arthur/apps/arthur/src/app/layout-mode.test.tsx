import { act, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import layoutModeSource from "./layout-mode.ts?raw";
import { MOBILE_MAX_WIDTH_PX, useLayoutMode } from "./layout-mode";
import { installViewport } from "../test/viewport";

function Probe() {
  return <p data-testid="mode">{useLayoutMode()}</p>;
}

describe("layout mode", () => {
  it("is desktop where the browser cannot answer a width query", () => {
    render(<Probe />);
    expect(screen.getByTestId("mode").textContent).toBe("desktop");
  });

  it("is chosen from the width alone, at the breakpoint", () => {
    const viewport = installViewport(MOBILE_MAX_WIDTH_PX + 1);
    try {
      render(<Probe />);
      expect(screen.getByTestId("mode").textContent).toBe("desktop");
      act(() => viewport.setWidth(MOBILE_MAX_WIDTH_PX));
      expect(screen.getByTestId("mode").textContent).toBe("mobile");
      act(() => viewport.setWidth(1440));
      expect(screen.getByTestId("mode").textContent).toBe("desktop");
    } finally {
      viewport.restore();
    }
  });

  it("covers the phone sizes the design targets", () => {
    for (const width of [360, 390, 412]) expect(width).toBeLessThanOrEqual(MOBILE_MAX_WIDTH_PX);
  });

  it("does not look at the user agent, the platform or the build environment", () => {
    expect(layoutModeSource).not.toMatch(/userAgent|navigator\.platform|TAURI_ENV|import\.meta\.env|\bandroid\b/i);
  });
});
