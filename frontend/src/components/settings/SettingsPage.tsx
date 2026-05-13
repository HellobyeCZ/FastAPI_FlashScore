"use client";
import { PageHeader } from "@/components/terminal/PageHeader";
import { Kicker } from "@/components/terminal/Kicker";
import { useSettings } from "@/hooks/useSettings";
import { useLocale } from "@/contexts/LocaleContext";
import type { Locale } from "@/lib/i18n";

export function SettingsPage() {
  const { locale, setLocale } = useLocale();
  const { settings, update } = useSettings();

  return (
    <>
      <PageHeader kicker="Settings" />
      <div className="space-y-6">
        <Field label="Locale">
          <select
            className="border border-border bg-transparent px-2 py-1 font-mono text-[12px] text-text"
            value={locale}
            onChange={(e) => setLocale(e.target.value as Locale)}
          >
            <option value="en">EN</option>
            <option value="cs">CS</option>
          </select>
        </Field>
        <Field label="Auto-refresh">
          <select
            className="border border-border bg-transparent px-2 py-1 font-mono text-[12px] text-text"
            value={settings.refreshInterval}
            onChange={(e) => update({ refreshInterval: +e.target.value })}
          >
            <option value={0}>off</option>
            <option value={30_000}>30s</option>
            <option value={60_000}>60s</option>
            <option value={300_000}>5m</option>
          </select>
        </Field>
        <Field label="CRT scanlines">
          <label className="font-mono text-[12px] text-text-dim">
            <input
              type="checkbox"
              checked={settings.scanlines}
              onChange={(e) => update({ scanlines: e.target.checked })}
            />{" "}
            enable
          </label>
        </Field>
      </div>
    </>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[200px_1fr] items-center gap-4 border-b border-border pb-3">
      <Kicker>{label}</Kicker>
      <div>{children}</div>
    </div>
  );
}
