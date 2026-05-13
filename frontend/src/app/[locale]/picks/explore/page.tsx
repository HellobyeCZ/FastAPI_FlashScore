import { ExploreTab } from "@/components/picks/tabs/ExploreTab";
import { notFound } from "next/navigation";
import { isLocale, locales } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export default function Page({ params }: { params: { locale: string } }) {
  if (!isLocale(params.locale)) notFound();
  return <ExploreTab />;
}
