import { HealthTab } from "@/components/picks/tabs/HealthTab";
import { notFound } from "next/navigation";
import { isLocale, locales } from "@/lib/i18n";

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export default function Page({ params }: { params: { locale: string } }) {
  if (!isLocale(params.locale)) notFound();
  return <HealthTab />;
}
