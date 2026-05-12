"use client";
import { OddsPage } from "@/components/odds/OddsPage";

export default function MatchDetail({
  params
}: {
  params: { locale: string; eventId: string };
}) {
  return <OddsPage initialEventId={params.eventId} />;
}
