// Eagerly bundle every locale catalog at build time. Vite inlines the JSON into
// the bundle so the app works fully offline (PWA + Tauri) with no network fetch.
// This is the single source of i18n catalog data — `index.ts` feeds it to i18next
// and `react-i18next.d.ts` derives typed keys from the English files.
const modules = import.meta.glob("./locales/*/*.json", {
  eager: true,
  import: "default",
}) as Record<string, Record<string, unknown>>;

/** Languages the app ships chrome catalogs for. English is the typing oracle and
 *  the `fallbackLng`; the others may lag without breaking the build.
 *
 *  `zhs` is here so a player can choose Chinese as the INTERFACE language, which
 *  is what makes the `artLanguage: "auto"` default resolve to Chinese card art.
 *  Its catalogs currently mirror English: the keys exist so i18next has a
 *  namespace to resolve and missing-string fallback never has to guess, and the
 *  translations land separately. Without the entry, `auto` could never reach
 *  Chinese and the art default would silently render English. */
export const SUPPORTED_LNGS = ["en", "es", "fr", "de", "it", "pt", "pl", "ja", "zhs"] as const;
export type SupportedLng = (typeof SUPPORTED_LNGS)[number];

function isSupportedLng(value: string): value is SupportedLng {
  return (SUPPORTED_LNGS as readonly string[]).includes(value);
}

/**
 * Reduces a browser or persisted language tag to the app's closed locale set.
 * Content sidecars and card-art maps are named by their two-letter app locale,
 * so allowing an otherwise-valid tag such as `pt-BR` through would make chrome
 * i18next fall back while those consumers request nonexistent assets.
 */
export function normalizeSupportedLng(value: unknown, fallback: SupportedLng): SupportedLng {
  if (typeof value !== "string") return fallback;
  const prefix = value.trim().split("-", 1)[0]?.toLowerCase() ?? "";
  // A browser spells Chinese `zh`, `zh-CN`, `zh-Hans`, `zh-Hant` or `zh-TW`. The
  // app spells the locale `zhs` (matching its card-art code) and serves ONE
  // Chinese: simplified. Every `zh*` tag therefore maps here, including the
  // traditional ones — there is no separate traditional catalog to send them to,
  // and simplified is the intended answer for all of them.
  if (prefix === "zh") return "zhs";
  return isSupportedLng(prefix) ? prefix : fallback;
}

/** `{ en: { common: {...}, ... }, es: {...}, ... }` reshaped from the flat glob
 *  keyed by `./locales/<lng>/<ns>.json`. */
export const resources: Record<string, Record<string, Record<string, unknown>>> =
  Object.entries(modules).reduce<
    Record<string, Record<string, Record<string, unknown>>>
  >((acc, [path, mod]) => {
    const match = /\.\/locales\/([^/]+)\/([^/]+)\.json$/.exec(path);
    if (!match) return acc;
    const [, lng, ns] = match;
    (acc[lng] ??= {})[ns] = mod;
    return acc;
  }, {});

/** Map the browser's locale prefix to a supported language, else English. The
 *  preferences store calls this for the cold-start default (no detector needed). */
export function detectInitialLanguage(): SupportedLng {
  if (typeof navigator === "undefined") return "en";
  return normalizeSupportedLng(navigator.language, "en");
}
