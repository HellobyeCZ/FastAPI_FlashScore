"use client";
import { PageHeader } from "@/components/terminal/PageHeader";
import { HeroStrip } from "./HeroStrip";
import { TodaySlate } from "./TodaySlate";
import { RecentSettled } from "./RecentSettled";
import { ModelSnapshot } from "./ModelSnapshot";
import { useToday } from "@/hooks/useToday";

export function TodayPage() {
  const { data, isLoading, isError } = useToday();
  return (
    <>
      <PageHeader kicker="Today · Cockpit" />
      <HeroStrip data={data} loading={isLoading} />
      <div className="my-6 border-t border-border" />
      <TodaySlate picks={data?.openPicks ?? []} loading={isLoading} error={isError} />
      <div className="mt-8 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <RecentSettled picks={data?.settledPicks ?? []} loading={isLoading} />
        <ModelSnapshot />
      </div>
    </>
  );
}
