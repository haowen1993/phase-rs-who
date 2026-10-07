import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The component resolves its art through `useCardImage`, which reports `src: null`
// while the art is still loading. That transition is what this file exists to
// cover: it is the state in which a hook placed after the component's `!src`
// early return changes the hook count between renders, and React answers that
// with an error rather than a warning.
// `vi.hoisted` because `vi.mock` is lifted above the imports: a factory closing
// over a plain `const` would read it before initialisation.
const imageState = vi.hoisted(() => ({ src: null as string | null, isLoading: true }));

vi.mock("../../../hooks/useCardImage.ts", () => ({
  useCardImage: () => ({
    src: imageState.src,
    isLoading: imageState.isLoading,
    isRotated: false,
    isFlip: false,
    advanceFailedSource: vi.fn(),
  }),
}));

import { ResolvedAnimationImage, type AnimationImageSnapshot } from "../ResolvedAnimationImage.tsx";

const snapshot = { cardName: "Card" } as AnimationImageSnapshot;

describe("ResolvedAnimationImage hook discipline", () => {
  beforeEach(() => {
    imageState.src = null;
    imageState.isLoading = true;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("survives art arriving after a render that fell back", () => {
    // Every hook this component uses is called before its `crossOrigin` handling,
    // so the component keeps the SAME hook count when `src` goes from null to a
    // URL. No assertion is needed beyond the transition itself completing: a hook
    // ordered after the early return throws here, which is exactly the regression
    // that reached the app's error boundary in a real game.
    const { rerender } = render(
      <ResolvedAnimationImage
        snapshot={snapshot}
        size="normal"
        alt=""
        crossOrigin="anonymous"
        fallback={<span data-testid="fallback" />}
      />,
    );
    expect(screen.getByTestId("fallback")).toBeTruthy();

    // The art resolves. Rendering again must not change the hook count.
    imageState.src = "https://images.mtgch.com/zhs/normal/front/a/b/ab.webp";
    imageState.isLoading = false;
    expect(() =>
      rerender(
        <ResolvedAnimationImage
          snapshot={snapshot}
          size="normal"
          alt=""
          crossOrigin="anonymous"
          fallback={<span data-testid="fallback" />}
        />,
      ),
    ).not.toThrow();

    // `alt=""` makes this a presentational image, so it has no `img` role; these
    // layers are decorative by design.
    const img = document.querySelector("img");
    expect(img).not.toBeNull();
    expect(img).toHaveAttribute("src", imageState.src);
    // The caller asked for CORS, so the first attempt still asks for it.
    expect(img).toHaveAttribute("crossorigin", "anonymous");
  });

  it("drops crossOrigin after a failure, keeping the art", () => {
    imageState.src = "https://images.mtgch.com/zhs/normal/front/a/b/cd.webp";
    imageState.isLoading = false;
    render(
      <ResolvedAnimationImage
        snapshot={snapshot}
        size="normal"
        alt=""
        crossOrigin="anonymous"
        fallback={null}
      />,
    );

    const img = document.querySelector("img");
    expect(img).toHaveAttribute("crossorigin", "anonymous");
    // A host that cannot answer a CORS request fails the load; the same URL is
    // then requested plainly so the ART still appears.
    act(() => {
      img!.dispatchEvent(new Event("error"));
    });
    const retried = document.querySelector("img");
    expect(retried).not.toHaveAttribute("crossorigin");
    expect(retried).toHaveAttribute("src", imageState.src);
  });
});
