import type { settings as en } from "../en/settings";

export const settings: Record<keyof typeof en, string> = {
  "settings.title": "Nastavení",
  "settings.description": "Předvolby pro tento prohlížeč. Změny platí okamžitě.",

  "settings.language.title": "Jazyk",
  "settings.language.description": "Přepne všechny stránky; zůstanete na té, kde právě jste.",
  "settings.language.label": "Jazyk rozhraní",

  "settings.display.title": "Zobrazení",
  "settings.display.description": "Jak hustě a jak retro terminál vypadá.",
  "settings.dense": "Kompaktní tabulky",
  "settings.dense.hint": "Menší odsazení řádků, na obrazovku se vejde víc řádků.",
  "settings.scanlines": "CRT rastr",
  "settings.scanlines.hint": "Jemný rastr přes celou obrazovku. Čistě dekorativní.",

  "settings.today.title": "Výchozí pohled Dnes",
  "settings.today.description": "Co program na stránce Dnes ukáže po otevření.",
  "settings.minEdge.label": "Minimální výhoda",
  "settings.minEdge.all": "Vše",
  "settings.minEdge.hint": "Tipy s nižší výhodou budou zpočátku skryté. Filtr lze na stránce Dnes dál měnit.",

  "settings.about.title": "O aplikaci",
  "settings.about.description": "Které verze běží a jestli backend odpovídá.",
  "settings.about.frontend": "Verze frontendu",
  "settings.about.backend": "Verze backendu",
  "settings.about.status": "Stav backendu",
  "settings.about.db": "Velikost databáze",
  "settings.about.checked": "Stav vytvořen",
  "settings.about.ops": "Otevřít Správu dat",
  "settings.about.error": "Backend neodpovídá",
  "settings.about.errorHint": "Spusťte FastAPI (uvicorn src:app na portu 8000) a zkuste to znovu."
};
