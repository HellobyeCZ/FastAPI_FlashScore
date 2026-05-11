import { notFound } from "next/navigation";
import { PicksDashboard } from "@/components/PicksDashboard";
import { isLocale, locales } from "@/lib/i18n";

export const dynamicParams = false;

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export default function PicksPage({ params }: { params: { locale: string } }) {
  if (!isLocale(params.locale)) {
    notFound();
  }
  return <PicksDashboard />;
}
