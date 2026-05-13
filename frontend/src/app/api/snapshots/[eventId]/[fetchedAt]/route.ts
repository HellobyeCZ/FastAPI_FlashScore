import { NextResponse } from "next/server";
import { prisma } from "@/server/prisma";
import type { EventOddsSummary, MarketOdds, BookmakerOdds } from "@/types/odds";

export const dynamic = "force-dynamic";

const MARKET_LABELS: Record<string, string> = {
  HOME_DRAW_AWAY: "1X2",
  DRAW_NO_BET: "Draw no bet",
  DOUBLE_CHANCE: "Double chance",
  OVER_UNDER: "Over/Under",
  TOTAL_GOALS: "Total goals",
  BOTH_TEAMS_TO_SCORE: "Both teams to score",
  BTTS: "Both teams to score",
  ODD_EVEN: "Odd/Even",
  ASIAN_HANDICAP: "Asian handicap",
  EUROPEAN_HANDICAP: "European handicap"
};

function marketName(market: string): string {
  const [prefix, scope] = market.split(":");
  const head = MARKET_LABELS[prefix] ?? prefix;
  if (!scope || scope === "FULL_TIME") return head;
  return `${head} · ${scope.toLowerCase().replace(/_/g, " ")}`;
}

function inferOutcomeLabel(marketPrefix: string, position: number): string {
  switch (marketPrefix) {
    case "HOME_DRAW_AWAY":
      return ["1", "X", "2"][position] ?? `Selection ${position + 1}`;
    case "DRAW_NO_BET":
      return ["1", "2"][position] ?? `Selection ${position + 1}`;
    case "DOUBLE_CHANCE":
      return ["1X", "12", "X2"][position] ?? `Selection ${position + 1}`;
    case "OVER_UNDER":
    case "TOTAL_GOALS":
      return ["Over", "Under"][position] ?? `Selection ${position + 1}`;
    case "BOTH_TEAMS_TO_SCORE":
    case "BTTS":
      return ["Yes", "No"][position] ?? `Selection ${position + 1}`;
    case "ODD_EVEN":
      return ["Odd", "Even"][position] ?? `Selection ${position + 1}`;
    case "ASIAN_HANDICAP":
    case "EUROPEAN_HANDICAP":
      return ["Home", "Away"][position] ?? `Selection ${position + 1}`;
    default:
      return `Selection ${position + 1}`;
  }
}

// selection_key is either an opaque outcome id, or "<id>@<handicap>" for
// parameterized markets. Recover a readable label from the market prefix +
// the per-(market, key) order seen in the data, and append the handicap when
// present.
function makeLabeler(market: string) {
  const prefix = market.split(":")[0] ?? market;
  const keyToPosition = new Map<string, number>();
  return (selectionKey: string) => {
    const [base, handicap] = selectionKey.split("@");
    let pos = keyToPosition.get(base);
    if (pos === undefined) {
      pos = keyToPosition.size;
      keyToPosition.set(base, pos);
    }
    const baseLabel = inferOutcomeLabel(prefix, pos);
    return handicap ? `${baseLabel} ${handicap}` : baseLabel;
  };
}

export async function GET(
  _req: Request,
  { params }: { params: { eventId: string; fetchedAt: string } }
) {
  try {
    const fetchedAt = decodeURIComponent(params.fetchedAt);
    const rows = await prisma.liveOddsSnapshot.findMany({
      where: { eventId: params.eventId, fetchedAt },
      orderBy: { id: "asc" },
      select: {
        bookmaker: true,
        market: true,
        selectionKey: true,
        decimalPrice: true
      }
    });

    if (rows.length === 0) {
      return NextResponse.json({
        eventId: params.eventId,
        eventName: "",
        markets: [],
        lastUpdated: fetchedAt
      } satisfies EventOddsSummary);
    }

    const marketMap = new Map<
      string,
      {
        marketId: string;
        marketName: string;
        labeler: (k: string) => string;
        selections: BookmakerOdds[];
      }
    >();

    for (const r of rows) {
      const bucket = marketMap.get(r.market) ?? {
        marketId: r.market,
        marketName: marketName(r.market),
        labeler: makeLabeler(r.market),
        selections: [] as BookmakerOdds[]
      };
      const selectionName = bucket.labeler(r.selectionKey);
      bucket.selections.push({
        bookmakerId: r.bookmaker ?? "unknown",
        bookmakerName: r.bookmaker ?? "Unknown bookmaker",
        selectionId: r.selectionKey,
        selectionName,
        odds: r.decimalPrice
      });
      marketMap.set(r.market, bucket);
    }

    const markets: MarketOdds[] = Array.from(marketMap.values()).map((m) => ({
      marketId: m.marketId,
      marketName: m.marketName,
      selections: m.selections
    }));

    const summary: EventOddsSummary = {
      eventId: params.eventId,
      eventName: "",
      markets,
      lastUpdated: fetchedAt
    };
    return NextResponse.json(summary);
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
