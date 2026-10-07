import type { ImgHTMLAttributes, ReactNode } from "react";
import { useEffect, useRef } from "react";

import type { GameObject, TokenImageRef } from "../../adapter/types.ts";
import { useCardImage } from "../../hooks/useCardImage.ts";
import { objectImageProps } from "../../services/cardImageLookup.ts";
import { supportsAnonymousCors } from "../../services/scryfall.ts";
import type { TokenSearchFilters } from "../../services/scryfall.ts";

export interface AnimationImageSnapshot {
  objectId: number;
  cardName: string;
  faceIndex: number;
  oracleId?: string;
  faceName?: string;
  isToken: boolean;
  tokenFilters?: TokenSearchFilters;
  tokenImageRef?: TokenImageRef | null;
}

export function visibleAnimationImageSnapshot(
  object: GameObject | undefined,
): AnimationImageSnapshot | null {
  if (object?.display_visible_to_viewer !== true) return null;

  const {
    cardName,
    faceIndex,
    oracleId,
    faceName,
    isToken,
    tokenFilters,
    tokenImageRef,
  } = objectImageProps(object);
  return {
    objectId: object.id,
    cardName,
    faceIndex,
    oracleId,
    faceName,
    isToken,
    tokenFilters,
    tokenImageRef,
  };
}

type AnimationImageAttributes = Omit<
  ImgHTMLAttributes<HTMLImageElement>,
  "alt" | "onError" | "onLoad" | "src" | "srcSet"
>;

interface ResolvedAnimationImageProps extends AnimationImageAttributes {
  snapshot: AnimationImageSnapshot;
  size: "small" | "normal" | "art_crop";
  alt: string;
  fallback: ReactNode;
  onReady?: (image: HTMLImageElement, capturedSrc: string) => void;
  onExhausted?: () => void;
}

export function ResolvedAnimationImage({
  snapshot,
  size,
  alt,
  fallback,
  onReady,
  onExhausted,
  ...imageAttributes
}: ResolvedAnimationImageProps) {
  const { src, isLoading, advanceFailedSource } = useCardImage(snapshot.cardName, {
    size,
    faceIndex: snapshot.faceIndex,
    isToken: snapshot.isToken,
    tokenFilters: snapshot.tokenFilters,
    tokenImageRef: snapshot.tokenImageRef,
    oracleId: snapshot.oracleId,
    faceName: snapshot.faceName,
  });
  const settledRef = useRef(false);

  useEffect(() => {
    if (isLoading || src || settledRef.current) return;
    settledRef.current = true;
    onExhausted?.();
  }, [isLoading, onExhausted, src]);

  if (!src) return fallback;

  const capturedSrc = src;
  // `crossOrigin` is dropped for a host whose headers cannot satisfy a CORS
  // check (see `supportsAnonymousCors`). Callers pass it because these layers
  // read pixels back out of a canvas, which needs a CORS-clean image — but that
  // requirement must not be allowed to fail the load itself. Without the
  // attribute the browser fetches in no-cors mode, the art displays, and only
  // the canvas read is lost.
  const { crossOrigin, ...restAttributes } = imageAttributes;
  const corsAttributes =
    crossOrigin && supportsAnonymousCors(capturedSrc) ? { crossOrigin } : {};
  return (
    <img
      {...restAttributes}
      {...corsAttributes}
      src={capturedSrc}
      alt={alt}
      onLoad={(event) => {
        if (settledRef.current) return;
        settledRef.current = true;
        onReady?.(event.currentTarget, capturedSrc);
      }}
      onError={() => advanceFailedSource?.(capturedSrc)}
    />
  );
}
