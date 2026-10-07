import { useCallback, useState } from "react";

/**
 * Hosts this session has learned cannot serve a CORS-clean image.
 *
 * Keyed by HOST, not by URL, and that is the whole point. The animation layers
 * give a face 150 ms to load (`CARD_FLIGHT_FACE_READY_MAX_MS`); a retry costs a
 * second round trip, so a per-URL retry would miss that deadline on every card
 * and quietly downgrade all of them to the classic presentation — which is
 * exactly the "the animation disappeared" failure this module exists to avoid.
 * Once one image from a host has failed the CORS attempt, every later image from
 * that host is requested plainly on the first try, and only the first card pays.
 *
 * Module-scoped so the answer outlives the component: these layers mount and
 * unmount constantly, and a per-mount cache would relearn it forever.
 */
const hostsWithoutCors = new Set<string>();

function hostOf(url: string): string | null {
  try {
    return new URL(url, "https://placeholder.invalid").host;
  } catch {
    return null;
  }
}

/**
 * The `crossOrigin` value a canvas layer should request `src` with, plus the
 * retry that drops it and records the host.
 *
 * The canvas layers need `crossOrigin="anonymous"` because they upload card art
 * into WebGL, and a cross-origin image without it taints the canvas — which a
 * WebGL upload rejects outright. But that attribute PROMOTES the load into CORS
 * mode, where a host with unusable headers is refused before the image ever
 * exists. The derived locale's CDN (`images.mtgch.com`) is exactly that host: it
 * sends `access-control-allow-origin` twice, and a browser rejects a duplicate.
 *
 * Neither choice alone is acceptable — always-CORS loses the art on that host,
 * never-CORS loses the animation on every host — so this asks for a CORS-clean
 * image first and falls back to a plain load on failure. The card keeps its art
 * in both branches; only the presentation differs.
 *
 * A URL that fails even without the attribute still reports upward, so a caller's
 * own ladder can advance rather than this looping.
 */
export function useCanvasImageCors(src: string | null): {
  crossOrigin: "anonymous" | undefined;
  onError: () => void;
} {
  const [dropped, setDropped] = useState(() => {
    const host = src ? hostOf(src) : null;
    return host !== null && hostsWithoutCors.has(host);
  });

  const onError = useCallback(() => {
    if (!src) return;
    const host = hostOf(src);
    const known = host !== null && hostsWithoutCors.has(host);
    if (known) return;
    if (host !== null) hostsWithoutCors.add(host);
    setDropped(true);
  }, [src]);

  return {
    crossOrigin: src && !dropped ? "anonymous" : undefined,
    onError,
  };
}

/** Test seam: forget what has been learned about hosts. */
export function resetCanvasCorsHosts(): void {
  hostsWithoutCors.clear();
}
