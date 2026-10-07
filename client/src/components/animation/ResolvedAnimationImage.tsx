import type { ImgHTMLAttributes, ReactNode } from "react";
import { useEffect, useRef } from "react";

import type { GameObject, TokenImageRef } from "../../adapter/types.ts";
import { useCardImage } from "../../hooks/useCardImage.ts";
import { objectImageProps } from "../../services/cardImageLookup.ts";
import { useCanvasImageCors } from "../../services/canvasCorsRetry.ts";
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

  // Both of these are called BEFORE the `!src` early return below, and they must
  // stay there. A hook after a conditional return changes the hook count between
  // renders — `src` is null while the art resolves — which React reports as an
  // error and which took the whole app to its error boundary when this was
  // written the other way round. `useCanvasImageCors` accepts null for exactly
  // this reason.
  const wantsCors = Boolean(imageAttributes.crossOrigin);
  const { crossOrigin: corsValue, onError: retryWithoutCors } = useCanvasImageCors(
    wantsCors ? src : null,
  );
  const { crossOrigin: _declared, ...restAttributes } = imageAttributes;

  useEffect(() => {
    if (isLoading || src || settledRef.current) return;
    settledRef.current = true;
    onExhausted?.();
  }, [isLoading, onExhausted, src]);

  if (!src) return fallback;

  const capturedSrc = src;
  return (
    <img
      {...restAttributes}
      {...(corsValue ? { crossOrigin: corsValue } : {})}
      src={capturedSrc}
      alt={alt}
      onLoad={(event) => {
        if (settledRef.current) return;
        settledRef.current = true;
        onReady?.(event.currentTarget, capturedSrc);
      }}
      onError={() => {
        if (wantsCors && corsValue) {
          retryWithoutCors();
          return;
        }
        advanceFailedSource?.(capturedSrc);
      }}
    />
  );
}
