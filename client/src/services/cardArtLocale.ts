/**
 * Card-art locale vocabulary: which languages art can be rendered in, and how a
 * stored preference resolves to one.
 *
 * Deliberately its own module with NO imports, because two very different
 * consumers need it: the card-image pipeline in `scryfall.ts`, and the
 * preference store / settings UI, which must not depend on the image module at
 * all. Keeping the vocabulary here is also what keeps the many tests that mock
 * `scryfall.ts` from having to restate it — the mock replaces the image module,
 * not the locale domain.
 *
 * This set is NOT `SUPPORTED_LNGS` (the UI languages) and the two are not nested
 * in either direction:
 *   - `zhs` — Simplified Chinese — has art but no UI catalog. Scryfall has no
 *     Simplified-Chinese printings whatsoever, so this art comes from a
 *     community card database; there is no Chinese translation of the chrome.
 *   - `pl` has a UI catalog but no localized art: MTGJSON carries zero Polish
 *     `foreignData` and Scryfall rejects `lang:pl` outright.
 * Coupling the two sets would therefore force either a full Chinese translation
 * catalog or no Chinese cards, which is why a player picks card-art language
 * separately from interface language.
 */
export const ART_LANGUAGES = ["en", "es", "fr", "de", "it", "pt", "pl", "ja", "zhs"] as const;
export type ArtLanguage = (typeof ART_LANGUAGES)[number];

export function isArtLanguage(value: unknown): value is ArtLanguage {
  return typeof value === "string" && (ART_LANGUAGES as readonly string[]).includes(value);
}

/** Card-art locale codes whose art is DERIVED from the English printing id
 *  rather than looked up in a generated `scryfall-images.v2.<lng>.json` sidecar. */
export type DerivedArtLocale = "zhs";

const DERIVED_ART_LOCALES = new Set<string>(["zhs"]);

export function isDerivedArtLocale(lang: string): lang is DerivedArtLocale {
  return DERIVED_ART_LOCALES.has(lang);
}

/**
 * The art locale to resolve in, given the UI language and the art-language
 * preference (`"auto"` = follow the UI).
 *
 * Total and never-throwing: an unrecognized preference falls back to `"auto"`
 * rather than producing a locale no loader can satisfy, which is what makes it
 * safe to call on a value that came out of localStorage.
 */
export function resolveArtLanguage(
  language: string,
  artLanguage: string | undefined,
): string {
  if (artLanguage === "auto" || artLanguage === undefined) return language;
  return isArtLanguage(artLanguage) ? artLanguage : language;
}
