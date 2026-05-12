import { notFound } from "next/navigation";
import { isLocale, locales } from "@/lib/i18n";
import { PicksLayout, type PicksTab } from "@/components/picks/PicksLayout";
import { HealthTab } from "@/components/picks/tabs/HealthTab";

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
      {tab === "models" && (
        <div className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-6 text-sm text-[color:var(--color-text-muted)]">
          Models tab — implemented in Phase C
        </div>
      )}
      {tab === "explore" && (
        <div className="rounded-2xl border border-[color:var(--color-brand-outline)] bg-[color:var(--color-brand-surface)] p-6 text-sm text-[color:var(--color-text-muted)]">
          Explore tab — implemented in Phase D
        </div>
      )}
    </PicksLayout>
  );
}
