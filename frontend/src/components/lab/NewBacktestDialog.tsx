"use client";
import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale } from "@/contexts/LocaleContext";
import { Button, Callout, Checkbox, Dialog, Field, Input, KeyValue, Label, Select } from "@/components/ui";
import { errorMessage } from "@/lib/api/http";
import { modelLabel } from "@/lib/labels";
import { routes } from "@/lib/routes";
import {
  useBacktestModels,
  useCreateBacktest,
  type BacktestRunDetail,
  type CreateBacktestRequest
} from "@/lib/lab/backtests";
import { isoDay, marketSpecLabel } from "@/lib/lab/format";

export type FormState = {
  model: string;
  trainUntil: string;
  testUntil: string;
  minEdgePct: string;
  kelly: string;
  forceBets: boolean;
  label: string;
};

type FieldName = "model" | "trainUntil" | "testUntil" | "minEdgePct" | "kelly" | "label";
type Errors = Partial<Record<FieldName, string>>;

const INITIAL: FormState = {
  model: "",
  trainUntil: "",
  testUntil: "",
  minEdgePct: "2",
  kelly: "0.25",
  forceBets: false,
  label: ""
};

const MAX_LABEL = 80;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Kelly fraction bounds; the input's min/step use the same floor. */
const KELLY_MIN = 0.05;
const KELLY_MAX = 1;

/**
 * Form values to start from, e.g. when re-running an existing run. `scope`
 * and `marketSpec` have no form controls: they are shown read-only and sent
 * as they are, so a re-run keeps a custom scope or market.
 */
export type NewBacktestPrefill = Partial<FormState> & {
  scope?: [string, string][];
  marketSpec?: string;
};

/** Same settings as `run`, optionally overridden ("re-run with force bets"). */
export function prefillFromRun(run: BacktestRunDetail, overrides: NewBacktestPrefill = {}): NewBacktestPrefill {
  return {
    model: run.model,
    trainUntil: isoDay(run.train_until),
    testUntil: isoDay(run.test_until),
    minEdgePct: String(Number((run.min_edge * 100).toFixed(4))),
    kelly: String(run.kelly_fraction),
    forceBets: run.force_bets,
    // Sent as stored: an empty scope means every competition, while an
    // omitted one would fall back to the backend's default list.
    scope: run.scope,
    marketSpec: run.market_spec,
    ...overrides
  };
}

/**
 * Queue a walk-forward backtest; on success opens the new run's page.
 * Mount it while open so every opening starts from `prefill`.
 */
export function NewBacktestDialog({
  open,
  onClose,
  prefill
}: {
  open: boolean;
  onClose: () => void;
  prefill?: NewBacktestPrefill;
}) {
  const { t, tp, fmt, locale } = useLocale();
  const router = useRouter();
  const formId = useId();
  const models = useBacktestModels();
  const create = useCreateBacktest();
  const { scope, marketSpec, ...fields } = prefill ?? {};
  const [form, setForm] = useState<FormState>(() => ({ ...INITIAL, ...fields }));
  const [errors, setErrors] = useState<Errors>({});
  const [touched, setTouched] = useState(false);

  const today = new Date().toISOString().slice(0, 10);
  const trainable = (models.data ?? []).filter((m) => m.kind !== "analytic");
  const analytic = (models.data ?? []).filter((m) => m.kind === "analytic");
  const isBaseline = analytic.some((m) => m.name === form.model);

  function validate(f: FormState): Errors {
    const e: Errors = {};
    if (!f.model) e.model = t("lab.new.error.model");
    if (!DAY.test(f.trainUntil)) e.trainUntil = t("lab.new.error.trainUntil");
    else if (f.trainUntil >= today) e.trainUntil = t("lab.new.error.trainFuture");
    if (f.testUntil) {
      if (!DAY.test(f.testUntil)) e.testUntil = t("lab.new.error.date");
      else if (DAY.test(f.trainUntil) && f.testUntil <= f.trainUntil) e.testUntil = t("lab.new.error.testBeforeTrain");
    }
    const edge = Number(f.minEdgePct);
    if (f.minEdgePct.trim() === "" || !Number.isFinite(edge) || edge < 0 || edge > 50) e.minEdgePct = t("lab.new.error.minEdge");
    const kelly = Number(f.kelly);
    if (f.kelly.trim() === "" || !Number.isFinite(kelly) || kelly < KELLY_MIN || kelly > KELLY_MAX) {
      e.kelly = t("lab.new.error.kelly", { min: fmt.num(KELLY_MIN, 2), max: fmt.int(KELLY_MAX) });
    }
    if (f.label.trim().length > MAX_LABEL) e.label = t("lab.new.error.label", { max: MAX_LABEL });
    return e;
  }

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    const next = { ...form, [key]: value };
    setForm(next);
    if (touched) setErrors(validate(next));
  }

  function close() {
    if (create.isPending) return;
    create.reset();
    onClose();
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (create.isPending) return;
    const errs = validate(form);
    setErrors(errs);
    setTouched(true);
    if (Object.keys(errs).length > 0) return;
    const body: CreateBacktestRequest = {
      model: form.model,
      train_until: `${form.trainUntil}T00:00:00Z`,
      test_until: form.testUntil ? `${form.testUntil}T00:00:00Z` : null,
      min_edge: Number((Number(form.minEdgePct) / 100).toFixed(6)),
      kelly_fraction: Number(form.kelly),
      force_bets: form.forceBets,
      label: form.label.trim() || null,
      scope,
      market_spec: marketSpec
    };
    create.mutate(body, {
      onSuccess: ({ id }) => {
        onClose();
        router.push(routes.backtest(locale, id));
      }
    });
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title={t("lab.new.title")}
      description={t("lab.new.description")}
      dismissible={!create.isPending}
      footer={
        <>
          <Button variant="ghost" onClick={close} disabled={create.isPending}>
            {t("common.cancel")}
          </Button>
          <Button variant="primary" type="submit" form={formId} loading={create.isPending}>
            {create.isPending ? t("lab.new.submitting") : t("lab.new.submit")}
          </Button>
        </>
      }
    >
      <form id={formId} onSubmit={submit} noValidate className="flex flex-col gap-4">
        {models.isError && (
          <Callout
            tone="neg"
            title={t("lab.new.modelsError")}
            action={
              <Button size="sm" onClick={() => models.refetch()} loading={models.isFetching}>
                {t("common.retry")}
              </Button>
            }
          >
            {errorMessage(models.error)}
          </Callout>
        )}

        <Field label={t("lab.new.model")} hint={t("lab.new.model.hint")} error={errors.model}>
          {(p) => (
            <Select
              {...p}
              value={form.model}
              onChange={(e) => update("model", e.target.value)}
              disabled={models.isLoading || models.isError}
              data-autofocus
            >
              <option value="" disabled>
                {models.isLoading ? t("common.loading") : t("lab.new.model.placeholder")}
              </option>
              {trainable.length > 0 && (
                <optgroup label={t("lab.new.model.trainable")}>
                  {trainable.map((m) => (
                    <option key={m.name} value={m.name}>
                      {modelLabel(m.name, t)}
                    </option>
                  ))}
                </optgroup>
              )}
              {analytic.length > 0 && (
                <optgroup label={t("lab.new.model.analytic")}>
                  {analytic.map((m) => (
                    <option key={m.name} value={m.name}>
                      {modelLabel(m.name, t)}
                    </option>
                  ))}
                </optgroup>
              )}
            </Select>
          )}
        </Field>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label={t("lab.new.trainUntil")} hint={t("lab.new.trainUntil.hint")} error={errors.trainUntil}>
            {(p) => (
              <Input
                {...p}
                type="date"
                required
                max={today}
                value={form.trainUntil}
                onChange={(e) => update("trainUntil", e.target.value)}
              />
            )}
          </Field>
          <Field label={t("lab.new.testUntil")} hint={t("lab.new.testUntil.hint")} error={errors.testUntil}>
            {(p) => (
              <Input
                {...p}
                type="date"
                min={form.trainUntil || undefined}
                value={form.testUntil}
                onChange={(e) => update("testUntil", e.target.value)}
              />
            )}
          </Field>
          <Field label={t("lab.new.minEdge")} hint={t("lab.new.minEdge.hint")} error={errors.minEdgePct}>
            {(p) => (
              <Input
                {...p}
                type="number"
                inputMode="decimal"
                min={0}
                max={50}
                step={0.5}
                value={form.minEdgePct}
                onChange={(e) => update("minEdgePct", e.target.value)}
              />
            )}
          </Field>
          <Field label={t("lab.new.kelly")} hint={t("lab.new.kelly.hint")} error={errors.kelly}>
            {(p) => (
              <Input
                {...p}
                type="number"
                inputMode="decimal"
                min={KELLY_MIN}
                max={KELLY_MAX}
                step={0.05}
                value={form.kelly}
                onChange={(e) => update("kelly", e.target.value)}
              />
            )}
          </Field>
        </div>

        <Checkbox
          label={t("lab.new.forceBets")}
          hint={t("lab.new.forceBets.hint")}
          checked={form.forceBets}
          onChange={(v) => update("forceBets", v)}
        />
        {isBaseline && !form.forceBets && (
          <Callout tone="warn" title={t("lab.new.baselineWarning.title")}>
            {t("lab.new.baselineWarning.body")}
          </Callout>
        )}

        {(scope || marketSpec) && (
          <div className="flex flex-col gap-1.5">
            <Label as="div">{t("lab.new.inherited")}</Label>
            <KeyValue
              items={[
                ...(scope
                  ? [
                      {
                        label: t("lab.detail.scope"),
                        value: scope.length
                          ? tp("lab.competitions", scope.length, { n: fmt.int(scope.length) })
                          : t("lab.detail.scopeAll")
                      }
                    ]
                  : []),
                ...(marketSpec ? [{ label: t("lab.detail.marketSpec"), value: marketSpecLabel(marketSpec, t) }] : [])
              ]}
            />
            <p className="text-meta text-text-faint">{t("lab.new.inherited.hint")}</p>
          </div>
        )}

        <Field label={t("lab.new.label")} hint={t("lab.new.label.hint")} error={errors.label}>
          {(p) => (
            <Input
              {...p}
              value={form.label}
              maxLength={MAX_LABEL + 20}
              placeholder={t("lab.new.label.placeholder")}
              onChange={(e) => update("label", e.target.value)}
            />
          )}
        </Field>

        {create.isError && (
          <Callout tone="neg" urgent title={t("lab.new.failed")}>
            {errorMessage(create.error)}
          </Callout>
        )}
      </form>
    </Dialog>
  );
}
