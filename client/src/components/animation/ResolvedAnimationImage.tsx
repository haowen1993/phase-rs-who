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

  useEffect(() => {
    if (isLoading || src || settledRef.current) return;
    settledRef.current = true;
    onExhausted?.();
  }, [isLoading, onExhausted, src]);

  if (!src) return fallback;

  const capturedSrc = src;
  // These layers upload the image into WebGL, which needs a CORS-clean load; a
  // host that cannot answer one gets a single no-cors retry so the art still
  // appears. See `useCanvasImageCors`.
  const wantsCors = Boolean(imageAttributes.crossOrigin);
  const { crossOrigin: corsValue, onError: retryWithoutCors } = useCanvasImageCors(
    wantsCors ? capturedSrc : null,
  );
  const { crossOrigin: _declared, ...restAttributes } = imageAttributes;
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
