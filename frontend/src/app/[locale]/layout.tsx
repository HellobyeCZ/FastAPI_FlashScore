import { notFound } from "next/navigation";
import { isLocale, locales } from "@/lib/i18n";
import { Shell } from "@/components/terminal/Shell";

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export default function LocaleLayout({
  children,
  params
}: {
  children: React.ReactNode;
  params: { locale: string };
}) {
  if (!isLocale(params.locale)) notFound();
  return <Shell>{children}</Shell>;
}
