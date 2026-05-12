import { notFound } from "next/navigation";
import { isLocale, locales } from "@/lib/i18n";
import { ModelDeepDive } from "@/components/picks/ModelDeepDive";

export const dynamicParams = true;

export function generateStaticParams() {
  return locales.flatMap((locale) =>
    ["dixon_coles", "hgb", "logistic"].map((name) => ({ locale, name })),
  );
}

export default function ModelDeepDivePage({
  params,
}: {
  params: { locale: string; name: string };
}) {
  if (!isLocale(params.locale)) {
    notFound();
  }
  return <ModelDeepDive model={params.name} />;
}
