/**
 * Card-TEXT locale vocabulary: which languages a card's name / Oracle text /
 * type line can be displayed in, and how a stored preference resolves to one.
 *
 * A THIRD axis, independent of both the interface language (`SUPPORTED_LNGS`) and
 * the card-art language (`ART_LANGUAGES`). The three sets are not nested in any
 * direction, and card TEXT is the one that needs its own switch:
 *
 *   - `zhs` has text (from the 大学院废墟 dataset, via
 *     `scripts/gen-zhs-card-text.mjs`) and art, but NO UI catalog. A player who
 *     wants to read Chinese cards is not thereby asking for a Chinese interface —
 *     and until a chrome translation exists, coupling the two would mean either
 *     no Chinese cards or a broken UI.
 *   - `pl` has a UI catalog and no localized card text at all (MTGJSON carries
 *     zero Polish `foreignData`), so it cannot appear here.
 *
 * The loaders tolerate every value: `ensureCardLocale` (engineRuntime.ts)
 * resolves a missing sidecar to an empty map and callers fall back to English
 * PER FIELD. So an unrecognized or unpublished locale degrades to English text
 * rather than breaking a card.
 */

/** Locales the app ships a card-content sidecar for (`card-data.<lng>.json`).
 *  `en` is listed because it is a selectable answer, not because a sidecar
 *  exists — English is the card data itself, so `ensureCardLocale("en")` is a
 *  deliberate no-op. */
export const CARD_TEXT_LANGUAGES = [
  "en",
  "es",
  "fr",
  "de",
  "it",
  "pt",
  "ja",
  "zhs",
] as const;
export type CardTextLanguage = (typeof CARD_TEXT_LANGUAGES)[number];

export function isCardTextLanguage(value: unknown): value is CardTextLanguage {
  return typeof value === "string" && (CARD_TEXT_LANGUAGES as readonly string[]).includes(value);
}

/** Card-text language, or `"auto"` to follow the interface language. */
export type CardTextLanguagePreference = "auto" | CardTextLanguage;

/**
 * Reduce an untrusted (persisted or user-supplied) value to a legal card-text
 * preference. Anything unrecognized becomes `"auto"` — the behaviour the app had
 * before this preference existed — so a stale or hand-edited blob can never
 * select a locale no sidecar can satisfy.
 */
export function normalizeCardTextLanguage(value: unknown): CardTextLanguagePreference {
  if (value === "auto") return "auto";
  return isCardTextLanguage(value) ? value : "auto";
}

/**
 * The card-text locale to resolve in, given the interface language and the
 * preference (`"auto"` = follow the interface).
 *
 * Total and never-throwing, mirroring `resolveArtLanguage`: an unrecognized
 * preference falls back to the interface language rather than producing a locale
 * the sidecar loader cannot satisfy, which is what makes it safe to call on a
 * value that came out of localStorage.
 */
export function resolveCardTextLanguage(
  language: string,
  cardTextLanguage: string | undefined,
): string {
  if (cardTextLanguage === "auto" || cardTextLanguage === undefined) return language;
  return isCardTextLanguage(cardTextLanguage) ? cardTextLanguage : language;
}
