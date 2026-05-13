import { redirect, notFound } from "next/navigation";
import { isLocale, locales } from "@/lib/i18n";

export const dynamicParams = false;
export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export default function LocaleIndex({ params }: { params: { locale: string } }) {
  if (!isLocale(params.locale)) notFound();
  redirect(`/${params.locale}/today`);
}
