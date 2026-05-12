import { notFound } from "next/navigation";
import { isLocale, locales } from "@/lib/i18n";
import { PicksLayout, type PicksTab } from "@/components/picks/PicksLayout";
import { HealthTab } from "@/components/picks/tabs/HealthTab";
import { ModelsTab } from "@/components/picks/tabs/ModelsTab";
import { ExploreTab } from "@/components/picks/tabs/ExploreTab";

export const dynamicParams = false;

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

const VALID_TABS: PicksTab[] = ["health", "models", "explore"];

export default function PicksPage({
  params,
  searchParams,
}: {
  params: { locale: string };
  searchParams: { tab?: string };
}) {
  if (!isLocale(params.locale)) {
    notFound();
  }
  const tab: PicksTab =
    VALID_TABS.includes(searchParams.tab as PicksTab)
      ? (searchParams.tab as PicksTab)
      : "health";

  return (
    <PicksLayout activeTab={tab}>
      {tab === "health" && <HealthTab />}
      {tab === "models" && <ModelsTab />}
      {tab === "explore" && <ExploreTab />}
    </PicksLayout>
  );
}
