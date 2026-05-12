"use client";
import { useQuery } from "@tanstack/react-query";

export type TodayPick = {
  id: string;
  kickoff: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  market: string;
  pick: string;
  odds: number;
  edge: number;
  model: string;
  status: "OPEN" | "PEND" | "WON" | "LOST" | "VOID";
  eventId?: string;
  pnlUnits?: number;
  settledAt?: string;
};

export type TodayJob = {
  id: string;
  competitionPath: string;
  status: string;
  progress?: number;
};

export type TodayData = {
  openPicks: TodayPick[];
  settledPicks: TodayPick[];
  runningJobs: TodayJob[];
};

export function useToday() {
  return useQuery<TodayData>({
    queryKey: ["today"],
    queryFn: async () => {
      const r = await fetch("/api/today");
      if (!r.ok) throw new Error(`today ${r.status}`);
      return r.json();
    },
    refetchOnWindowFocus: false
  });
}
