import { useCallback, useState } from "react";

/**
 * URLs this session has already fallen back to a no-cors load for.
 *
 * Module-scoped so the decision is made once per URL rather than per mount: the
 * animation layers mount and unmount constantly, and a per-mount flag would make
 * every card pay a second request for the same answer.
 */
const retriedWithoutCors = new Set<string>();

/**
 * The `crossOrigin` value a canvas layer should request `src` with, plus the
 * retry that drops it.
 *
 * The canvas layers need `crossOrigin="anonymous"` because they upload card art
 * into WebGL, and a cross-origin image without it taints the canvas — which a
 * WebGL upload rejects outright. But that attribute PROMOTES the load into CORS
 * mode, where a host with unusable headers is refused before the image ever
 * exists. The derived locale's CDN (`images.mtgch.com`) is exactly that host: it
 * sends `access-control-allow-origin` twice, and a browser rejects a duplicate.
 *
 * Neither choice alone is acceptable — always-CORS loses the art on that host,
 * never-CORS loses the animation on every host — so this retries once: ask for a
 * CORS-clean image first, and if that request fails, load the SAME url as a plain
 * `<img>` and let the animation fall back to its classic presentation. The card
 * keeps its art in both branches; only the presentation differs.
 *
 * The retry is bounded per URL, so a URL that cannot load at all still reports a
 * failure to its caller rather than looping.
 */
export function useCanvasImageCors(src: string | null): {
  crossOrigin: "anonymous" | undefined;
  onError: () => void;
} {
  const [dropped, setDropped] = useState(() => (src ? retriedWithoutCors.has(src) : false));

  const onError = useCallback(() => {
    if (!src || retriedWithoutCors.has(src)) return;
    retriedWithoutCors.add(src);
    setDropped(true);
  }, [src]);

  return {
    crossOrigin: src && !dropped ? "anonymous" : undefined,
    onError,
  };
}
