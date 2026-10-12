"use client";
import { Fragment, useId, useState } from "react";
import { useLocale } from "@/contexts/LocaleContext";
import {
  JOB_EVENT_LIMIT,
  isActiveJob,
  useBulkScrapeJobEvents,
  useBulkScrapeJobs,
  useCancelBulkScrapeJob,
  useStartBulkScrapeJob
} from "@/hooks/useBulkScrapeJobsData";
import { ApiError, errorMessage } from "@/lib/api/http";
import {
  Button,
  Callout,
  Checkbox,
  ConfirmDialog,
  EmptyState,
  Field,
  Input,
  KeyValue,
  Label,
  Panel,
  QueryState,
  Skeleton,
  StateBadge,
  Table,
  type Column
} from "@/components/ui";
import type { BulkScrapeJobCreate, BulkScrapeJobRow } from "@/types/bulk-scrape";
import {
  CONCURRENCY,
  INITIAL_FORM,
  SEASONS,
  estimateEvents,
  groupFailures,
  recentPaths,
  summarizeJobError,
  validateScrapeForm,
  type ScrapeForm
} from "./scrape";

type Notice = { tone: "info" | "neg"; title: string; body?: React.ReactNode };

function useDataLabel() {
  const { t } = useLocale();
  return (stats: boolean, odds: boolean) =>
    stats && odds ? t("ops.scrape.data.both") : stats ? t("ops.scrape.data.stats") : t("ops.scrape.data.odds");
}

/** Competition path that prefers to wrap after a slash on narrow screens. */
function CompetitionPath({ path }: { path: string }) {
  return (
    <span className="text-text [overflow-wrap:anywhere]">
      {path.split("/").map((segment, i) => (
        <Fragment key={i}>
          {i > 0 && (
            <>
              /<wbr />
            </>
          )}
          {segment}
        </Fragment>
      ))}
    </span>
  );
}

function SectionHeading({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <h3 id={id} className="font-sans text-label uppercase tracking-label text-text-dim">
      {children}
    </h3>
  );
}

/** Segmented bar (fetched / failed / skipped) with the counts that are non-zero. */
function JobProgress({ job }: { job: BulkScrapeJobRow }) {
  const { t, fmt } = useLocale();
  const total = job.total_events;
  if (total <= 0) {
    return isActiveJob(job) ? <p className="text-meta text-text-dim">{t("ops.jobs.discovering")}</p> : null;
  }
  const done = job.succeeded_events + job.failed_events + job.skipped_events;
  const width = (n: number) => ({ width: `${Math.min(100, (n / total) * 100)}%` });
  const counts = [
    { n: job.succeeded_events, key: "ops.jobs.fetched", cls: "text-pos" },
    { n: job.skipped_events, key: "ops.jobs.skipped", cls: "text-text-dim" },
    { n: job.failed_events, key: "ops.jobs.failed", cls: "text-neg" }
  ] as const;
  return (
    <div className="flex w-32 max-w-full flex-col gap-1 sm:w-44">
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={done}
        aria-label={t("ops.jobs.progressLabel", { done: fmt.int(done), total: fmt.int(total) })}
        className="flex h-1.5 w-full overflow-hidden bg-surface-3"
      >
        <span className="bg-pos" style={width(job.succeeded_events)} />
        <span className="bg-neg" style={width(job.failed_events)} />
        <span className="bg-text-faint" style={width(job.skipped_events)} />
      </div>
      <span className="text-meta tabular-nums text-text-dim">
        {t("ops.jobs.progress", { done: fmt.int(done), total: fmt.int(total) })}
      </span>
      <span className="flex flex-wrap gap-x-2 text-meta tabular-nums">
        {counts
          .filter((c) => c.n > 0)
          .map((c) => (
            <span key={c.key} className={c.cls}>
              {t(c.key, { count: fmt.int(c.n) })}
            </span>
          ))}
      </span>
    </div>
  );
}

/**
 * Why a job's events failed: the per-event errors grouped by message, loaded
 * from the job detail when the disclosure is first opened.
 */
function FailedEvents({ job }: { job: BulkScrapeJobRow }) {
  const { t, tp, fmt } = useLocale();
  const [open, setOpen] = useState(false);
  const events = useBulkScrapeJobEvents(job, open);
  return (
    <div className="flex min-w-0 flex-col gap-0.5 text-meta">
      <span className="text-warn">
        {tp("ops.failedEvents", job.failed_events, { count: fmt.int(job.failed_events) })}
      </span>
      <details onToggle={(e) => setOpen(e.currentTarget.open)}>
        <summary className="cursor-pointer text-text-dim hover:text-text">{t("ops.jobs.details")}</summary>
        {open && (
          <div className="mt-1 flex flex-col gap-1 border-l-2 border-warn/50 pl-2">
            <QueryState
              query={events}
              errorTitle={t("ops.jobs.failures.error")}
              loading={<Skeleton lines={2} className="py-1" />}
              isEmpty={(d) => groupFailures(d.events).length === 0}
              empty={<p className="text-text-dim">{t("ops.jobs.failures.none")}</p>}
            >
              {(d) => (
                <ul aria-label={t("ops.jobs.failures.label", { id: job.id })} className="flex flex-col gap-1">
                  {groupFailures(d.events).map((g) => (
                    <li key={g.message ?? ""} className="min-w-0 [overflow-wrap:anywhere]">
                      <span className="text-neg" title={g.example ?? undefined}>
                        {g.message ?? t("ops.jobs.failures.noMessage")}
                      </span>
                      <span className="text-text-faint">
                        {" · "}
                        {tp("ops.events", g.count, { count: fmt.int(g.count) })}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </QueryState>
            {job.total_events > JOB_EVENT_LIMIT && (
              <p className="text-text-faint">{t("ops.jobs.failures.partial", { count: fmt.int(JOB_EVENT_LIMIT) })}</p>
            )}
          </div>
        )}
      </details>
    </div>
  );
}

/** One truncated line of the job's error, with the full text behind a disclosure. */
function JobError({ job }: { job: BulkScrapeJobRow }) {
  const { t } = useLocale();
  if (job.last_error) {
    return (
      <div className="flex min-w-0 flex-col gap-0.5 text-meta">
        <span className="line-clamp-2 text-neg [overflow-wrap:anywhere]" title={job.last_error}>
          {summarizeJobError(job.last_error) || job.last_error}
        </span>
        <details className="group">
          <summary className="cursor-pointer text-text-dim hover:text-text">{t("ops.jobs.details")}</summary>
          <p className="mt-1 whitespace-pre-wrap border-l-2 border-neg/50 pl-2 text-text-dim [overflow-wrap:anywhere]">
            {job.last_error}
          </p>
        </details>
      </div>
    );
  }
  // completed_with_errors carries no message: the failures are per event.
  return job.failed_events > 0 ? <FailedEvents job={job} /> : null;
}

/** Form → validated request → confirmation stating scope and upstream cost. */
function NewScrapeForm({
  jobs,
  onQueued
}: {
  jobs: BulkScrapeJobRow[];
  onQueued: (job: BulkScrapeJobRow) => void;
}) {
  const { t, tp, fmt } = useLocale();
  const dataLabel = useDataLabel();
  const start = useStartBulkScrapeJob();
  const [form, setForm] = useState<ScrapeForm>(INITIAL_FORM);
  const [submitted, setSubmitted] = useState(false);
  const [pending, setPending] = useState<BulkScrapeJobCreate | null>(null);
  const headingId = useId();

  const result = validateScrapeForm(form);
  const errors = submitted && !result.ok ? result.errors : {};
  const recent = recentPaths(jobs);
  const estimate = pending ? estimateEvents(jobs, pending) : null;
  const set = (patch: Partial<ScrapeForm>) => setForm((f) => ({ ...f, ...patch }));
  const bounds = (r: { min: number; max: number }) => ({ min: fmt.int(r.min), max: fmt.int(r.max) });
  const range = (r: { min: number; max: number }) => t("ops.scrape.range", bounds(r));
  const rangeError = (r: { min: number; max: number }) => t("ops.scrape.err.range", bounds(r));

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitted(true);
    if (result.ok) setPending(result.body);
  }

  function confirm() {
    if (!pending) return;
    start.mutate(pending, {
      onSuccess: (job) => {
        setPending(null);
        setSubmitted(false);
        setForm(INITIAL_FORM);
        onQueued(job);
      }
    });
  }

  return (
    <section aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3">
      <SectionHeading id={headingId}>{t("ops.scrape.new")}</SectionHeading>
      <form noValidate onSubmit={submit} className="flex flex-col gap-4">
        <div className="flex flex-col gap-2">
          <Field
            label={t("ops.scrape.path")}
            hint={t("ops.scrape.pathHint")}
            error={
              errors.path === "required"
                ? t("ops.scrape.err.pathRequired")
                : errors.path === "format"
                  ? t("ops.scrape.err.pathFormat")
                  : undefined
            }
          >
            {(p) => (
              <Input
                {...p}
                value={form.path}
                onChange={(e) => set({ path: e.target.value })}
                placeholder={t("ops.scrape.pathPlaceholder")}
                autoComplete="off"
                spellCheck={false}
                className="w-full"
              />
            )}
          </Field>
          {recent.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-meta text-text-faint">{t("ops.scrape.recent")}</span>
              {recent.map((p) => (
                <Button
                  key={p}
                  size="sm"
                  onClick={() => set({ path: p })}
                  title={p}
                  className="min-w-0 max-w-full normal-case"
                >
                  <span className="truncate">{p}</span>
                </Button>
              ))}
            </div>
          )}
        </div>

        <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
          <Field
            label={t("ops.scrape.seasons")}
            hint={range(SEASONS)}
            error={errors.seasons ? rangeError(SEASONS) : undefined}
            className="w-28"
          >
            {(p) => (
              <Input
                {...p}
                type="number"
                inputMode="numeric"
                min={SEASONS.min}
                max={SEASONS.max}
                step={1}
                value={form.seasons}
                onChange={(e) => set({ seasons: e.target.value })}
                className="w-full"
              />
            )}
          </Field>
          <Field
            label={t("ops.scrape.concurrency")}
            hint={range(CONCURRENCY)}
            error={errors.concurrency ? rangeError(CONCURRENCY) : undefined}
            className="w-36"
          >
            {(p) => (
              <Input
                {...p}
                type="number"
                inputMode="numeric"
                min={CONCURRENCY.min}
                max={CONCURRENCY.max}
                step={1}
                value={form.concurrency}
                onChange={(e) => set({ concurrency: e.target.value })}
                className="w-full"
              />
            )}
          </Field>
          <fieldset className="flex min-w-0 flex-col gap-1.5">
            <legend className="contents">
              <Label as="span">{t("ops.scrape.fetch")}</Label>
            </legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5 pt-1.5">
              <Checkbox
                label={t("ops.scrape.includeStats")}
                checked={form.includeStats}
                onChange={(v) => set({ includeStats: v })}
              />
              <Checkbox
                label={t("ops.scrape.includeOdds")}
                checked={form.includeOdds}
                onChange={(v) => set({ includeOdds: v })}
              />
            </div>
            {errors.include && <p className="text-meta text-neg">{t("ops.scrape.err.include")}</p>}
          </fieldset>
        </div>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <Button type="submit" variant="primary">
            {t("ops.scrape.review")}
          </Button>
          <span className="text-meta text-text-faint">{t("ops.scrape.reviewHint")}</span>
        </div>
      </form>

      <ConfirmDialog
        open={pending !== null}
        onClose={() => {
          setPending(null);
          start.reset();
        }}
        onConfirm={confirm}
        title={t("ops.scrape.confirm.title")}
        confirmLabel={t("ops.scrape.confirm.start")}
        busy={start.isPending}
        error={start.isError ? t("ops.scrape.startFailed", { message: errorMessage(start.error) }) : undefined}
      >
        {pending && (
          <>
            <KeyValue
              items={[
                {
                  label: t("ops.scrape.confirm.path"),
                  value: <span title={pending.competition_path}>{pending.competition_path}</span>
                },
                {
                  label: t("ops.scrape.confirm.seasons"),
                  value: tp("ops.seasons", pending.seasons, { count: fmt.int(pending.seasons) })
                },
                {
                  label: t("ops.scrape.confirm.events"),
                  value: estimate
                    ? t("ops.scrape.confirm.estimate", {
                        count: tp("ops.events", estimate.events, { count: fmt.int(estimate.events) })
                      })
                    : t("ops.scrape.confirm.unknown")
                },
                { label: t("ops.scrape.confirm.data"), value: dataLabel(pending.include_stats, pending.include_odds) },
                { label: t("ops.scrape.confirm.concurrency"), value: fmt.int(pending.max_concurrency) }
              ]}
            />
            <p className="text-meta">
              {!estimate
                ? t("ops.scrape.confirm.unknownBasis")
                : estimate.scaled
                  ? t("ops.scrape.confirm.basisScaled", {
                      id: estimate.basis.id,
                      total: tp("ops.events", estimate.basis.total_events, {
                        count: fmt.int(estimate.basis.total_events)
                      }),
                      seasons: tp("ops.seasons", estimate.basis.seasons, {
                        count: fmt.int(estimate.basis.seasons)
                      }),
                      n: fmt.int(estimate.basis.seasons)
                    })
                  : t("ops.scrape.confirm.basisSame", {
                      id: estimate.basis.id,
                      total: tp("ops.events", estimate.basis.total_events, {
                        count: fmt.int(estimate.basis.total_events)
                      }),
                      skipped: fmt.int(estimate.basis.skipped_events)
                    })}
            </p>
            <p className="text-warn">{t("ops.scrape.confirm.cost")}</p>
          </>
        )}
      </ConfirmDialog>
    </section>
  );
}

/**
 * Bulk scrape: historical backfill jobs. Both starting and stopping a job go
 * through a confirmation, and the list polls only while a job is active.
 */
export function BulkScrapePanel() {
  const { t, tp, fmt } = useLocale();
  const dataLabel = useDataLabel();
  const jobs = useBulkScrapeJobs();
  const cancel = useCancelBulkScrapeJob();
  const [stopping, setStopping] = useState<BulkScrapeJobRow | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const jobsHeadingId = useId();

  const rows = jobs.data?.jobs ?? [];

  function confirmStop() {
    if (!stopping) return;
    const job = stopping;
    cancel.mutate(job.id, {
      onSuccess: () => setNotice({ tone: "info", title: t("ops.jobs.stopped", { id: job.id }) }),
      onError: (err) =>
        setNotice({
          tone: "neg",
          title: t("ops.jobs.stop.failed", { id: job.id }),
          body: (
            <>
              <code className="break-all">{errorMessage(err)}</code>
              {err instanceof ApiError && err.status === 404 && (
                <span className="mt-1 block">{t("ops.jobs.stop.notFound")}</span>
              )}
            </>
          )
        }),
      onSettled: () => setStopping(null)
    });
  }

  const columns: Column<BulkScrapeJobRow>[] = [
    {
      key: "competition",
      header: t("ops.jobs.col.competition"),
      cell: (j) => (
        <div className="flex min-w-[6rem] flex-col gap-0.5">
          <CompetitionPath path={j.competition_path} />
          <span className="text-meta text-text-dim">
            #{j.id} · {tp("ops.seasons", j.seasons, { count: fmt.int(j.seasons) })}
            <span className="hidden sm:inline">
              {" · "}
              {t("ops.jobs.options", {
                data: dataLabel(j.include_stats, j.include_odds),
                concurrency: fmt.int(j.max_concurrency)
              })}
            </span>
          </span>
          <JobError job={j} />
        </div>
      )
    },
    {
      key: "status",
      header: t("ops.jobs.col.status"),
      cell: (j) => (
        <div className="flex flex-col items-start gap-1.5">
          <div className="flex w-full flex-wrap items-center justify-between gap-2">
            <StateBadge state={j.status} />
            {isActiveJob(j) && (
              <Button
                variant="danger"
                size="sm"
                onClick={() => setStopping(j)}
                aria-label={t("ops.jobs.stopLabel", { id: j.id })}
              >
                {t("ops.jobs.stop")}
              </Button>
            )}
          </div>
          <JobProgress job={j} />
        </div>
      )
    },
    {
      key: "updated",
      header: t("ops.jobs.col.updated"),
      align: "right",
      hideBelow: "md",
      cell: (j) => (
        <time dateTime={j.updated_at} title={fmt.dateTime(j.updated_at)} className="whitespace-nowrap text-text-dim">
          {fmt.relative(j.updated_at)}
        </time>
      )
    }
  ];

  const remaining = stopping ? stopping.pending_events + stopping.running_events : 0;

  return (
    <Panel title={t("ops.scrape.title")} description={t("ops.scrape.description")}>
      <div className="grid gap-x-8 gap-y-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <NewScrapeForm
          jobs={rows}
          onQueued={(job) =>
            setNotice({ tone: "info", title: t("ops.scrape.started", { id: job.id, path: job.competition_path }) })
          }
        />

        <section aria-labelledby={jobsHeadingId} className="flex min-w-0 flex-col gap-3">
          <SectionHeading id={jobsHeadingId}>{t("ops.jobs.title")}</SectionHeading>
          {notice && (
            <Callout
              tone={notice.tone}
              title={notice.title}
              urgent={notice.tone === "neg"}
              action={
                <Button variant="ghost" size="sm" onClick={() => setNotice(null)}>
                  {t("ops.dismiss")}
                </Button>
              }
            >
              {notice.body}
            </Callout>
          )}
          <QueryState
            query={jobs}
            errorTitle={t("ops.jobs.error")}
            loading={
              <Table
                caption={t("ops.jobs.caption")}
                columns={columns}
                rows={[]}
                rowKey={(j) => String(j.id)}
                loading
                skeletonRows={4}
              />
            }
            isEmpty={(d) => d.jobs.length === 0}
            empty={
              <EmptyState compact title={t("ops.jobs.empty")}>
                {t("ops.jobs.emptyHint")}
              </EmptyState>
            }
          >
            {(d) => (
              <Table caption={t("ops.jobs.caption")} columns={columns} rows={d.jobs} rowKey={(j) => String(j.id)} />
            )}
          </QueryState>
        </section>
      </div>

      <ConfirmDialog
        open={stopping !== null}
        onClose={() => setStopping(null)}
        onConfirm={confirmStop}
        title={stopping ? t("ops.jobs.stop.title", { id: stopping.id }) : ""}
        confirmLabel={t("ops.jobs.stop.confirm")}
        tone="danger"
        busy={cancel.isPending}
      >
        {stopping && (
          <p>
            {stopping.total_events > 0
              ? t("ops.jobs.stop.body", {
                  path: stopping.competition_path,
                  events: tp("ops.events", remaining, { count: fmt.int(remaining) }),
                  n: fmt.int(remaining)
                })
              : t("ops.jobs.stop.bodyDiscovering", { path: stopping.competition_path })}
          </p>
        )}
      </ConfirmDialog>
    </Panel>
  );
}
