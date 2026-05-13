import { notFound } from "next/navigation";
import { isLocale, locales } from "@/lib/i18n";
import { MatchesPage } from "@/components/matches/MatchesPage";

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export default function Page({ params }: { params: { locale: string } }) {
  if (!isLocale(params.locale)) notFound();
  return <MatchesPage />;
}
