import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { resetCanvasCorsHosts, useCanvasImageCors } from "../canvasCorsRetry.ts";

describe("useCanvasImageCors", () => {
  beforeEach(() => resetCanvasCorsHosts());

  it("asks for CORS first, then drops it exactly once", () => {
    const { result } = renderHook(() => useCanvasImageCors("https://images.mtgch.com/zhs/a.webp"));

    expect(result.current.crossOrigin).toBe("anonymous");

    act(() => result.current.onError());
    expect(result.current.crossOrigin).toBeUndefined();

    // A second failure must NOT keep flipping state — the caller has to be able
    // to advance its own ladder at that point.
    act(() => result.current.onError());
    expect(result.current.crossOrigin).toBeUndefined();
  });

  it("learns the answer for the WHOLE host, so later cards skip the retry", () => {
    // The animation layers allow a face 150ms to load. A per-URL retry would cost
    // a second round trip on every card and miss that deadline every time, which
    // silently downgraded the animation for the entire host. Learning per host
    // means only the first card pays.
    const first = renderHook(() => useCanvasImageCors("https://images.mtgch.com/zhs/first.webp"));
    act(() => first.result.current.onError());
    first.unmount();

    // A DIFFERENT url on the same host is already known — no retry, one request.
    const second = renderHook(() => useCanvasImageCors("https://images.mtgch.com/zhs/second.webp"));
    expect(second.result.current.crossOrigin).toBeUndefined();

    // A different host still gets the full attempt.
    const other = renderHook(() => useCanvasImageCors("https://cards.scryfall.io/normal/a/b/ab.jpg"));
    expect(other.result.current.crossOrigin).toBe("anonymous");
  });

  it("does not ask for CORS when the caller did not", () => {
    const { result } = renderHook(() => useCanvasImageCors(null));
    expect(result.current.crossOrigin).toBeUndefined();
  });
});
