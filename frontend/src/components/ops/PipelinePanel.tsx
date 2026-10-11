"use client";
import { useLocale } from "@/contexts/LocaleContext";
import { useOpsStatus } from "@/hooks/useOpsStatus";
import { ageHours, parseDate } from "@/lib/format";
import { routes } from "@/lib/routes";
import { Badge, Panel, QueryState, Table, TextLink, type Column } from "@/components/ui";
import type { Tone } from "@/lib/labels";
import type { MessageKey, PluralKey } from "@/lib/i18n";
import type { OpsStatus } from "@/types/ops";

type Verdict =
  | "fresh"
  | "stale"
  | "overdue"
  | "never"
  | "behind"
  | "clear"
  | "ok"
  | "none"
  | "notNeeded"
  | "manual"
  | "running"
  | "idle";

type StageId = "picks" | "settled" | "pending" | "liveOdds" | "discovery" | "fixtures" | "scrape" | "backtests";

type Row = {
  id: StageId;
  /** Timestamp stages show an age; count stages show a quantity. */
  at?: string | null;
  count?: { n: number; unit: PluralKey };
  /** Freshness rule shown under the description. */
  rule?: boolean;
  verdict: Verdict;
  tone: Tone;
};

/**
 * Age thresholds (hours), matching the backend health rules (spec §4.1). As in
 * the backend, a step that never ran is a warning (expected on a fresh
 * install); only a step that ran and then stopped escalates.
 */
const PICKS_WARN_H = 36;
const PICKS_ERROR_H = 7 * 24;
const ODDS_WARN_H = 24;

function byAge(at: string | null, warnH: number, errorH: number, now: Date): Pick<Row, "verdict" | "tone"> {
  if (!at) return { verdict: "never", tone: "warn" };
  const h = ageHours(at, now);
  if (h > errorH) return { verdict: "overdue", tone: "neg" };
  if (h > warnH) return { verdict: "stale", tone: "warn" };
  return { verdict: "fresh", tone: "pos" };
}

function buildRows(s: OpsStatus, now: Date): Row[] {
  const p = s.pipeline;
  // Only the backend knows pending kickoff times; trust its settle_overdue
  // verdict instead of re-deriving it from recommendation times.
  const overdue = s.health.issues.some((i) => i.code === "settle_overdue");
  const settleTone: Tone = overdue ? "warn" : "pos";
  const settled: Pick<Row, "verdict" | "tone"> = overdue
    ? { verdict: "behind", tone: "warn" }
    : p.pending_bets === 0
      ? { verdict: "clear", tone: "pos" }
      : p.last_settled_at
        ? { verdict: "ok", tone: "pos" }
        : { verdict: "never", tone: "warn" };
  // Live odds only matter while fixtures are coming up (backend live_odds_stale).
  const fixtures = p.upcoming_fixtures_72h > 0;
  return [
    {
      id: "picks",
      at: p.last_pick_recorded_at,
      rule: true,
      ...byAge(p.last_pick_recorded_at, PICKS_WARN_H, PICKS_ERROR_H, now)
    },
    {
      id: "settled",
      at: p.last_settled_at,
      rule: true,
      ...settled
    },
    {
      id: "pending",
      count: { n: p.pending_bets, unit: "ops.count.bets" },
      verdict: overdue ? "overdue" : p.pending_bets === 0 ? "clear" : "ok",
      tone: settleTone
    },
    {
      id: "liveOdds",
      at: p.last_live_odds_at,
      rule: true,
      ...(fixtures
        ? byAge(p.last_live_odds_at, ODDS_WARN_H, Infinity, now)
        : { verdict: "notNeeded" as const, tone: "neutral" as const })
    },
    { id: "discovery", at: p.last_discovery_at, rule: true, ...byAge(p.last_discovery_at, ODDS_WARN_H, Infinity, now) },
    {
      id: "fixtures",
      count: { n: p.upcoming_fixtures_72h, unit: "ops.count.fixtures" },
      verdict: fixtures ? "ok" : "none",
      tone: fixtures ? "pos" : "warn"
    },
    {
      id: "scrape",
      at: p.last_scrape_job_at,
      verdict: p.active_scrape_jobs > 0 ? "running" : "manual",
      tone: p.active_scrape_jobs > 0 ? "info" : "neutral"
    },
    {
      id: "backtests",
      count: { n: p.active_backtests, unit: "ops.count.active" },
      verdict: p.active_backtests > 0 ? "running" : "idle",
      tone: p.active_backtests > 0 ? "info" : "neutral"
    }
  ];
}

/** Freshness of each pipeline step, with the rule that decides its tone. */
export function PipelinePanel() {
  const { t, tp, fmt, locale } = useLocale();
  const q = useOpsStatus();

  function columns(s: OpsStatus | null, now: Date): Column<Row>[] {
    return [
      {
        key: "stage",
        header: t("ops.pipeline.col.stage"),
        cell: (r) => (
          <div className="min-w-0">
            <div className="font-sans text-body text-text">{t(`ops.stage.${r.id}` as MessageKey)}</div>
            <div className="text-meta text-text-dim">{t(`ops.stage.${r.id}.desc` as MessageKey)}</div>
            {r.rule && <div className="text-meta text-text-faint">{t(`ops.stage.${r.id}.rule` as MessageKey)}</div>}
            {r.id === "backtests" && (
              <div className="mt-0.5 text-meta">
                <TextLink href={routes.backtests(locale)}>{t("ops.stage.backtests.link")}</TextLink>
              </div>
            )}
          </div>
        )
      },
      {
        key: "latest",
        header: t("ops.pipeline.col.last"),
        align: "right",
        cell: (r) => (
          <div className="flex flex-col items-end gap-1">
            <span className="whitespace-nowrap text-text">
              {r.count ? (
                tp(r.count.unit, r.count.n, { count: fmt.int(r.count.n) })
              ) : r.at ? (
                <time dateTime={r.at} title={fmt.dateTime(r.at)}>
                  {fmt.relative(r.at, now)}
                </time>
              ) : (
                <span className="text-text-faint">{t("common.never")}</span>
              )}
            </span>
            {r.id === "pending" && s?.pipeline.oldest_pending_at && s.pipeline.pending_bets > 0 && (
              <time
                dateTime={s.pipeline.oldest_pending_at}
                title={fmt.dateTime(s.pipeline.oldest_pending_at)}
                className="text-meta text-text-dim"
              >
                {t("ops.stage.pending.oldest", { age: fmt.relative(s.pipeline.oldest_pending_at, now) })}
              </time>
            )}
            <span data-verdict={r.verdict}>
              <Badge tone={r.tone}>{t(`ops.fresh.${r.verdict}` as MessageKey)}</Badge>
            </span>
          </div>
        )
      }
    ];
  }

  return (
    <Panel title={t("ops.pipeline.title")} description={t("ops.pipeline.description")} padding="none">
      <div className={q.isError ? "p-4" : undefined}>
        <QueryState
          query={q}
          errorTitle={t("ops.statusError")}
          loading={
            <Table
              caption={t("ops.pipeline.caption")}
              columns={columns(null, new Date())}
              rows={[]}
              rowKey={(r) => r.id}
              loading
              skeletonRows={8}
            />
          }
        >
          {(s) => {
            // Ages are measured at the moment the backend evaluated health, so
            // they match the ages behind the health banner above.
            const now = parseDate(s.generated_at) ?? new Date();
            return (
              <Table
                caption={t("ops.pipeline.caption")}
                columns={columns(s, now)}
                rows={buildRows(s, now)}
                rowKey={(r) => r.id}
              />
            );
          }}
        </QueryState>
      </div>
    </Panel>
  );
}
