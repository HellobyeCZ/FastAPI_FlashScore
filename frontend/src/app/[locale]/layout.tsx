import type { Metadata, Viewport } from "next";
import { notFound } from "next/navigation";
import { IBM_Plex_Mono, IBM_Plex_Sans_Condensed } from "next/font/google";
import "@/styles/globals.css";
import { isLocale, locales, formatMessage, type Locale } from "@/lib/i18n";
import { LocaleProvider } from "@/contexts/LocaleContext";
import { QueryProvider } from "@/contexts/QueryProvider";
import { Shell } from "@/components/shell/Shell";

const plexMono = IBM_Plex_Mono({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500"],
  variable: "--font-mono",
  display: "swap"
});

const plexSansCondensed = IBM_Plex_Sans_Condensed({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500"],
  variable: "--font-sans",
  display: "swap"
});

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export function generateMetadata({ params }: { params: { locale: string } }): Metadata {
  const locale: Locale = isLocale(params.locale) ? params.locale : "en";
  const name = formatMessage(locale, "app.name");
  return {
    title: { default: name, template: `%s · ${name}` },
    description: formatMessage(locale, "app.tagline")
  };
}

export const viewport: Viewport = {
  themeColor: "#0a0a0a",
  colorScheme: "dark"
};

// Root layout lives under [locale] so <html lang> matches the page language.
export default function LocaleLayout({
  children,
  params
}: {
  children: React.ReactNode;
  params: { locale: string };
}) {
  if (!isLocale(params.locale)) notFound();
  return (
    <html lang={params.locale} className={`${plexMono.variable} ${plexSansCondensed.variable}`}>
      <body>
        <LocaleProvider>
          <QueryProvider>
            <Shell>{children}</Shell>
          </QueryProvider>
        </LocaleProvider>
      </body>
    </html>
  );
}
