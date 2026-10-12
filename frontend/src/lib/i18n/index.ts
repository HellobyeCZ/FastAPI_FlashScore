import { en } from "./en";
import { cs } from "./cs";

export const locales = ["en", "cs"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

export function isLocale(value: string): value is Locale {
  return (locales as readonly string[]).includes(value);
}

export type MessageKey = keyof typeof en;
export type MessageValues = Record<string, string | number>;

/** Keys that have plural variants: "x.one" / "x.few" / "x.many" / "x.other". */
export type PluralKey = MessageKey extends infer K
  ? K extends `${infer Base}.other`
    ? Base
    : never
  : never;

const catalogs: Record<Locale, Record<MessageKey, string>> = { en, cs };

function interpolate(template: string, values?: MessageValues): string {
  if (!values) return template;
  return template.replace(/\{(\w+)\}/g, (_, token: string) => {
    const value = values[token];
    return value === undefined ? `{${token}}` : String(value);
  });
}

export function formatMessage(locale: Locale, key: MessageKey, values?: MessageValues): string {
  const template = catalogs[locale][key] ?? catalogs[defaultLocale][key] ?? key;
  return interpolate(template, values);
}

const pluralRules: Partial<Record<Locale, Intl.PluralRules>> = {};

/**
 * Plural-aware lookup. Czech needs one/few/many/other ("1 sázka", "3 sázky",
 * "5 sázek"); English uses one/other. Falls back to ".other".
 */
export function formatPlural(
  locale: Locale,
  base: PluralKey,
  count: number,
  values?: MessageValues
): string {
  const rules = (pluralRules[locale] ??= new Intl.PluralRules(locale));
  const category = rules.select(count);
  const key = `${base}.${category}` as MessageKey;
  const fallback = `${base}.other` as MessageKey;
  const catalog = catalogs[locale];
  const template = catalog[key] ?? catalog[fallback] ?? catalogs[defaultLocale][fallback];
  return interpolate(template, { count, ...values });
}

/** Swap the leading /{locale} segment of a pathname. */
export function switchLocalePath(pathname: string, next: Locale): string {
  const parts = pathname.split("/");
  if (parts.length > 1 && isLocale(parts[1])) {
    parts[1] = next;
    return parts.join("/") || `/${next}`;
  }
  return `/${next}${pathname === "/" ? "" : pathname}`;
}
