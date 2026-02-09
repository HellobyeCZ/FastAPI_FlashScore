export const locales = ["en", "cs"] as const;
export type Locale = (typeof locales)[number];
export const defaultLocale: Locale = "en";

export function isLocale(value: string): value is Locale {
  return locales.includes(value as Locale);
}

const enMessages = {
  "a11y.live": "Live updates are enabled.",
  "app.description": "Search an event and compare live bookmaker odds in one place.",
  "app.title": "FastAPI FlashScore Odds",
  "feedback.error": "Unable to load odds right now.",
  "feedback.loading": "Loading latest odds...",
  "feedback.statsError": "Unable to load match stats right now.",
  "feedback.statsLoading": "Loading match stats...",
  "feedback.summary": "{count} markets loaded",
  "locale.cs": "Czech",
  "locale.en": "English",
  "locale.switcher": "Language",
  "refresh.label": "Auto refresh",
  "refresh.next": "Next update in {seconds}s",
  "refresh.off": "Off",
  "refresh.on": "On",
  "search.aria": "Enter event ID",
  "search.cta": "Fetch odds",
  "search.label": "Event ID",
  "search.placeholder": "e.g. 123456",
  "search.support": "Use a FlashScore event identifier.",
  "stats.away": "Away",
  "stats.empty": "No match statistics are available for this event yet.",
  "stats.home": "Home",
  "stats.metric": "Statistic",
  "stats.title": "Match Statistics",
  "table.bookmaker": "Bookmaker",
  "table.empty": "No markets are available for this event yet.",
  "table.market": "Market",
  "table.odds": "Odds",
  "table.selection": "Selection",
  "timestamp.updated": "Updated {time}"
};

export type MessageKey = keyof typeof enMessages;
type MessageCatalog = Record<MessageKey, string>;

const csMessages: MessageCatalog = {
  "a11y.live": "Zive aktualizace jsou zapnute.",
  "app.description": "Vyhledejte udalost a porovnejte zive kurzy bookmakeru na jednom miste.",
  "app.title": "FastAPI FlashScore kurzy",
  "feedback.error": "Kurzy se ted nepodarilo nacist.",
  "feedback.loading": "Nacitam aktualni kurzy...",
  "feedback.statsError": "Statistiky zapasu se ted nepodarilo nacist.",
  "feedback.statsLoading": "Nacitam statistiky zapasu...",
  "feedback.summary": "Nacteno trhu: {count}",
  "locale.cs": "Cestina",
  "locale.en": "Anglictina",
  "locale.switcher": "Jazyk",
  "refresh.label": "Automaticke obnovovani",
  "refresh.next": "Dalsi aktualizace za {seconds}s",
  "refresh.off": "Vypnuto",
  "refresh.on": "Zapnuto",
  "search.aria": "Zadejte ID udalosti",
  "search.cta": "Nacist kurzy",
  "search.label": "ID udalosti",
  "search.placeholder": "napr. 123456",
  "search.support": "Pouzijte identifikator udalosti z FlashScore.",
  "stats.away": "Hoste",
  "stats.empty": "Pro tuto udalost zatim nejsou dostupne statistiky zapasu.",
  "stats.home": "Domaci",
  "stats.metric": "Statistika",
  "stats.title": "Statistiky zapasu",
  "table.bookmaker": "Bookmaker",
  "table.empty": "Pro tuto udalost zatim nejsou dostupne trhy.",
  "table.market": "Trh",
  "table.odds": "Kurz",
  "table.selection": "Vyber",
  "timestamp.updated": "Aktualizovano {time}"
};

const catalogs: Record<Locale, MessageCatalog> = {
  en: enMessages,
  cs: csMessages
};

function interpolate(template: string, values?: Record<string, string | number>): string {
  if (!values) {
    return template;
  }

  return template.replace(/\{(\w+)\}/g, (_, token: string) => {
    const value = values[token];
    return value === undefined ? `{${token}}` : String(value);
  });
}

export function formatMessage(
  locale: Locale,
  key: MessageKey,
  values?: Record<string, string | number>
): string {
  const template = catalogs[locale][key] ?? catalogs[defaultLocale][key];
  return interpolate(template, values);
}
