import { afterEach, describe, expect, it } from "vitest";
import { resetBackStack, useBackLayer } from "./back-stack";
import { renderHook } from "@testing-library/react";
import { act } from "react";

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));
afterEach(resetBackStack);

describe("back stack", () => {
  it("a layer closed and another opened in the same update leaves one history entry per open layer", async () => {
    const closed: string[] = [];
    const base = window.history.length;
    const ask = renderHook(() => useBackLayer(true, () => closed.push("ask")));
    const sheet = renderHook(({ on }) => useBackLayer(on, () => closed.push("sheet")), { initialProps: { on: true } });
    expect(window.history.length).toBe(base + 2);
    // The sheet closes and the idea page opens in one update.
    let idea!: ReturnType<typeof renderHook>;
    act(() => {
      sheet.rerender({ on: false });
      idea = renderHook(() => useBackLayer(true, () => closed.push("idea")));
    });
    await settle();
    expect(window.history.length).toBe(base + 2); // ask + idea; the sheet's entry was taken over, not stacked
    // Back closes the idea first, then Ask: never the wrong layer.
    act(() => window.history.back());
    await settle();
    expect(closed).toEqual(["idea"]);
    act(() => window.history.back());
    await settle();
    expect(closed).toEqual(["idea", "ask"]);
    idea.unmount();
    ask.unmount();
  });

  it("closing a layer from the UI still pops its own entry when nothing else opens", async () => {
    const layer = renderHook(({ on }) => useBackLayer(on, () => undefined), { initialProps: { on: true } });
    expect(window.history.state).toEqual({ arthurLayer: 1 });
    act(() => layer.rerender({ on: false }));
    await settle();
    expect(window.history.state).not.toEqual({ arthurLayer: 1 });
    layer.unmount();
  });
});
