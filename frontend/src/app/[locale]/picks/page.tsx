import { redirect, notFound } from "next/navigation";
import { isLocale, locales } from "@/lib/i18n";

export const dynamicParams = false;
export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export default function PicksIndex({
  params,
  searchParams
}: {
  params: { locale: string };
  searchParams: { tab?: string };
}) {
  if (!isLocale(params.locale)) notFound();
  const tab = searchParams.tab ?? "health";
  const valid = ["health", "models", "explore"] as const;
  const sub = (valid as readonly string[]).includes(tab) ? tab : "health";
  redirect(`/${params.locale}/picks/${sub}`);
}
