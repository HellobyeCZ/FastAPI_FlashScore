# Frontend Terminal Redesign — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current Next.js frontend with a unified, keyboard-first "terminal brutalist" cockpit (TODAY landing page + left-rail navigation) per spec `docs/superpowers/specs/2026-05-12-frontend-terminal-redesign-design.md`.

**Architecture:** Net-new design system at `frontend/src/components/terminal/` exposing ~15 primitives that every page composes from. New token layer (CSS vars + Tailwind theme extension) drives all colors/typography. Existing React Query hooks and API routes are reused unchanged; only presentation layer is rewritten. Two new aggregation API routes (`/api/today`, `/api/db-stats`) added.

**Tech Stack:** Next.js 14 App Router · React 18 · TypeScript · Tailwind 3 · React Query 5 · visx · Playwright · IBM Plex Mono / Plex Sans Condensed via `next/font/google`.

**Spec coverage note:** Phases 1–9 cover everything in the spec. Settings page (§Q-7), CRT scanline toggle, picks deep-dive reskin, and Playwright e2e updates are explicit tasks in Phases 8–9.

**Working directory:** All paths are relative to the repo root unless noted. The frontend lives in `frontend/`.

---

## Phase 1 — Design system foundation

### Task 1.1: Add IBM Plex fonts via next/font

**Files:**
- Modify: `frontend/src/app/layout.tsx`
- Modify: `frontend/tailwind.config.ts`

- [ ] **Step 1: Read the current layout.tsx**

Run: `cat frontend/src/app/layout.tsx`

You will use the current structure as the base and add font loading.

- [ ] **Step 2: Replace `frontend/src/app/layout.tsx` with the new font setup**

Write the file with this exact content (preserve existing providers — read the file first and only edit the parts shown below if it differs):

```tsx
import type { Metadata } from "next";
import { IBM_Plex_Mono, IBM_Plex_Sans_Condensed } from "next/font/google";
import { QueryProvider } from "@/contexts/QueryProvider";
import { LocaleProvider } from "@/contexts/LocaleContext";
import "@/styles/tokens.css";
import "./globals.css";

const plexMono = IBM_Plex_Mono({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600"],
  variable: "--font-mono",
  display: "swap"
});

const plexSansCondensed = IBM_Plex_Sans_Condensed({
  subsets: ["latin", "latin-ext"],
  weight: ["400", "500", "600"],
  variable: "--font-sans",
  display: "swap"
});

export const metadata: Metadata = {
  title: "Flashscore/Terminal",
  description: "Terminal cockpit for odds, picks, and model analytics."
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${plexMono.variable} ${plexSansCondensed.variable}`}>
      <body>
        <LocaleProvider>
          <QueryProvider>{children}</QueryProvider>
        </LocaleProvider>
      </body>
    </html>
  );
}
```

If the current file has different provider order or wrappers, preserve them — only swap the font imports and the `html` className.

- [ ] **Step 3: Update Tailwind font families**

Replace the `fontFamily` block in `frontend/tailwind.config.ts`:

```ts
fontFamily: {
  mono: ["var(--font-mono)", "ui-monospace", "monospace"],
  sans: ["var(--font-sans)", "system-ui", "sans-serif"]
}
```

- [ ] **Step 4: Verify build**

Run: `cd frontend && npm run lint`
Expected: no errors related to layout or tailwind config.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/layout.tsx frontend/tailwind.config.ts
git commit -m "feat(frontend): load IBM Plex Mono + Sans Condensed via next/font"
```

---

### Task 1.2: Create token stylesheet

**Files:**
- Create: `frontend/src/styles/tokens.css`

- [ ] **Step 1: Write tokens.css**

```css
:root {
  /* color */
  --bg: #0a0a0a;
  --surface: #111111;
  --surface-2: #161616;
  --border: #1f1f1f;
  --border-hot: #2a2a2a;
  --text: #e8e8e8;
  --text-dim: #7a7a7a;
  --text-faint: #4a4a4a;
  --accent: #c8f000;
  --pos: #c8f000;
  --neg: #ff5577;
  --warn: #f5a623;

  /* spacing */
  --sp-1: 4px;
  --sp-2: 8px;
  --sp-3: 12px;
  --sp-4: 16px;
  --sp-5: 20px;
  --sp-6: 24px;
  --sp-7: 32px;
  --sp-8: 48px;

  /* type scale */
  --fs-10: 10px;
  --fs-11: 11px;
  --fs-12: 12px;
  --fs-13: 13px;
  --fs-16: 16px;
  --fs-20: 20px;
  --fs-28: 28px;
  --fs-40: 40px;

  /* tracking */
  --track-wide: 0.18em;
}

html, body {
  background: var(--bg);
  color: var(--text);
  font-family: var(--font-mono), ui-monospace, monospace;
  font-size: var(--fs-13);
  line-height: 1.5;
  margin: 0;
  padding: 0;
}

body {
  background-image:
    linear-gradient(rgba(200, 240, 0, 0.025) 1px, transparent 1px),
    linear-gradient(90deg, rgba(200, 240, 0, 0.025) 1px, transparent 1px);
  background-size: 14px 14px;
  background-attachment: fixed;
  min-height: 100vh;
}

*, *::before, *::after {
  box-sizing: border-box;
}

button {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text);
  font: inherit;
  padding: var(--sp-2) var(--sp-3);
  cursor: pointer;
  border-radius: 0;
}

button:hover { border-color: var(--border-hot); }
button:focus-visible { outline: 1px solid var(--accent); outline-offset: 0; }

a { color: inherit; text-decoration: none; }

input, select, textarea {
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  font: inherit;
  padding: var(--sp-2) var(--sp-3);
  border-radius: 0;
}
input:focus, select:focus, textarea:focus { outline: 1px solid var(--accent); border-color: var(--accent); }

::selection { background: var(--accent); color: var(--bg); }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after { transition: none !important; animation: none !important; }
}
```

- [ ] **Step 2: Update Tailwind colors to consume tokens**

Replace the `colors` block in `frontend/tailwind.config.ts`:

```ts
colors: {
  bg: "var(--bg)",
  surface: "var(--surface)",
  "surface-2": "var(--surface-2)",
  border: "var(--border)",
  "border-hot": "var(--border-hot)",
  text: "var(--text)",
  "text-dim": "var(--text-dim)",
  "text-faint": "var(--text-faint)",
  accent: "var(--accent)",
  pos: "var(--pos)",
  neg: "var(--neg)",
  warn: "var(--warn)"
}
```

- [ ] **Step 3: Strip the old `brand.*` palette from any existing globals.css**

Read `frontend/src/app/globals.css`. Remove any `--color-brand-*` definitions and `body { background: ... }` rules that conflict. Keep any reset that doesn't conflict (e.g., custom scrollbar styles if present).

- [ ] **Step 4: Lint**

Run: `cd frontend && npm run lint`
Expected: no errors. If errors reference removed CSS vars used in existing components, leave those untouched for now — Phase 4+ rewrites those components.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/styles/tokens.css frontend/tailwind.config.ts frontend/src/app/globals.css
git commit -m "feat(frontend): add terminal token palette + body grid texture"
```

---

### Task 1.3: Glyph component

**Files:**
- Create: `frontend/src/components/terminal/Glyph.tsx`
- Create: `frontend/tests/unit/Glyph.test.tsx` — *skip if no unit test runner; component is trivial and covered by visual tests*

- [ ] **Step 1: Write Glyph.tsx**

```tsx
type GlyphKind =
  | "section"   // ▌
  | "item"      // ▸
  | "null"      // ─
  | "up"        // ▲
  | "down"      // ▼
  | "led"       // ●
  | "branch"    // └
  | "full"      // █
  | "empty";    // ░

const MAP: Record<GlyphKind, string> = {
  section: "▌",
  item: "▸",
  null: "─",
  up: "▲",
  down: "▼",
  led: "●",
  branch: "└",
  full: "█",
  empty: "░"
};

export function Glyph({ kind, className }: { kind: GlyphKind; className?: string }) {
  return <span aria-hidden className={className}>{MAP[kind]}</span>;
}

export type { GlyphKind };
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/terminal/Glyph.tsx
git commit -m "feat(frontend): add Glyph primitive"
```

---

### Task 1.4: Kicker component

**Files:**
- Create: `frontend/src/components/terminal/Kicker.tsx`

- [ ] **Step 1: Write Kicker.tsx**

```tsx
import { clsx } from "clsx";

export function Kicker({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <span
      className={clsx(
        "font-sans uppercase text-text-dim",
        "text-[10px]",
        className
      )}
      style={{ letterSpacing: "var(--track-wide)" }}
    >
      {children}
    </span>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/terminal/Kicker.tsx
git commit -m "feat(frontend): add Kicker primitive"
```

---

### Task 1.5: KeyHint component

**Files:**
- Create: `frontend/src/components/terminal/KeyHint.tsx`

- [ ] **Step 1: Write KeyHint.tsx**

```tsx
import { clsx } from "clsx";

export function KeyHint({ keys, className }: { keys: string | string[]; className?: string }) {
  const list = Array.isArray(keys) ? keys : keys.split("+");
  return (
    <span className={clsx("inline-flex items-center gap-[2px] font-mono text-[10px]", className)}>
      <span className="text-text-faint">[</span>
      {list.map((k, i) => (
        <span key={i} className="text-text-dim">
          {i > 0 && <span className="text-text-faint mx-[2px]">+</span>}
          {k.toUpperCase()}
        </span>
      ))}
      <span className="text-text-faint">]</span>
    </span>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/terminal/KeyHint.tsx
git commit -m "feat(frontend): add KeyHint primitive"
```

---

### Task 1.6: StatusToken component

**Files:**
- Create: `frontend/src/components/terminal/StatusToken.tsx`

- [ ] **Step 1: Write StatusToken.tsx**

```tsx
import { clsx } from "clsx";

type StatusKind =
  | "OPEN" | "PEND" | "WON" | "LOST" | "VOID"
  | "LIVE" | "FT" | "SCHED"
  | "RUN" | "OK" | "ERR";

const COLOR: Record<StatusKind, string> = {
  OPEN: "border-accent text-accent",
  PEND: "border-warn text-warn",
  WON: "border-pos text-pos",
  LOST: "border-neg text-neg",
  VOID: "border-text-faint text-text-dim",
  LIVE: "border-accent text-accent",
  FT: "border-text-faint text-text-dim",
  SCHED: "border-text-dim text-text-dim",
  RUN: "border-warn text-warn",
  OK: "border-pos text-pos",
  ERR: "border-neg text-neg"
};

export function StatusToken({ kind, className }: { kind: StatusKind; className?: string }) {
  return (
    <span
      className={clsx(
        "inline-block border-l-2 px-2 py-[1px] font-mono text-[10px] uppercase",
        COLOR[kind],
        className
      )}
    >
      {kind}
    </span>
  );
}

export type { StatusKind };
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/terminal/StatusToken.tsx
git commit -m "feat(frontend): add StatusToken primitive"
```

---

### Task 1.7: Chip component

**Files:**
- Create: `frontend/src/components/terminal/Chip.tsx`

- [ ] **Step 1: Write Chip.tsx**

```tsx
import { clsx } from "clsx";

export function Chip({
  children,
  selected,
  onClick,
  className
}: {
  children: React.ReactNode;
  selected?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        "inline-flex items-center gap-1 border px-2 py-[2px] font-mono text-[11px] uppercase",
        selected
          ? "border-accent text-accent"
          : "border-border text-text-dim hover:border-border-hot hover:text-text",
        className
      )}
      aria-pressed={selected}
    >
      {children}
    </button>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/terminal/Chip.tsx
git commit -m "feat(frontend): add Chip primitive"
```

---

### Task 1.8: AsciiProgress component

**Files:**
- Create: `frontend/src/components/terminal/AsciiProgress.tsx`

- [ ] **Step 1: Write AsciiProgress.tsx**

```tsx
import { clsx } from "clsx";

export function AsciiProgress({
  value,
  width = 10,
  className
}: {
  value: number; // 0..1
  width?: number;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(1, value));
  const filled = Math.round(clamped * width);
  const empty = width - filled;
  const pct = Math.round(clamped * 100);
  return (
    <span className={clsx("font-mono text-[11px]", className)}>
      <span className="text-accent">{"█".repeat(filled)}</span>
      <span className="text-text-faint">{"░".repeat(empty)}</span>
      <span className="ml-2 text-text-dim">{pct}%</span>
    </span>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/terminal/AsciiProgress.tsx
git commit -m "feat(frontend): add AsciiProgress primitive"
```

---

## Phase 2 — Shell chrome

### Task 2.1: useKeybindings hook

**Files:**
- Create: `frontend/src/hooks/useKeybindings.ts`

- [ ] **Step 1: Write useKeybindings.ts**

```ts
"use client";
import { useEffect, useRef } from "react";

export type Keybinding = {
  /** Either a single key ("/", "?", "Escape") or a sequence ("g t") */
  combo: string;
  description: string;
  handler: (e: KeyboardEvent) => void;
  /** Page-scoped maps merge into the global map; identical combos in a later registration override earlier ones. */
  scope?: string;
};

const registry = new Map<string, Keybinding>();
const listeners = new Set<() => void>();
let bufferedPrefix: string | null = null;
let bufferedAt = 0;

function notify() { listeners.forEach((l) => l()); }

function comboMatches(combo: string, e: KeyboardEvent, now: number): boolean {
  const parts = combo.toLowerCase().split(" ");
  if (parts.length === 1) {
    return e.key.toLowerCase() === parts[0];
  }
  // sequence
  const [prefix, second] = parts;
  if (bufferedPrefix === prefix && now - bufferedAt < 1200 && e.key.toLowerCase() === second) {
    bufferedPrefix = null;
    return true;
  }
  if (e.key.toLowerCase() === prefix && bufferedPrefix !== prefix) {
    bufferedPrefix = prefix;
    bufferedAt = now;
  }
  return false;
}

function rootHandler(e: KeyboardEvent) {
  const target = e.target as HTMLElement | null;
  if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) {
    if (e.key !== "Escape") return;
  }
  const now = Date.now();
  for (const b of registry.values()) {
    if (comboMatches(b.combo, e, now)) {
      e.preventDefault();
      b.handler(e);
      return;
    }
  }
}

let installed = false;
function install() {
  if (installed) return;
  window.addEventListener("keydown", rootHandler);
  installed = true;
}

export function useKeybindings(bindings: Keybinding[]) {
  const idsRef = useRef<string[]>([]);
  useEffect(() => {
    install();
    const ids: string[] = [];
    for (const b of bindings) {
      const id = `${b.scope ?? "global"}::${b.combo}`;
      registry.set(id, b);
      ids.push(id);
    }
    idsRef.current = ids;
    notify();
    return () => {
      ids.forEach((id) => registry.delete(id));
      notify();
    };
  }, [bindings]);
}

export function useAllKeybindings(): Keybinding[] {
  const [, force] = (require("react") as typeof import("react")).useState({});
  (require("react") as typeof import("react")).useEffect(() => {
    const l = () => force({});
    listeners.add(l);
    return () => { listeners.delete(l); };
  }, []);
  return Array.from(registry.values());
}
```

Note: `useAllKeybindings` is used by the `?` overlay sheet later. The dynamic `require` is intentional to avoid duplicate React-hooks imports across the module; if your bundler dislikes this, replace the body with normal `import { useState, useEffect } from "react"` at the top of the file and the same logic.

- [ ] **Step 2: Lint**

Run: `cd frontend && npm run lint`
Expected: passes (the lint config may warn about `require`; if it errors, refactor to top-level imports as noted).

- [ ] **Step 3: Commit**

```bash
git add frontend/src/hooks/useKeybindings.ts
git commit -m "feat(frontend): add useKeybindings hook with sequence support"
```

---

### Task 2.2: TopBar component

**Files:**
- Create: `frontend/src/components/terminal/TopBar.tsx`

- [ ] **Step 1: Write TopBar.tsx**

```tsx
"use client";
import { Glyph } from "./Glyph";
import { useLocale } from "@/contexts/LocaleContext";
import { useDbStats } from "@/hooks/useDbStats";
import { clsx } from "clsx";

export function TopBar() {
  const { locale, setLocale } = useLocale();
  const stats = useDbStats();
  const ledColor =
    stats.status === "success" ? "text-accent" :
    stats.status === "error"   ? "text-neg"    :
                                 "text-text-faint";

  return (
    <header className="fixed top-0 left-0 right-0 z-30 flex h-8 items-center justify-between border-b border-border bg-bg px-4 font-sans">
      <div className="flex items-center gap-2">
        <Glyph kind="section" className="text-accent" />
        <span
          className="text-[11px] uppercase text-text"
          style={{ letterSpacing: "var(--track-wide)" }}
        >
          Flashscore/Terminal
        </span>
        <span className="text-[10px] text-text-faint">· v0.1</span>
      </div>
      <div className="flex items-center gap-4">
        <div className="flex items-center gap-1 font-mono text-[10px]">
          <button
            onClick={() => setLocale("en")}
            className={clsx("border-none px-1 py-0", locale === "en" ? "text-accent" : "text-text-dim")}
          >
            EN
          </button>
          <span className="text-text-faint">|</span>
          <button
            onClick={() => setLocale("cs")}
            className={clsx("border-none px-1 py-0", locale === "cs" ? "text-accent" : "text-text-dim")}
          >
            CS
          </button>
        </div>
        <Glyph kind="led" className={ledColor} />
      </div>
    </header>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/terminal/TopBar.tsx
git commit -m "feat(frontend): add TopBar with locale toggle + session LED"
```

---

### Task 2.3: useDbStats hook + API route

**Files:**
- Create: `frontend/src/app/api/db-stats/route.ts`
- Create: `frontend/src/hooks/useDbStats.ts`

- [ ] **Step 1: Inspect existing Prisma usage**

Run: `grep -rn "@prisma/client\|prisma\." frontend/src/app/api | head -10`

You will follow the same import pattern used by an existing route. If no existing route uses Prisma, use:

```ts
import { PrismaClient } from "@prisma/client";
const prisma = (globalThis as any).__prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") (globalThis as any).__prisma = prisma;
```

- [ ] **Step 2: Write `frontend/src/app/api/db-stats/route.ts`**

```ts
import { NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";

const prisma = (globalThis as any).__prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") (globalThis as any).__prisma = prisma;

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [odds, stats] = await Promise.all([
      prisma.oddsSnapshot.count(),
      prisma.matchStatsSnapshot.count()
    ]);
    return NextResponse.json({ ok: true, rows: odds + stats, odds, stats });
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 });
  }
}
```

Note: the Prisma model names (`oddsSnapshot`, `matchStatsSnapshot`) must match what's in `frontend/prisma/schema.prisma`. Run `grep -n "model " frontend/prisma/schema.prisma` and adjust property names if they differ (camelCase of the table name).

- [ ] **Step 3: Write `frontend/src/hooks/useDbStats.ts`**

```ts
"use client";
import { useQuery } from "@tanstack/react-query";

type DbStats = { ok: true; rows: number; odds: number; stats: number } | { ok: false; error: string };

export function useDbStats() {
  return useQuery<DbStats>({
    queryKey: ["db-stats"],
    queryFn: async () => {
      const r = await fetch("/api/db-stats");
      if (!r.ok) throw new Error(`db-stats ${r.status}`);
      return r.json();
    },
    staleTime: 60_000,
    refetchOnWindowFocus: false
  });
}
```

- [ ] **Step 4: Verify the route**

Run: `cd frontend && npm run dev` (in background), then `curl -s http://localhost:3000/api/db-stats | head -c 200`
Expected: a JSON object with `ok: true` and a `rows` number.
Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/api/db-stats/route.ts frontend/src/hooks/useDbStats.ts
git commit -m "feat(frontend): add db-stats API route + hook"
```

---

### Task 2.4: StatusBar component

**Files:**
- Create: `frontend/src/components/terminal/StatusBar.tsx`

- [ ] **Step 1: Write StatusBar.tsx**

```tsx
"use client";
import { useEffect, useState } from "react";
import { Glyph } from "./Glyph";
import { useDbStats } from "@/hooks/useDbStats";
import { useLocale } from "@/contexts/LocaleContext";

const BUILD_SHA = process.env.NEXT_PUBLIC_BUILD_SHA ?? "dev";

export function StatusBar({ pageHints }: { pageHints?: string }) {
  const { locale } = useLocale();
  const stats = useDbStats();
  const [now, setNow] = useState<Date>(() => new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const ledColor =
    stats.status === "success" ? "text-accent" :
    stats.status === "error"   ? "text-neg"    :
                                 "text-text-faint";
  const ledLabel =
    stats.status === "success" ? "ok" :
    stats.status === "error"   ? "err" :
                                 "—";

  const clock = new Intl.DateTimeFormat(locale, {
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
  }).format(now);

  const rows = stats.data && "rows" in stats.data ? stats.data.rows.toLocaleString(locale) : "—";

  return (
    <footer className="fixed bottom-0 left-0 right-0 z-30 flex h-6 items-center justify-between border-t border-border bg-bg px-4 font-mono text-[10px] text-text-dim">
      <div className="flex items-center gap-3">
        <span className="inline-flex items-center gap-1">
          <span className="text-text-faint">[</span>
          <Glyph kind="led" className={ledColor} />
          <span>{ledLabel}</span>
          <span className="text-text-faint">]</span>
        </span>
        {pageHints && <span className="hidden md:inline">KEY: {pageHints}</span>}
      </div>
      <div className="flex items-center gap-4">
        <span>{clock}</span>
        <span className="hidden sm:inline">db: {rows} rows</span>
        <span className="hidden sm:inline">build: {BUILD_SHA}</span>
      </div>
    </footer>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/terminal/StatusBar.tsx
git commit -m "feat(frontend): add StatusBar with clock, db rows, build sha"
```

---

### Task 2.5: Rail components

**Files:**
- Create: `frontend/src/components/terminal/Rail.tsx`

- [ ] **Step 1: Write Rail.tsx**

```tsx
"use client";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { clsx } from "clsx";
import { Glyph } from "./Glyph";
import { useLocale } from "@/contexts/LocaleContext";

type Item = {
  href: string;
  label: string;
  matchPrefix?: string;
  indent?: number;
  branch?: boolean;
};

export function Rail() {
  const pathname = usePathname() ?? "/";
  const { locale } = useLocale();
  const p = (s: string) => `/${locale}${s}`;

  const items: Item[] = [
    { href: p("/today"), label: "Today" },
    { href: p("/odds"), label: "Odds" },
    { href: p("/matches"), label: "Matches", matchPrefix: p("/matches") },
    { href: p("/picks/health"), label: "Picks", matchPrefix: p("/picks") },
    { href: p("/picks/health"), label: "Health", indent: 1, branch: true },
    { href: p("/picks/models"), label: "Models", indent: 1, branch: true, matchPrefix: p("/picks/models") },
    { href: p("/picks/explore"), label: "Explore", indent: 1, branch: true },
    { href: p("/jobs"), label: "Jobs" },
    { href: p("/settings"), label: "Settings" }
  ];

  return (
    <nav
      aria-label="Primary"
      className="fixed left-0 top-8 bottom-6 z-20 hidden w-[180px] flex-col border-r border-border bg-bg px-3 py-4 md:flex"
    >
      <div
        className="mb-3 flex items-center gap-1 text-[10px] uppercase text-text-faint"
        style={{ letterSpacing: "var(--track-wide)" }}
      >
        <Glyph kind="section" /> Navigation
      </div>
      <ul className="flex flex-col gap-[2px]">
        {items.map((it, i) => {
          const active = it.matchPrefix
            ? pathname.startsWith(it.matchPrefix)
            : pathname === it.href;
          if (it.label === "Settings") {
            // separator before settings
            return (
              <li key={`sep-${i}`} className="contents">
                <li className="my-2 border-t border-border" />
                <RailRow item={it} active={active} />
              </li>
            );
          }
          return <RailRow key={it.href + i} item={it} active={active} />;
        })}
      </ul>
    </nav>
  );
}

function RailRow({ item, active }: { item: Item; active: boolean }) {
  return (
    <li className="relative">
      {active && <span className="absolute left-[-12px] top-0 bottom-0 w-[2px] bg-accent" aria-hidden />}
      <Link
        href={item.href as any}
        className={clsx(
          "flex items-center gap-1 py-[2px] font-sans text-[10px] uppercase",
          active ? "text-accent" : "text-text-dim hover:text-text"
        )}
        style={{ letterSpacing: "var(--track-wide)", paddingLeft: item.indent ? `${item.indent * 12}px` : 0 }}
      >
        {item.branch && <Glyph kind="branch" className="text-text-faint" />}
        {item.label}
      </Link>
    </li>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/terminal/Rail.tsx
git commit -m "feat(frontend): add left-rail nav with tree-style picks subroutes"
```

---

### Task 2.6: Shell component

**Files:**
- Create: `frontend/src/components/terminal/Shell.tsx`

- [ ] **Step 1: Write Shell.tsx**

```tsx
"use client";
import { TopBar } from "./TopBar";
import { Rail } from "./Rail";
import { StatusBar } from "./StatusBar";

export function Shell({
  children,
  pageHints
}: {
  children: React.ReactNode;
  pageHints?: string;
}) {
  return (
    <>
      <TopBar />
      <Rail />
      <main className="pt-8 pb-6 md:pl-[180px]">
        <div className="px-6 py-5">{children}</div>
      </main>
      <StatusBar pageHints={pageHints} />
    </>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/terminal/Shell.tsx
git commit -m "feat(frontend): add Shell wrapper combining TopBar/Rail/StatusBar"
```

---

### Task 2.7: Global keybindings + ? sheet

**Files:**
- Create: `frontend/src/components/terminal/KeyboardSheet.tsx`
- Create: `frontend/src/components/terminal/GlobalKeybindings.tsx`

- [ ] **Step 1: Write KeyboardSheet.tsx**

```tsx
"use client";
import { useEffect, useState } from "react";
import { useAllKeybindings } from "@/hooks/useKeybindings";
import { KeyHint } from "./KeyHint";

export function KeyboardSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const bindings = useAllKeybindings();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-bg/90 pt-20">
      <div className="w-full max-w-3xl border border-border bg-bg p-6">
        <div className="mb-4 flex items-baseline justify-between">
          <h2 className="font-sans text-[11px] uppercase text-accent" style={{ letterSpacing: "var(--track-wide)" }}>
            ▌ Keyboard
          </h2>
          <span className="font-mono text-[10px] text-text-dim">esc to close</span>
        </div>
        <ul className="grid grid-cols-2 gap-x-8 gap-y-1 font-mono text-[12px]">
          {bindings.map((b) => (
            <li key={b.combo} className="flex items-center justify-between border-b border-border py-1">
              <span className="text-text-dim">{b.description}</span>
              <KeyHint keys={b.combo.split(" ")} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write GlobalKeybindings.tsx**

```tsx
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { useKeybindings } from "@/hooks/useKeybindings";
import { useLocale } from "@/contexts/LocaleContext";
import { KeyboardSheet } from "./KeyboardSheet";

export function GlobalKeybindings() {
  const router = useRouter();
  const { locale } = useLocale();
  const [sheet, setSheet] = useState(false);
  const p = (s: string) => `/${locale}${s}`;

  useKeybindings([
    { combo: "g t", description: "Go: Today",    handler: () => router.push(p("/today") as any) },
    { combo: "g o", description: "Go: Odds",     handler: () => router.push(p("/odds") as any) },
    { combo: "g m", description: "Go: Matches",  handler: () => router.push(p("/matches") as any) },
    { combo: "g p", description: "Go: Picks",    handler: () => router.push(p("/picks/health") as any) },
    { combo: "g j", description: "Go: Jobs",     handler: () => router.push(p("/jobs") as any) },
    { combo: "g s", description: "Go: Settings", handler: () => router.push(p("/settings") as any) },
    { combo: "/",   description: "Focus search", handler: () => {
        const el = document.querySelector<HTMLInputElement>("[data-search-input]");
        el?.focus();
    }},
    { combo: "?",   description: "Show keyboard", handler: () => setSheet(true) },
    { combo: "Escape", description: "Close overlay", handler: () => setSheet(false) }
  ]);

  return <KeyboardSheet open={sheet} onClose={() => setSheet(false)} />;
}
```

- [ ] **Step 3: Wire GlobalKeybindings into Shell**

Edit `frontend/src/components/terminal/Shell.tsx`. Add the import and render it once inside the main body:

```tsx
import { GlobalKeybindings } from "./GlobalKeybindings";
// ...
<main className="pt-8 pb-6 md:pl-[180px]">
  <GlobalKeybindings />
  <div className="px-6 py-5">{children}</div>
</main>
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/terminal/KeyboardSheet.tsx frontend/src/components/terminal/GlobalKeybindings.tsx frontend/src/components/terminal/Shell.tsx
git commit -m "feat(frontend): wire global keybindings + ? overlay sheet"
```

---

### Task 2.8: Mobile rail drawer

**Files:**
- Modify: `frontend/src/components/terminal/Rail.tsx`
- Modify: `frontend/src/components/terminal/TopBar.tsx`

- [ ] **Step 1: Add `open`/`onClose` props to Rail**

Modify Rail so it can render in two modes:
- **Desktop (`md:flex`)**: fixed left rail as today.
- **Mobile (drawer)**: when `open` is true, render as `fixed inset-0 z-40 bg-bg/95 flex flex-col p-6`; close button in top-right; same item list.

Add the props:

```tsx
export function Rail({ open = false, onClose }: { open?: boolean; onClose?: () => void } = {}) {
  // ...existing logic
  return (
    <>
      {/* desktop */}
      <nav aria-label="Primary" className="fixed left-0 top-8 bottom-6 z-20 hidden w-[180px] flex-col border-r border-border bg-bg px-3 py-4 md:flex">
        {/* ...existing content */}
      </nav>
      {/* mobile drawer */}
      {open && (
        <nav aria-label="Primary (mobile)" className="fixed inset-0 z-40 flex flex-col bg-bg/95 px-6 pt-10 md:hidden">
          <button onClick={onClose} className="absolute right-4 top-3 border-none text-text-dim">esc</button>
          {/* duplicate items list, no left-bar accent positioning needed */}
        </nav>
      )}
    </>
  );
}
```

Extract the items array + RailRow rendering into a small helper so both branches share it.

- [ ] **Step 2: Add toggle to TopBar (mobile only)**

In TopBar, accept `onMenu` and `menuOpen`:

```tsx
export function TopBar({ onMenu, menuOpen }: { onMenu?: () => void; menuOpen?: boolean } = {}) {
  // ...
  // at the start of the left cluster:
  <button onClick={onMenu} className="border-none px-2 text-text-dim md:hidden" aria-label="Toggle menu">≡</button>
}
```

- [ ] **Step 3: Wire state in Shell**

```tsx
"use client";
import { useState } from "react";
// ...
export function Shell({ children, pageHints }: { children: React.ReactNode; pageHints?: string }) {
  const [menu, setMenu] = useState(false);
  return (
    <>
      <TopBar onMenu={() => setMenu((v) => !v)} menuOpen={menu} />
      <Rail open={menu} onClose={() => setMenu(false)} />
      {/* ... */}
    </>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/terminal/Rail.tsx frontend/src/components/terminal/TopBar.tsx frontend/src/components/terminal/Shell.tsx
git commit -m "feat(frontend): add mobile rail drawer"
```

---

## Phase 3 — Data primitives

### Task 3.1: PageHeader

**Files:**
- Create: `frontend/src/components/terminal/PageHeader.tsx`

- [ ] **Step 1: Write PageHeader.tsx**

```tsx
import { Kicker } from "./Kicker";
import { Glyph } from "./Glyph";

export function PageHeader({
  kicker,
  actions
}: {
  kicker: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="mb-5 flex h-10 items-center justify-between border-b border-border">
      <div className="flex items-center gap-2">
        <Glyph kind="section" className="text-accent" />
        <Kicker>{kicker}</Kicker>
      </div>
      {actions && <div className="flex items-center gap-3">{actions}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/terminal/PageHeader.tsx
git commit -m "feat(frontend): add PageHeader band"
```

---

### Task 3.2: DataTable

**Files:**
- Create: `frontend/src/components/terminal/DataTable.tsx`

- [ ] **Step 1: Write DataTable.tsx**

```tsx
"use client";
import { useState, useMemo } from "react";
import { clsx } from "clsx";

export type Column<T> = {
  key: string;
  header: string;
  render: (row: T) => React.ReactNode;
  sort?: (a: T, b: T) => number;
  align?: "left" | "right";
  width?: string;
};

export function DataTable<T>({
  columns,
  rows,
  onRowClick,
  empty,
  className
}: {
  columns: Column<T>[];
  rows: T[];
  onRowClick?: (row: T) => void;
  empty?: React.ReactNode;
  className?: string;
}) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<"asc" | "desc">("asc");

  const sorted = useMemo(() => {
    if (!sortKey) return rows;
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.sort) return rows;
    const copy = [...rows].sort(col.sort);
    if (sortDir === "desc") copy.reverse();
    return copy;
  }, [rows, sortKey, sortDir, columns]);

  function toggleSort(key: string) {
    if (sortKey !== key) { setSortKey(key); setSortDir("asc"); return; }
    if (sortDir === "asc") { setSortDir("desc"); return; }
    setSortKey(null);
  }

  return (
    <table className={clsx("w-full border-collapse font-mono text-[12px]", className)}>
      <thead>
        <tr className="border-b border-border">
          {columns.map((c) => (
            <th
              key={c.key}
              scope="col"
              onClick={c.sort ? () => toggleSort(c.key) : undefined}
              className={clsx(
                "px-2 py-2 font-sans text-[10px] uppercase text-text-dim",
                c.align === "right" && "text-right",
                c.sort && "cursor-pointer hover:text-text"
              )}
              style={{ letterSpacing: "var(--track-wide)", width: c.width }}
            >
              {c.header}
              {sortKey === c.key && <span className="ml-1 text-accent">{sortDir === "asc" ? "↑" : "↓"}</span>}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted.length === 0 && empty && (
          <tr><td colSpan={columns.length} className="px-2 py-6 text-center text-text-dim">{empty}</td></tr>
        )}
        {sorted.map((row, i) => (
          <tr
            key={i}
            onClick={onRowClick ? () => onRowClick(row) : undefined}
            className={clsx(
              "border-b border-border/60",
              onRowClick && "cursor-pointer hover:bg-surface"
            )}
          >
            {columns.map((c) => (
              <td
                key={c.key}
                className={clsx("px-2 py-1 align-middle", c.align === "right" && "text-right tabular-nums")}
              >
                {c.render(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/terminal/DataTable.tsx
git commit -m "feat(frontend): add DataTable primitive with sticky header + sort"
```

---

### Task 3.3: Stat (hero strip cell)

**Files:**
- Create: `frontend/src/components/terminal/Stat.tsx`

- [ ] **Step 1: Write Stat.tsx**

```tsx
import { Kicker } from "./Kicker";
import { clsx } from "clsx";

export function Stat({
  label,
  value,
  delta,
  deltaTone,
  children
}: {
  label: string;
  value: React.ReactNode;
  delta?: React.ReactNode;
  deltaTone?: "pos" | "neg" | "neutral";
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 px-6 py-4">
      <Kicker>{label}</Kicker>
      <div className="font-mono text-[32px] leading-none tabular-nums text-text">{value}</div>
      {delta && (
        <div className={clsx(
          "font-mono text-[12px] tabular-nums",
          deltaTone === "pos" && "text-pos",
          deltaTone === "neg" && "text-neg",
          (!deltaTone || deltaTone === "neutral") && "text-text-dim"
        )}>
          {delta}
        </div>
      )}
      {children && <div className="mt-1 border-t border-border pt-2">{children}</div>}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/terminal/Stat.tsx
git commit -m "feat(frontend): add Stat hero-strip cell"
```

---

### Task 3.4: Sparkline + BucketBars

**Files:**
- Create: `frontend/src/components/terminal/Sparkline.tsx`
- Create: `frontend/src/components/terminal/BucketBars.tsx`

- [ ] **Step 1: Write Sparkline.tsx**

```tsx
export function Sparkline({
  data,
  width = 200,
  height = 32
}: { data: number[]; width?: number; height?: number }) {
  if (data.length === 0) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const stepX = width / Math.max(1, data.length - 1);
  const points = data
    .map((v, i) => `${(i * stepX).toFixed(1)},${(height - ((v - min) / range) * height).toFixed(1)}`)
    .join(" ");
  return (
    <svg width={width} height={height} role="img" aria-label="sparkline">
      <polyline points={points} fill="none" stroke="var(--accent)" strokeWidth="1" shapeRendering="crispEdges" />
    </svg>
  );
}
```

- [ ] **Step 2: Write BucketBars.tsx**

```tsx
export type Bucket = { label: string; value: number; tone?: "pos" | "neg" | "neutral" | "warn" };

export function BucketBars({ buckets, height = 28 }: { buckets: Bucket[]; height?: number }) {
  const max = Math.max(1, ...buckets.map((b) => b.value));
  return (
    <div className="flex items-end gap-[2px]" style={{ height }}>
      {buckets.map((b) => {
        const h = (b.value / max) * height;
        const color =
          b.tone === "pos" ? "var(--pos)" :
          b.tone === "neg" ? "var(--neg)" :
          b.tone === "warn" ? "var(--warn)" :
                              "var(--text-dim)";
        return (
          <div key={b.label} className="flex flex-col items-center gap-1">
            <div style={{ height: h, width: 8, background: color }} />
            <span className="font-mono text-[9px] text-text-faint">{b.label}</span>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/terminal/Sparkline.tsx frontend/src/components/terminal/BucketBars.tsx
git commit -m "feat(frontend): add Sparkline + BucketBars micro-vis primitives"
```

---

### Task 3.5: Facets primitive

**Files:**
- Create: `frontend/src/components/terminal/Facets.tsx`

- [ ] **Step 1: Write Facets.tsx**

```tsx
"use client";
import { Kicker } from "./Kicker";
import { clsx } from "clsx";

export type Facet = {
  key: string;
  label: string;
  options: { value: string; label: string; count?: number }[];
  selected: string[];
  onChange: (next: string[]) => void;
};

export function Facets({ facets }: { facets: Facet[] }) {
  return (
    <aside className="w-[200px] shrink-0 border-r border-border pr-4">
      {facets.map((f) => (
        <div key={f.key} className="mb-5">
          <Kicker>{f.label}</Kicker>
          <ul className="mt-2 flex flex-col gap-[2px]">
            {f.options.map((o) => {
              const checked = f.selected.includes(o.value);
              return (
                <li key={o.value}>
                  <button
                    onClick={() => f.onChange(
                      checked ? f.selected.filter((v) => v !== o.value) : [...f.selected, o.value]
                    )}
                    className={clsx(
                      "flex w-full items-baseline justify-between border-none px-0 py-0 font-mono text-[11px]",
                      checked ? "text-accent" : "text-text-dim hover:text-text"
                    )}
                  >
                    <span>
                      <span className="mr-2 text-text-faint">{checked ? "[x]" : "[ ]"}</span>
                      {o.label}
                    </span>
                    {o.count !== undefined && <span className="text-text-faint">{o.count}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </aside>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/terminal/Facets.tsx
git commit -m "feat(frontend): add Facets filter-list primitive"
```

---

### Task 3.6: Sheet primitive

**Files:**
- Create: `frontend/src/components/terminal/Sheet.tsx`

- [ ] **Step 1: Write Sheet.tsx**

```tsx
"use client";
import { useEffect } from "react";

export function Sheet({
  open,
  onClose,
  title,
  children
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center bg-bg/85 pt-16">
      <div className="w-full max-w-4xl border border-border bg-bg p-6">
        <div className="mb-4 flex items-baseline justify-between border-b border-border pb-2">
          <h2
            className="font-sans text-[11px] uppercase text-accent"
            style={{ letterSpacing: "var(--track-wide)" }}
          >▌ {title}</h2>
          <button onClick={onClose} className="border-none text-text-dim">esc</button>
        </div>
        {children}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/terminal/Sheet.tsx
git commit -m "feat(frontend): add Sheet drawer primitive"
```

---

## Phase 4 — Routing + redirects

### Task 4.1: Redirect old `/` and `/[locale]` to `/today`

**Files:**
- Modify: `frontend/src/app/page.tsx`
- Modify: `frontend/src/app/[locale]/page.tsx`

- [ ] **Step 1: Replace `frontend/src/app/page.tsx`**

```tsx
import { redirect } from "next/navigation";
import { defaultLocale } from "@/lib/i18n";

export default function RootIndex() {
  redirect(`/${defaultLocale}/today`);
}
```

- [ ] **Step 2: Replace `frontend/src/app/[locale]/page.tsx`**

```tsx
import { redirect, notFound } from "next/navigation";
import { isLocale, locales } from "@/lib/i18n";

export const dynamicParams = false;
export function generateStaticParams() { return locales.map((locale) => ({ locale })); }

export default function LocaleIndex({ params }: { params: { locale: string } }) {
  if (!isLocale(params.locale)) notFound();
  redirect(`/${params.locale}/today`);
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/app/page.tsx frontend/src/app/[locale]/page.tsx
git commit -m "feat(frontend): redirect root to /today"
```

---

### Task 4.2: Locale-aware layout wrapping Shell

**Files:**
- Create: `frontend/src/app/[locale]/layout.tsx`

- [ ] **Step 1: Check whether one exists**

Run: `ls frontend/src/app/[locale]/layout.tsx 2>/dev/null || echo "missing"`

If it exists, modify it. Otherwise create.

- [ ] **Step 2: Write layout.tsx**

```tsx
import { notFound } from "next/navigation";
import { isLocale, locales } from "@/lib/i18n";
import { Shell } from "@/components/terminal/Shell";

export function generateStaticParams() {
  return locales.map((locale) => ({ locale }));
}

export default function LocaleLayout({
  children,
  params
}: {
  children: React.ReactNode;
  params: { locale: string };
}) {
  if (!isLocale(params.locale)) notFound();
  return <Shell>{children}</Shell>;
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/app/[locale]/layout.tsx
git commit -m "feat(frontend): wrap locale routes in Shell"
```

---

## Phase 5 — Picks route migration

### Task 5.1: Move existing picks page into sub-routes

**Files:**
- Read: `frontend/src/app/[locale]/picks/page.tsx`
- Create: `frontend/src/app/[locale]/picks/health/page.tsx`
- Create: `frontend/src/app/[locale]/picks/models/page.tsx`
- Create: `frontend/src/app/[locale]/picks/explore/page.tsx`
- Modify: `frontend/src/app/[locale]/picks/page.tsx`

- [ ] **Step 1: Re-export existing tabs as top-level pages**

`frontend/src/app/[locale]/picks/health/page.tsx`:

```tsx
import { HealthTab } from "@/components/picks/tabs/HealthTab";
import { notFound } from "next/navigation";
import { isLocale, locales } from "@/lib/i18n";

export function generateStaticParams() { return locales.map((locale) => ({ locale })); }

export default function Page({ params }: { params: { locale: string } }) {
  if (!isLocale(params.locale)) notFound();
  return <HealthTab />;
}
```

`frontend/src/app/[locale]/picks/models/page.tsx` — same shape, import `ModelsTab`.
`frontend/src/app/[locale]/picks/explore/page.tsx` — same shape, import `ExploreTab`.

- [ ] **Step 2: Replace `frontend/src/app/[locale]/picks/page.tsx` with a redirect**

```tsx
import { redirect, notFound } from "next/navigation";
import { isLocale, locales } from "@/lib/i18n";

export const dynamicParams = false;
export function generateStaticParams() { return locales.map((locale) => ({ locale })); }

export default function PicksIndex({
  params,
  searchParams
}: { params: { locale: string }; searchParams: { tab?: string } }) {
  if (!isLocale(params.locale)) notFound();
  const tab = searchParams.tab ?? "health";
  const valid = ["health", "models", "explore"] as const;
  const sub = (valid as readonly string[]).includes(tab) ? tab : "health";
  redirect(`/${params.locale}/picks/${sub}`);
}
```

This preserves any bookmarks using `?tab=...`.

- [ ] **Step 3: Strip tab UI from `PicksLayout`**

Open `frontend/src/components/picks/PicksLayout.tsx`. Remove the tab navigation. Convert it to a simple wrapper that just renders `<PageHeader kicker="PICKS · <activeTab>" />` and the children. Keep the `activeTab` prop for now so existing usages compile; the rail handles navigation.

Alternative: delete `PicksLayout` entirely and update the three tab files to not import it. Either works.

- [ ] **Step 4: Lint + verify routes**

Run: `cd frontend && npm run lint && npm run build`
Expected: build succeeds. If `<PicksLayout>` is referenced anywhere else, fix the callers.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/[locale]/picks frontend/src/components/picks/PicksLayout.tsx
git commit -m "feat(frontend): split /picks tabs into first-class subroutes"
```

---

## Phase 6 — TODAY page

### Task 6.1: useToday hook + aggregation API

**Files:**
- Create: `frontend/src/app/api/today/route.ts`
- Create: `frontend/src/hooks/useToday.ts`

- [ ] **Step 1: Inspect existing picks API helpers**

Run: `grep -rn "paper_bets\|PaperBet\|paperBet" frontend/src 2>/dev/null | head -20`

Identify the Prisma model used for picks. You will need: today's open picks, recently settled picks, model-summary aggregates, and running jobs.

- [ ] **Step 2: Write `frontend/src/app/api/today/route.ts`**

```ts
import { NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";

const prisma = (globalThis as any).__prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") (globalThis as any).__prisma = prisma;

export const dynamic = "force-dynamic";

export async function GET() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const tomorrow = new Date(todayStart.getTime() + 24 * 3600 * 1000);

  try {
    const [openPicks, settledPicks, runningJobs] = await Promise.all([
      // Adjust property names to match your Prisma schema.
      prisma.paperBet.findMany({
        where: { kickoff: { gte: todayStart, lt: tomorrow }, settledAt: null },
        orderBy: { kickoff: "asc" }
      }),
      prisma.paperBet.findMany({
        where: { settledAt: { not: null } },
        orderBy: { settledAt: "desc" },
        take: 10
      }),
      prisma.bulkScrapeJob.findMany({
        where: { status: { in: ["queued", "running"] } },
        orderBy: { updatedAt: "desc" }
      })
    ]);

    return NextResponse.json({ openPicks, settledPicks, runningJobs });
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 });
  }
}
```

If a Prisma model name doesn't exist in `frontend/prisma/schema.prisma`, comment out that section and return an empty array — Phase 9 settles edge cases.

- [ ] **Step 3: Write `frontend/src/hooks/useToday.ts`**

```ts
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
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/api/today/route.ts frontend/src/hooks/useToday.ts
git commit -m "feat(frontend): add /api/today aggregation route + useToday hook"
```

---

### Task 6.2: TODAY page — hero strip

**Files:**
- Create: `frontend/src/app/[locale]/today/page.tsx`
- Create: `frontend/src/components/today/HeroStrip.tsx`

- [ ] **Step 1: Write `today/page.tsx`**

```tsx
import { notFound } from "next/navigation";
import { isLocale, locales } from "@/lib/i18n";
import { TodayPage } from "@/components/today/TodayPage";

export function generateStaticParams() { return locales.map((locale) => ({ locale })); }

export default function Page({ params }: { params: { locale: string } }) {
  if (!isLocale(params.locale)) notFound();
  return <TodayPage />;
}
```

- [ ] **Step 2: Write `components/today/TodayPage.tsx`**

```tsx
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
```

- [ ] **Step 3: Write `components/today/HeroStrip.tsx`**

```tsx
"use client";
import { Stat } from "@/components/terminal/Stat";
import { Sparkline } from "@/components/terminal/Sparkline";
import { BucketBars } from "@/components/terminal/BucketBars";
import { Glyph } from "@/components/terminal/Glyph";
import type { TodayData } from "@/hooks/useToday";

export function HeroStrip({ data, loading }: { data?: TodayData; loading: boolean }) {
  const settled = data?.settledPicks ?? [];
  const open = data?.openPicks ?? [];
  const jobs = data?.runningJobs ?? [];

  const pnl30d = settled
    .filter((p) => p.pnlUnits !== undefined)
    .reduce((acc, p) => acc + (p.pnlUnits ?? 0), 0);
  const cumulative: number[] = (() => {
    let acc = 0;
    return settled.map((p) => (acc += p.pnlUnits ?? 0));
  })();

  const counts = {
    W: open.filter((p) => p.status === "WON").length,
    L: open.filter((p) => p.status === "LOST").length,
    P: open.filter((p) => p.status === "PEND").length,
    V: open.filter((p) => p.status === "VOID").length
  };

  return (
    <section className="grid grid-cols-1 divide-y divide-border border border-border md:grid-cols-3 md:divide-x md:divide-y-0">
      <Stat
        label="Model P&L · trailing 30d"
        value={loading ? "—" : `${pnl30d >= 0 ? "+" : ""}${pnl30d.toFixed(1)}u`}
      >
        <Sparkline data={cumulative.length > 0 ? cumulative : [0]} width={220} height={28} />
      </Stat>
      <Stat
        label="Today · open picks"
        value={loading ? "—" : open.length}
        delta={`${counts.W}W ${counts.L}L ${counts.P}P`}
      >
        <BucketBars
          buckets={[
            { label: "W", value: counts.W, tone: "pos" },
            { label: "L", value: counts.L, tone: "neg" },
            { label: "P", value: counts.P, tone: "warn" },
            { label: "V", value: counts.V, tone: "neutral" }
          ]}
        />
      </Stat>
      <Stat
        label="Scrape queue"
        value={loading ? "—" : `${jobs.length}`}
        delta="running"
      >
        <ul className="font-mono text-[11px] text-text-dim">
          {jobs.slice(0, 3).map((j) => (
            <li key={j.id} className="flex items-center gap-2">
              <Glyph kind="item" className="text-text-faint" /> {j.competitionPath}
            </li>
          ))}
          {jobs.length === 0 && <li className="text-text-faint">— idle</li>}
        </ul>
      </Stat>
    </section>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/[locale]/today frontend/src/components/today/TodayPage.tsx frontend/src/components/today/HeroStrip.tsx
git commit -m "feat(frontend): scaffold TODAY page + hero strip"
```

---

### Task 6.3: TODAY page — slate

**Files:**
- Create: `frontend/src/components/today/TodaySlate.tsx`

- [ ] **Step 1: Write TodaySlate.tsx**

```tsx
"use client";
import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { DataTable, type Column } from "@/components/terminal/DataTable";
import { Chip } from "@/components/terminal/Chip";
import { StatusToken } from "@/components/terminal/StatusToken";
import { Kicker } from "@/components/terminal/Kicker";
import { useLocale } from "@/contexts/LocaleContext";
import type { TodayPick } from "@/hooks/useToday";

const EDGE_THRESHOLDS = [
  { value: 0,    label: "all" },
  { value: 0.01, label: "≥1%" },
  { value: 0.03, label: "≥3%" },
  { value: 0.05, label: "≥5%" }
];

export function TodaySlate({
  picks,
  loading,
  error
}: { picks: TodayPick[]; loading: boolean; error: boolean }) {
  const router = useRouter();
  const { locale } = useLocale();
  const [search, setSearch] = useState("");
  const [edgeMin, setEdgeMin] = useState(0);

  const filtered = useMemo(() => picks.filter((p) => {
    if (p.edge < edgeMin) return false;
    if (search) {
      const q = search.toLowerCase();
      if (
        !p.league.toLowerCase().includes(q) &&
        !p.homeTeam.toLowerCase().includes(q) &&
        !p.awayTeam.toLowerCase().includes(q) &&
        !p.model.toLowerCase().includes(q)
      ) return false;
    }
    return true;
  }), [picks, search, edgeMin]);

  const columns: Column<TodayPick>[] = [
    { key: "time",  header: "Time",    render: (p) => new Date(p.kickoff).toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false }) },
    { key: "league", header: "League", render: (p) => <span className="text-text-dim">{p.league}</span> },
    { key: "match", header: "Match",   render: (p) => <span className="text-text">{p.homeTeam} <span className="text-text-faint">—</span> {p.awayTeam}</span> },
    { key: "market", header: "Market", render: (p) => p.market },
    { key: "pick",  header: "Pick",    render: (p) => <span className="text-accent">{p.pick}</span> },
    { key: "odds",  header: "Odds",    render: (p) => p.odds.toFixed(2), align: "right" },
    { key: "edge",  header: "Edge",    align: "right",
      render: (p) => {
        const v = (p.edge * 100).toFixed(1) + "%";
        const tone = Math.abs(p.edge) < 0.005 ? "text-text-dim" : p.edge > 0 ? "text-pos" : "text-neg";
        return <span className={tone}>{p.edge >= 0 ? "+" : ""}{v}</span>;
      }
    },
    { key: "model", header: "Model",   render: (p) => <span className="text-text-dim">{p.model}</span> },
    { key: "status", header: "Status", render: (p) => <StatusToken kind={p.status} /> }
  ];

  return (
    <section>
      <div className="mb-3 flex items-center justify-between border-b border-border pb-2">
        <Kicker>Today · slate</Kicker>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1 font-mono text-[11px] text-text-dim">
            <span className="text-text-faint">&gt;</span>
            <input
              data-search-input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="filter…"
              className="border-none bg-transparent px-0 py-0 text-[11px] placeholder:text-text-faint"
            />
          </div>
          <div className="flex items-center gap-1">
            {EDGE_THRESHOLDS.map((t) => (
              <Chip key={t.value} selected={edgeMin === t.value} onClick={() => setEdgeMin(t.value)}>
                {t.label}
              </Chip>
            ))}
          </div>
        </div>
      </div>
      {error && <div className="border border-neg/40 px-3 py-2 text-[12px] text-neg">▸ failed to load today</div>}
      <DataTable
        columns={columns}
        rows={filtered}
        onRowClick={(p) => p.eventId && router.push(`/${locale}/matches/${p.eventId}` as any)}
        empty={loading ? "▸ loading…" : "▸ no open picks for today"}
      />
    </section>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add frontend/src/components/today/TodaySlate.tsx
git commit -m "feat(frontend): add TODAY slate table with filter dock"
```

---

### Task 6.4: TODAY page — recent settled + model snapshot

**Files:**
- Create: `frontend/src/components/today/RecentSettled.tsx`
- Create: `frontend/src/components/today/ModelSnapshot.tsx`

- [ ] **Step 1: Write RecentSettled.tsx**

```tsx
"use client";
import { DataTable, type Column } from "@/components/terminal/DataTable";
import { StatusToken } from "@/components/terminal/StatusToken";
import { Kicker } from "@/components/terminal/Kicker";
import type { TodayPick } from "@/hooks/useToday";

export function RecentSettled({ picks, loading }: { picks: TodayPick[]; loading: boolean }) {
  const columns: Column<TodayPick>[] = [
    { key: "league", header: "League", render: (p) => <span className="text-text-dim">{p.league}</span> },
    { key: "match",  header: "Match",  render: (p) => `${p.homeTeam} — ${p.awayTeam}` },
    { key: "pick",   header: "Pick",   render: (p) => <span className="text-accent">{p.pick}</span> },
    { key: "pnl",    header: "P/L",    align: "right",
      render: (p) => {
        const v = p.pnlUnits ?? 0;
        const tone = v > 0 ? "text-pos" : v < 0 ? "text-neg" : "text-text-dim";
        return <span className={tone}>{v >= 0 ? "+" : ""}{v.toFixed(2)}u</span>;
      }
    },
    { key: "status", header: "Status", render: (p) => <StatusToken kind={p.status} /> }
  ];
  return (
    <section>
      <div className="mb-3 border-b border-border pb-2"><Kicker>Recent · settled</Kicker></div>
      <DataTable columns={columns} rows={picks} empty={loading ? "▸ loading…" : "▸ none"} />
    </section>
  );
}
```

- [ ] **Step 2: Write ModelSnapshot.tsx (placeholder until charts are restyled)**

```tsx
"use client";
import Link from "next/link";
import { Kicker } from "@/components/terminal/Kicker";
import { useLocale } from "@/contexts/LocaleContext";

export function ModelSnapshot() {
  const { locale } = useLocale();
  return (
    <section>
      <div className="mb-3 border-b border-border pb-2"><Kicker>Model · health</Kicker></div>
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Brier", value: "0.241" },
          { label: "Log-loss", value: "0.587" },
          { label: "Samples", value: "1,204" }
        ].map((kpi) => (
          <div key={kpi.label} className="border border-border p-3">
            <Kicker>{kpi.label}</Kicker>
            <div className="mt-1 font-mono text-[20px] tabular-nums">{kpi.value}</div>
          </div>
        ))}
      </div>
      <Link href={`/${locale}/picks/health` as any} className="mt-3 inline-block font-mono text-[11px] text-text-dim hover:text-accent">
        ▸ open health
      </Link>
    </section>
  );
}
```

These KPIs render real data once the picks-health hook is wired in Phase 8. For now the static numbers are placeholders to validate layout; replace them in Task 8.2.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/today/RecentSettled.tsx frontend/src/components/today/ModelSnapshot.tsx
git commit -m "feat(frontend): add recent-settled + model-snapshot panels"
```

---

## Phase 7 — Odds + Matches + Jobs pages

### Task 7.1: ODDS page

**Files:**
- Create: `frontend/src/app/[locale]/odds/page.tsx`
- Create: `frontend/src/components/odds/OddsPage.tsx`
- Create: `frontend/src/components/odds/OddsSheet.tsx`
- Create: `frontend/src/components/odds/StatsSheet.tsx`

- [ ] **Step 1: Inspect existing OddsTable + MatchStatsTable**

Run: `cat frontend/src/components/OddsTable.tsx frontend/src/components/MatchStatsTable.tsx | head -120`

Note the props shape — you will reuse the same data hooks (`useOddsData`, `useMatchStatsData`) but render with terminal primitives.

- [ ] **Step 2: Write `app/[locale]/odds/page.tsx`**

```tsx
import { notFound } from "next/navigation";
import { isLocale, locales } from "@/lib/i18n";
import { OddsPage } from "@/components/odds/OddsPage";

export function generateStaticParams() { return locales.map((locale) => ({ locale })); }

export default function Page({ params }: { params: { locale: string } }) {
  if (!isLocale(params.locale)) notFound();
  return <OddsPage />;
}
```

- [ ] **Step 3: Write `components/odds/OddsPage.tsx`**

```tsx
"use client";
import { useState } from "react";
import { PageHeader } from "@/components/terminal/PageHeader";
import { Glyph } from "@/components/terminal/Glyph";
import { useOddsData } from "@/hooks/useOddsData";
import { useMatchStatsData } from "@/hooks/useMatchStatsData";
import { OddsSheet } from "./OddsSheet";
import { StatsSheet } from "./StatsSheet";

export function OddsPage({ initialEventId = "" }: { initialEventId?: string }) {
  const [eventId, setEventId] = useState(initialEventId);
  const [input, setInput] = useState(initialEventId);
  const odds = useOddsData({ eventId, enabled: !!eventId });
  const stats = useMatchStatsData({ eventId, enabled: !!eventId });

  return (
    <>
      <PageHeader
        kicker="Odds · live lookup"
        actions={
          <form
            onSubmit={(e) => { e.preventDefault(); setEventId(input.trim()); }}
            className="flex items-center gap-2 font-mono text-[12px]"
          >
            <Glyph kind="item" className="text-text-faint" />
            <input
              data-search-input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="event id"
              className="w-48 border border-border bg-bg px-2 py-1 text-[12px]"
            />
            <button type="submit" className="border-border px-3 py-1 text-text">load</button>
          </form>
        }
      />
      {!eventId && <p className="text-text-dim">▸ enter an event id to begin</p>}
      {eventId && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[3fr_2fr]">
          <OddsSheet query={odds} />
          <StatsSheet query={stats} />
        </div>
      )}
    </>
  );
}
```

- [ ] **Step 4: Write `components/odds/OddsSheet.tsx`**

Read `frontend/src/components/OddsTable.tsx` carefully and port the rendering logic to terminal styling. The shape: markets grouped by category, rows of `selection · odds · delta`. Render with `DataTable` per market group, using `<Kicker>` headers. Show change arrows in `--accent`/`--neg`/`--null`. Don't change any data structure — just the visuals.

```tsx
"use client";
import { DataTable, type Column } from "@/components/terminal/DataTable";
import { Kicker } from "@/components/terminal/Kicker";
import { Glyph } from "@/components/terminal/Glyph";
import type { UseQueryResult } from "@tanstack/react-query";
// type the query the same way useOddsData currently does — re-use that type
// e.g. type Data = ReturnType<typeof useOddsData>["data"];

export function OddsSheet({ query }: { query: UseQueryResult<any> }) {
  const { data, isLoading, error } = query;
  if (isLoading) return <div className="text-text-dim">▸ loading odds…</div>;
  if (error)     return <div className="border border-neg/40 px-3 py-2 text-neg">▸ failed to load odds</div>;
  if (!data)     return <div className="text-text-dim">▸ no data</div>;

  return (
    <section className="flex flex-col gap-5">
      {data.markets.map((market: any) => {
        const columns: Column<any>[] = [
          { key: "sel",  header: market.name, render: (r) => r.selection },
          { key: "odds", header: "Odds", align: "right", render: (r) => r.odds?.toFixed(2) ?? "—" },
          { key: "d",    header: "Δ", align: "right",
            render: (r) => {
              if (r.delta == null || r.delta === 0) return <Glyph kind="null" className="text-text-faint" />;
              const up = r.delta > 0;
              return <span className={up ? "text-pos" : "text-neg"}>
                <Glyph kind={up ? "up" : "down"} />{Math.abs(r.delta).toFixed(2)}
              </span>;
            }
          }
        ];
        return (
          <div key={market.name}>
            <div className="mb-1 flex items-baseline justify-between border-b border-border pb-1">
              <Kicker>{market.name}</Kicker>
              <span className="font-mono text-[10px] text-text-faint">{market.selections?.length ?? 0} rows</span>
            </div>
            <DataTable columns={columns} rows={market.selections ?? []} />
          </div>
        );
      })}
    </section>
  );
}
```

The actual `data.markets` shape may differ; adjust property names by reading `useOddsData.ts` and the existing `OddsTable.tsx`.

- [ ] **Step 5: Write `components/odds/StatsSheet.tsx`**

Port `MatchStatsTable` to a vertical key/value list. Read the existing component to find the data shape, then render:

```tsx
"use client";
import { Kicker } from "@/components/terminal/Kicker";
import type { UseQueryResult } from "@tanstack/react-query";

export function StatsSheet({ query }: { query: UseQueryResult<any> }) {
  const { data, isLoading, error } = query;
  if (isLoading) return <div className="text-text-dim">▸ loading stats…</div>;
  if (error)     return <div className="border border-neg/40 px-3 py-2 text-neg">▸ failed to load stats</div>;
  if (!data)     return <div className="text-text-dim">▸ no data</div>;

  // Adjust property access to match the actual MatchStats shape:
  const rows = (data.categories ?? []).flatMap((cat: any) =>
    (cat.items ?? []).map((it: any) => ({ category: cat.name, ...it }))
  );

  return (
    <section>
      <div className="mb-2 border-b border-border pb-1"><Kicker>Match stats</Kicker></div>
      <dl className="grid grid-cols-[auto_1fr_auto_1fr_auto] gap-x-3 gap-y-1 font-mono text-[12px]">
        {rows.map((r: any, i: number) => (
          <div key={i} className="contents">
            <dt className="text-pos tabular-nums text-right">{r.home}</dt>
            <dd className="text-text-dim">{r.label ?? r.name}</dd>
            <dt className="text-neg tabular-nums">{r.away}</dt>
            <dd className="text-text-faint">{r.category}</dd>
            <dd />
          </div>
        ))}
      </dl>
    </section>
  );
}
```

- [ ] **Step 6: Add snapshot strip**

The spec calls for a strip of the last 5 stored snapshots at the top of the odds sheet. The data is already in the SQLite DB (`odds_snapshots` table, with timestamps per event). Inspect existing endpoints:

Run: `grep -rn "storage\|snapshots" frontend/src/app/api | head -10`

If an endpoint already lists snapshots, use it; otherwise create `frontend/src/app/api/snapshots/[eventId]/route.ts`:

```ts
import { NextResponse } from "next/server";
import { PrismaClient } from "@prisma/client";
const prisma = (globalThis as any).__prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== "production") (globalThis as any).__prisma = prisma;

export async function GET(_: Request, { params }: { params: { eventId: string } }) {
  const rows = await prisma.oddsSnapshot.findMany({
    where: { eventId: params.eventId },
    orderBy: { capturedAt: "desc" },
    take: 5,
    select: { id: true, capturedAt: true }
  });
  return NextResponse.json(rows);
}
```

Adjust property names to the actual schema.

Add a `<SnapshotStrip>` component at `frontend/src/components/odds/SnapshotStrip.tsx`:

```tsx
"use client";
import { useQuery } from "@tanstack/react-query";
import { Kicker } from "@/components/terminal/Kicker";
import { Chip } from "@/components/terminal/Chip";

type Snap = { id: string; capturedAt: string };

export function SnapshotStrip({
  eventId,
  selectedId,
  onSelect
}: { eventId: string; selectedId?: string; onSelect: (id?: string) => void }) {
  const { data } = useQuery<Snap[]>({
    queryKey: ["snapshots", eventId],
    queryFn: async () => (await fetch(`/api/snapshots/${eventId}`)).json(),
    enabled: !!eventId
  });
  if (!data || data.length === 0) return null;
  return (
    <div className="mb-3 flex items-center gap-2 border-b border-border pb-2">
      <Kicker>Snapshots</Kicker>
      <Chip selected={!selectedId} onClick={() => onSelect(undefined)}>live</Chip>
      {data.map((s) => (
        <Chip key={s.id} selected={selectedId === s.id} onClick={() => onSelect(s.id)}>
          {new Date(s.capturedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
        </Chip>
      ))}
    </div>
  );
}
```

Add `selectedSnapshotId` state in `OddsPage` and pass it through to `useOddsData` (the hook accepts an extra param — if not, leave the strip as visual-only for now and add the hook param in a follow-up task; document the limitation in the commit message).

Mount `<SnapshotStrip>` at the top of the `OddsSheet` panel, above the markets list.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/app/[locale]/odds frontend/src/app/api/snapshots frontend/src/components/odds
git commit -m "feat(frontend): terminal-restyled ODDS page with snapshot strip"
```

---

### Task 7.2: MATCHES list + detail

**Files:**
- Create: `frontend/src/app/[locale]/matches/page.tsx`
- Create: `frontend/src/components/matches/MatchesPage.tsx`
- Create: `frontend/src/app/[locale]/matches/[eventId]/page.tsx`

- [ ] **Step 1: Inspect existing scraped-matches hook**

Run: `cat frontend/src/hooks/useScrapedMatchesData.ts`

Confirm the shape of each match row (country, league, status, last fetch, etc).

- [ ] **Step 2: Write `app/[locale]/matches/page.tsx`**

```tsx
import { notFound } from "next/navigation";
import { isLocale, locales } from "@/lib/i18n";
import { MatchesPage } from "@/components/matches/MatchesPage";

export function generateStaticParams() { return locales.map((locale) => ({ locale })); }

export default function Page({ params }: { params: { locale: string } }) {
  if (!isLocale(params.locale)) notFound();
  return <MatchesPage />;
}
```

- [ ] **Step 3: Write `components/matches/MatchesPage.tsx`**

```tsx
"use client";
import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { PageHeader } from "@/components/terminal/PageHeader";
import { Facets, type Facet } from "@/components/terminal/Facets";
import { DataTable, type Column } from "@/components/terminal/DataTable";
import { StatusToken } from "@/components/terminal/StatusToken";
import { useScrapedMatchesData } from "@/hooks/useScrapedMatchesData";
import { useLocale } from "@/contexts/LocaleContext";

type Match = {
  eventId: string;
  kickoff?: string;
  country?: string;
  league?: string;
  home?: string;
  away?: string;
  status?: string;
  snapshots?: number;
  lastFetch?: string;
};

export function MatchesPage() {
  const router = useRouter();
  const { locale } = useLocale();
  const { data, isLoading } = useScrapedMatchesData({ enabled: true });
  const matches: Match[] = (data as any) ?? [];

  const [countries, setCountries] = useState<string[]>([]);
  const [leagues, setLeagues] = useState<string[]>([]);
  const [statuses, setStatuses] = useState<string[]>([]);

  const facets: Facet[] = useMemo(() => {
    const counts = (key: keyof Match) => {
      const m = new Map<string, number>();
      matches.forEach((mm) => {
        const v = (mm[key] as string | undefined) ?? "—";
        m.set(v, (m.get(v) ?? 0) + 1);
      });
      return Array.from(m.entries()).map(([value, count]) => ({ value, label: value, count }));
    };
    return [
      { key: "country", label: "Country", options: counts("country"), selected: countries, onChange: setCountries },
      { key: "league",  label: "League",  options: counts("league"),  selected: leagues,   onChange: setLeagues },
      { key: "status",  label: "Status",  options: counts("status"),  selected: statuses,  onChange: setStatuses }
    ];
  }, [matches, countries, leagues, statuses]);

  const filtered = useMemo(() => matches.filter((m) =>
    (countries.length === 0 || countries.includes(m.country ?? "—")) &&
    (leagues.length === 0   || leagues.includes(m.league ?? "—")) &&
    (statuses.length === 0  || statuses.includes(m.status ?? "—"))
  ), [matches, countries, leagues, statuses]);

  const columns: Column<Match>[] = [
    { key: "kickoff", header: "Kickoff", render: (m) => m.kickoff ?? "—" },
    { key: "country", header: "Country", render: (m) => <span className="text-text-dim">{m.country ?? "—"}</span> },
    { key: "league",  header: "League",  render: (m) => <span className="text-text-dim">{m.league ?? "—"}</span> },
    { key: "home",    header: "Home",    render: (m) => m.home ?? "—" },
    { key: "away",    header: "Away",    render: (m) => m.away ?? "—" },
    { key: "status",  header: "Status",  render: (m) => {
      const s = (m.status ?? "SCHED").toUpperCase();
      const kind = (["LIVE","FT","SCHED"] as const).includes(s as any) ? s as any : "SCHED";
      return <StatusToken kind={kind as any} />;
    }},
    { key: "snapshots", header: "Snap", align: "right", render: (m) => m.snapshots ?? 0 },
    { key: "lastFetch", header: "Last fetch", render: (m) => <span className="text-text-faint">{m.lastFetch ?? "—"}</span> }
  ];

  return (
    <>
      <PageHeader kicker="Matches · stored" />
      <div className="flex gap-6">
        <Facets facets={facets} />
        <div className="flex-1">
          <DataTable
            columns={columns}
            rows={filtered}
            onRowClick={(m) => router.push(`/${locale}/matches/${m.eventId}` as any)}
            empty={isLoading ? "▸ loading…" : "▸ no matches in db"}
          />
        </div>
      </div>
    </>
  );
}
```

- [ ] **Step 4: Write `app/[locale]/matches/[eventId]/page.tsx`**

```tsx
"use client";
import { OddsPage } from "@/components/odds/OddsPage";

export default function MatchDetail({ params }: { params: { locale: string; eventId: string } }) {
  return <OddsPage initialEventId={params.eventId} />;
}
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/[locale]/matches frontend/src/components/matches
git commit -m "feat(frontend): terminal-restyled MATCHES list + detail"
```

---

### Task 7.3: JOBS page

**Files:**
- Create: `frontend/src/app/[locale]/jobs/page.tsx`
- Create: `frontend/src/components/jobs/JobsPage.tsx`

- [ ] **Step 1: Inspect existing bulk-scrape hook + panel**

Run: `cat frontend/src/hooks/useBulkScrapeJobsData.ts frontend/src/components/BulkScrapePanel.tsx | head -200`

Confirm the job form fields (path, seasons, includeOdds, includeStats, concurrency) and the job-row shape. Confirm there is a POST endpoint and DELETE/cancel endpoint.

- [ ] **Step 2: Write `app/[locale]/jobs/page.tsx`**

```tsx
import { notFound } from "next/navigation";
import { isLocale, locales } from "@/lib/i18n";
import { JobsPage } from "@/components/jobs/JobsPage";

export function generateStaticParams() { return locales.map((locale) => ({ locale })); }

export default function Page({ params }: { params: { locale: string } }) {
  if (!isLocale(params.locale)) notFound();
  return <JobsPage />;
}
```

- [ ] **Step 3: Write `components/jobs/JobsPage.tsx`**

```tsx
"use client";
import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { PageHeader } from "@/components/terminal/PageHeader";
import { DataTable, type Column } from "@/components/terminal/DataTable";
import { StatusToken, type StatusKind } from "@/components/terminal/StatusToken";
import { AsciiProgress } from "@/components/terminal/AsciiProgress";
import { Glyph } from "@/components/terminal/Glyph";
import { useBulkScrapeJobsData } from "@/hooks/useBulkScrapeJobsData";

type Job = {
  id: string;
  competition_path: string;
  status: string;
  progress?: number;
  started_at?: string;
  finished_at?: string;
  error?: string;
};

const STATUS_MAP: Record<string, StatusKind> = {
  queued: "PEND",
  running: "RUN",
  completed: "OK",
  completed_with_errors: "OK",
  failed: "ERR"
};

export function JobsPage() {
  const qc = useQueryClient();
  const { data, isLoading } = useBulkScrapeJobsData({ enabled: true });
  const jobs: Job[] = (data as any) ?? [];

  const [path, setPath] = useState("");
  const [seasons, setSeasons] = useState(3);
  const [concurrency, setConcurrency] = useState(2);
  const [submitting, setSubmitting] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      // Use the same endpoint the existing BulkScrapePanel posts to.
      // Inspect BulkScrapePanel.tsx for the exact URL + body shape and mirror it here.
      await fetch("/api/bulk-scrape", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          competition_path: path,
          seasons,
          concurrency,
          include_odds: true,
          include_stats: true
        })
      });
      setPath("");
      qc.invalidateQueries({ queryKey: ["bulk-scrape-jobs"] });
    } finally {
      setSubmitting(false);
    }
  }

  async function kill(id: string) {
    // Mirror existing cancel endpoint.
    await fetch(`/api/bulk-scrape/${id}`, { method: "DELETE" });
    qc.invalidateQueries({ queryKey: ["bulk-scrape-jobs"] });
  }

  const columns: Column<Job>[] = [
    { key: "id",     header: "Job",    render: (j) => <span className="text-text-dim">{j.id.slice(0, 8)}</span> },
    { key: "path",   header: "Competition", render: (j) => j.competition_path },
    { key: "status", header: "Status", render: (j) => <StatusToken kind={STATUS_MAP[j.status] ?? "PEND"} /> },
    { key: "prog",   header: "Progress", render: (j) => j.progress != null ? <AsciiProgress value={j.progress} /> : "—" },
    { key: "started", header: "Started", render: (j) => <span className="text-text-faint">{j.started_at ?? "—"}</span> },
    { key: "actions", header: "", align: "right",
      render: (j) =>
        ["queued", "running"].includes(j.status)
          ? <button onClick={() => kill(j.id)} className="border-neg/60 px-2 py-0 text-neg hover:bg-surface">[KILL]</button>
          : null
    }
  ];

  return (
    <>
      <PageHeader kicker="Jobs · bulk scrape" />
      <form onSubmit={submit} className="mb-6 flex items-center gap-3 border border-border p-3 font-mono text-[12px]">
        <Glyph kind="item" className="text-text-faint" />
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="football/czech-republic/chance-liga"
          className="flex-1 border border-border bg-bg px-2 py-1 text-[12px]"
          required
        />
        <label className="flex items-center gap-1 text-text-dim">
          seasons
          <input type="number" min={1} max={10} value={seasons} onChange={(e) => setSeasons(+e.target.value)} className="w-14 border border-border bg-bg px-2 py-1 text-[12px]" />
        </label>
        <label className="flex items-center gap-1 text-text-dim">
          conc
          <input type="number" min={1} max={8} value={concurrency} onChange={(e) => setConcurrency(+e.target.value)} className="w-12 border border-border bg-bg px-2 py-1 text-[12px]" />
        </label>
        <button type="submit" disabled={submitting} className="border-accent text-accent">
          {submitting ? "starting…" : "▸ start"}
        </button>
      </form>
      <DataTable columns={columns} rows={jobs} empty={isLoading ? "▸ loading…" : "▸ no jobs"} />
    </>
  );
}
```

If the existing `BulkScrapePanel.tsx` uses a different endpoint URL or body, adjust accordingly. The goal is parity with the current submit/cancel behavior.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/app/[locale]/jobs frontend/src/components/jobs
git commit -m "feat(frontend): terminal-restyled JOBS page (bulk scrape)"
```

---

## Phase 8 — Picks reskin + chart language

### Task 8.1: TerminalAxis + TerminalTooltip

**Files:**
- Create: `frontend/src/components/terminal/charts/TerminalAxis.tsx`
- Create: `frontend/src/components/terminal/charts/TerminalTooltip.tsx`

- [ ] **Step 1: Write TerminalAxis.tsx**

```tsx
import { AxisLeft, AxisBottom } from "@visx/axis";

const axisProps = {
  stroke: "var(--text-faint)",
  tickStroke: "var(--text-faint)",
  tickLabelProps: () => ({
    fill: "var(--text-dim)",
    fontFamily: "var(--font-mono)",
    fontSize: 10,
    textAnchor: "middle" as const
  })
};

export function TerminalAxisLeft(props: React.ComponentProps<typeof AxisLeft>) {
  return <AxisLeft {...axisProps} tickLabelProps={() => ({ ...axisProps.tickLabelProps(), textAnchor: "end" as const, dx: -4 })} {...props} />;
}

export function TerminalAxisBottom(props: React.ComponentProps<typeof AxisBottom>) {
  return <AxisBottom {...axisProps} {...props} />;
}
```

- [ ] **Step 2: Write TerminalTooltip.tsx**

```tsx
import { Tooltip } from "@visx/tooltip";

export function TerminalTooltip({
  top, left, children
}: { top: number; left: number; children: React.ReactNode }) {
  return (
    <Tooltip top={top} left={left} style={{ position: "absolute" }}>
      <div className="border border-border-hot bg-bg p-2 font-mono text-[11px] text-text">
        {children}
      </div>
    </Tooltip>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add frontend/src/components/terminal/charts
git commit -m "feat(frontend): add terminal axis + tooltip primitives for charts"
```

---

### Task 8.2: Reskin Calibration + Waterfall + Cumulative (used in Health)

**Files:**
- Create: `frontend/src/components/terminal/charts/CalibrationPlot.tsx`
- Create: `frontend/src/components/terminal/charts/WaterfallChart.tsx`
- Create: `frontend/src/components/terminal/charts/CumulativeLine.tsx`
- Modify: `frontend/src/components/picks/tabs/HealthTab.tsx`

- [ ] **Step 1: Read the existing charts**

Run: `cat frontend/src/components/picks/charts/CalibrationPlot.tsx frontend/src/components/picks/charts/WaterfallChart.tsx frontend/src/components/picks/charts/CumulativeLineChart.tsx`

You will create terminal-styled equivalents that consume the same props.

- [ ] **Step 2: Port `CalibrationPlot.tsx`**

Keep the existing component's API (data prop, dimensions). Swap colors: predicted line in `--accent`, ideal diagonal in `--text-faint` dashed (use `strokeDasharray="2 2"`), points as 4×4 squares (`<rect>`, not circles, for crispEdges). Use `TerminalAxisLeft` / `TerminalAxisBottom`. Background is `--bg`. Grid lines `--border` at 1px.

Full code (adapt prop names to match the existing chart):

```tsx
"use client";
import { Group } from "@visx/group";
import { scaleLinear } from "@visx/scale";
import { TerminalAxisLeft, TerminalAxisBottom } from "./TerminalAxis";

type Point = { predicted: number; actual: number; n?: number };

export function CalibrationPlot({
  data,
  width = 480,
  height = 320
}: { data: Point[]; width?: number; height?: number }) {
  const margin = { top: 16, right: 16, bottom: 32, left: 36 };
  const innerW = width - margin.left - margin.right;
  const innerH = height - margin.top - margin.bottom;
  const x = scaleLinear({ domain: [0, 1], range: [0, innerW] });
  const y = scaleLinear({ domain: [0, 1], range: [innerH, 0] });

  return (
    <svg width={width} height={height} role="img">
      <rect width={width} height={height} fill="var(--bg)" />
      <Group top={margin.top} left={margin.left}>
        <line x1={x(0)} y1={y(0)} x2={x(1)} y2={y(1)} stroke="var(--text-faint)" strokeDasharray="2 2" />
        {data.map((p, i) => (
          <rect key={i} x={x(p.predicted) - 2} y={y(p.actual) - 2} width={4} height={4} fill="var(--accent)" shapeRendering="crispEdges" />
        ))}
        {data.length > 1 && (
          <polyline
            points={data.map((p) => `${x(p.predicted).toFixed(1)},${y(p.actual).toFixed(1)}`).join(" ")}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={1}
          />
        )}
        <TerminalAxisLeft scale={y} numTicks={5} />
        <TerminalAxisBottom top={innerH} scale={x} numTicks={5} />
      </Group>
    </svg>
  );
}
```

- [ ] **Step 3: Port `WaterfallChart.tsx`**

Read the existing chart for the data shape. Render bars as 1-unit-wide rectangles, `--pos` for positive contributions, `--neg` for negative, separated by 1px `--bg` gutters. Cumulative line in `--accent`. Use `TerminalAxis*`.

- [ ] **Step 4: Port `CumulativeLineChart.tsx`**

Single polyline in `--accent`. Reuse `<Sparkline>` for small instances; this version is the full-size chart with axes.

- [ ] **Step 5: Update HealthTab to import from the new paths**

Edit `frontend/src/components/picks/tabs/HealthTab.tsx`:
- Replace each import of `@/components/picks/charts/<X>` with `@/components/terminal/charts/<X>`.
- Wrap the page in `<PageHeader kicker="Picks · health" />`.
- Replace existing FilterBar styling by reusing `<Chip>` if the FilterBar is intrusive; otherwise leave structure intact.
- Replace the top KPI tile rendering (if present) with 4 `<Stat>` cards using `border border-border` containers, mimicking the HeroStrip pattern.
- Update `ModelSnapshot.tsx` to use this same data: pull leading-model KPIs from the picks-health hook (whatever powers `HealthTab` — find it via `grep -n "useQuery" frontend/src/components/picks/tabs/HealthTab.tsx`).

- [ ] **Step 6: Lint + visual smoke**

Run: `cd frontend && npm run lint && npm run dev &` then open `/en/picks/health` and verify the charts render.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/components/terminal/charts frontend/src/components/picks/tabs/HealthTab.tsx frontend/src/components/today/ModelSnapshot.tsx
git commit -m "feat(frontend): terminal-restyle calibration/waterfall/cumulative + health tab"
```

---

### Task 8.3: Reskin Scatter + Violin + Heatmap (Explore)

**Files:**
- Create: `frontend/src/components/terminal/charts/ScatterChart.tsx`
- Create: `frontend/src/components/terminal/charts/ViolinChart.tsx`
- Create: `frontend/src/components/terminal/charts/HeatmapChart.tsx`
- Modify: `frontend/src/components/picks/tabs/ExploreTab.tsx`

- [ ] **Step 1: Port each chart**

For each: open the existing `frontend/src/components/picks/charts/<X>.tsx`, keep the same prop signature, swap colors to tokens, use `TerminalAxis*`. Render points as 3×3 rects (Scatter). Violin: outline-only in `--accent`, no fill. Heatmap: cells colored by `--text-faint` → `--accent` interpolation, with a 1px `--bg` border between cells (the "barcode" feel).

- [ ] **Step 2: Add BucketBars marginal to Heatmap**

Below each heatmap row, render a thin `<BucketBars>` strip showing row totals.

- [ ] **Step 3: Update `ExploreTab.tsx` imports**

Same migration: `@/components/picks/charts/<X>` → `@/components/terminal/charts/<X>`. Wrap in `<PageHeader kicker="Picks · explore" />`. Lay out as a 3-up grid: `grid-cols-1 lg:grid-cols-3 gap-6`.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/terminal/charts frontend/src/components/picks/tabs/ExploreTab.tsx
git commit -m "feat(frontend): terminal-restyle scatter/violin/heatmap + explore tab"
```

---

### Task 8.4: Reskin Models tab + ModelDeepDive

**Files:**
- Modify: `frontend/src/components/picks/tabs/ModelsTab.tsx`
- Modify: `frontend/src/components/picks/ModelDeepDive.tsx`

- [ ] **Step 1: Replace ModelsTab markup with DataTable**

Read `ModelsTab.tsx`. Replace its custom table with `<DataTable>`, columns appropriate to the model summary shape (name, samples, brier, log-loss, ROI, etc.). Row click → `/[locale]/picks/models/[name]`. Wrap in `<PageHeader kicker="Picks · models" />`.

- [ ] **Step 2: Reskin ModelDeepDive**

Read `ModelDeepDive.tsx`. Swap chart imports to `@/components/terminal/charts/*`. Replace headers with `<Kicker>`. Replace any card containers with `border border-border` divs. Replace any large numbers with `<Stat>`.

- [ ] **Step 3: Lint + visual smoke**

Run: `cd frontend && npm run lint`

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/picks
git commit -m "feat(frontend): terminal-restyle Models tab + ModelDeepDive"
```

---

### Task 8.5: Remove superseded chart files

**Files:**
- Delete: `frontend/src/components/picks/charts/BucketedBarChart.tsx`
- Delete: `frontend/src/components/picks/charts/CalibrationPlot.tsx`
- Delete: `frontend/src/components/picks/charts/CumulativeLineChart.tsx`
- Delete: `frontend/src/components/picks/charts/HeatmapChart.tsx`
- Delete: `frontend/src/components/picks/charts/ScatterChart.tsx`
- Delete: `frontend/src/components/picks/charts/ViolinChart.tsx`
- Delete: `frontend/src/components/picks/charts/WaterfallChart.tsx`

- [ ] **Step 1: Search for stale imports**

Run: `grep -rn "@/components/picks/charts/" frontend/src`
Expected: no matches. If matches remain, fix the imports first.

- [ ] **Step 2: Delete the directory**

```bash
rm -rf frontend/src/components/picks/charts
```

- [ ] **Step 3: Build**

Run: `cd frontend && npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components/picks/charts
git commit -m "chore(frontend): remove superseded picks chart components"
```

---

## Phase 9 — Settings page, cleanup, e2e

### Task 9.1: Settings page

**Files:**
- Create: `frontend/src/app/[locale]/settings/page.tsx`
- Create: `frontend/src/components/settings/SettingsPage.tsx`
- Create: `frontend/src/hooks/useSettings.ts`

- [ ] **Step 1: Write `useSettings.ts`**

```ts
"use client";
import { useEffect, useState } from "react";

export type Settings = {
  scanlines: boolean;
  refreshInterval: number; // ms, 0 = off
};

const KEY = "terminal.settings.v1";
const DEFAULTS: Settings = { scanlines: false, refreshInterval: 0 };

export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY);
      if (raw) setSettings({ ...DEFAULTS, ...JSON.parse(raw) });
    } catch {}
  }, []);

  function update(patch: Partial<Settings>) {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try { localStorage.setItem(KEY, JSON.stringify(next)); } catch {}
      return next;
    });
  }

  return { settings, update };
}
```

- [ ] **Step 2: Write `app/[locale]/settings/page.tsx`**

```tsx
import { notFound } from "next/navigation";
import { isLocale, locales } from "@/lib/i18n";
import { SettingsPage } from "@/components/settings/SettingsPage";

export function generateStaticParams() { return locales.map((locale) => ({ locale })); }

export default function Page({ params }: { params: { locale: string } }) {
  if (!isLocale(params.locale)) notFound();
  return <SettingsPage />;
}
```

- [ ] **Step 3: Write `components/settings/SettingsPage.tsx`**

```tsx
"use client";
import { PageHeader } from "@/components/terminal/PageHeader";
import { Kicker } from "@/components/terminal/Kicker";
import { useSettings } from "@/hooks/useSettings";
import { useLocale } from "@/contexts/LocaleContext";

export function SettingsPage() {
  const { locale, setLocale } = useLocale();
  const { settings, update } = useSettings();

  return (
    <>
      <PageHeader kicker="Settings" />
      <div className="space-y-6">
        <Field label="Locale">
          <select value={locale} onChange={(e) => setLocale(e.target.value as any)}>
            <option value="en">EN</option>
            <option value="cs">CS</option>
          </select>
        </Field>
        <Field label="Auto-refresh">
          <select value={settings.refreshInterval} onChange={(e) => update({ refreshInterval: +e.target.value })}>
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
            /> enable
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
```

- [ ] **Step 4: Wire scanline overlay into Shell**

Edit `frontend/src/components/terminal/Shell.tsx`. Read `useSettings()` and conditionally render a fixed overlay div:

```tsx
{settings.scanlines && (
  <div
    aria-hidden
    className="pointer-events-none fixed inset-0 z-50"
    style={{
      backgroundImage: "repeating-linear-gradient(0deg, rgba(0,0,0,0.18) 0, rgba(0,0,0,0.18) 1px, transparent 1px, transparent 3px)"
    }}
  />
)}
```

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/[locale]/settings frontend/src/components/settings frontend/src/hooks/useSettings.ts frontend/src/components/terminal/Shell.tsx
git commit -m "feat(frontend): add Settings page with locale, auto-refresh, CRT scanlines"
```

---

### Task 9.2: Remove superseded component files

**Files:**
- Delete: `frontend/src/components/OddsTable.tsx`
- Delete: `frontend/src/components/MatchStatsTable.tsx`
- Delete: `frontend/src/components/BulkScrapePanel.tsx`
- Delete: `frontend/src/components/ScrapedMatchesMenu.tsx`
- Delete: `frontend/src/components/ScrapedMatchesTable.tsx`
- Delete: `frontend/src/components/EventSearchForm.tsx`
- Delete: `frontend/src/components/LocaleSwitcher.tsx`
- Delete: `frontend/src/components/LiveRefreshToggle.tsx`
- Delete: `frontend/src/components/LiveRegion.tsx`
- Delete: `frontend/src/components/picks/PicksLayout.tsx`

- [ ] **Step 1: Find stale imports**

Run: `for f in OddsTable MatchStatsTable BulkScrapePanel ScrapedMatchesMenu ScrapedMatchesTable EventSearchForm LocaleSwitcher LiveRefreshToggle LiveRegion PicksLayout; do echo "== $f =="; grep -rn "@/components/$f\|@/components/picks/$f" frontend/src || echo "(none)"; done`

Fix any remaining imports before deleting.

- [ ] **Step 2: Delete files**

```bash
rm frontend/src/components/OddsTable.tsx
rm frontend/src/components/MatchStatsTable.tsx
rm frontend/src/components/BulkScrapePanel.tsx
rm frontend/src/components/ScrapedMatchesMenu.tsx
rm frontend/src/components/ScrapedMatchesTable.tsx
rm frontend/src/components/EventSearchForm.tsx
rm frontend/src/components/LocaleSwitcher.tsx
rm frontend/src/components/LiveRefreshToggle.tsx
rm frontend/src/components/LiveRegion.tsx
rm frontend/src/components/picks/PicksLayout.tsx
```

- [ ] **Step 3: Build**

Run: `cd frontend && npm run build`
Expected: build succeeds.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/components
git commit -m "chore(frontend): remove superseded layout + component files"
```

---

### Task 9.3: Update existing Playwright specs

**Files:**
- Modify: every file in `frontend/tests/e2e/` that references the old DOM

- [ ] **Step 1: List existing specs**

Run: `ls frontend/tests/e2e/ 2>/dev/null && grep -l "data-testid\|getByRole" frontend/tests/e2e/*.ts 2>/dev/null`

- [ ] **Step 2: Audit each spec**

For each spec, run it (`cd frontend && npm run test:e2e -- <spec>`) and update selectors:
- Old "live"/"saved" tab buttons → navigate via rail: `page.goto("/en/odds")` / `page.goto("/en/matches")`.
- Old `EventSearchForm` input → `page.locator("[data-search-input]")` on the odds page.
- Old odds table rows → `page.locator("table tbody tr")` (the new `DataTable` is unchanged structurally).

Update each spec to use the new routes. Keep the same assertions on data, only swap selectors / nav.

- [ ] **Step 3: Run the full suite**

Run: `cd frontend && npm run test:e2e -- --project=chromium`
Expected: all specs pass.

- [ ] **Step 4: Commit**

```bash
git add frontend/tests
git commit -m "test(frontend): update e2e specs for new routes and selectors"
```

---

### Task 9.4: Add new e2e specs

**Files:**
- Create: `frontend/tests/e2e/today.spec.ts`
- Create: `frontend/tests/e2e/jobs.spec.ts`
- Create: `frontend/tests/e2e/keyboard.spec.ts`

- [ ] **Step 1: Write today.spec.ts**

```ts
import { test, expect } from "@playwright/test";

test.describe("Today page", () => {
  test("renders hero strip with three stat cells", async ({ page }) => {
    // Stub the aggregation API for deterministic rendering
    await page.route("**/api/today", (route) =>
      route.fulfill({ json: { openPicks: [], settledPicks: [], runningJobs: [] } })
    );
    await page.route("**/api/db-stats", (route) =>
      route.fulfill({ json: { ok: true, rows: 100, odds: 50, stats: 50 } })
    );

    await page.goto("/en/today");
    await expect(page.getByText("Today · Cockpit")).toBeVisible();
    await expect(page.getByText(/Model P&L · trailing 30d/i)).toBeVisible();
    await expect(page.getByText(/Today · open picks/i)).toBeVisible();
    await expect(page.getByText(/Scrape queue/i)).toBeVisible();
  });

  test("edge filter chip narrows the slate", async ({ page }) => {
    await page.route("**/api/today", (route) =>
      route.fulfill({
        json: {
          openPicks: [
            { id: "1", kickoff: "2026-05-12T14:00:00Z", league: "X", homeTeam: "A", awayTeam: "B", market: "1X2", pick: "1", odds: 1.9, edge: 0.005, model: "m", status: "OPEN" },
            { id: "2", kickoff: "2026-05-12T15:00:00Z", league: "Y", homeTeam: "C", awayTeam: "D", market: "1X2", pick: "1", odds: 2.1, edge: 0.06,  model: "m", status: "OPEN" }
          ],
          settledPicks: [], runningJobs: []
        }
      })
    );
    await page.route("**/api/db-stats", (route) => route.fulfill({ json: { ok: true, rows: 0, odds: 0, stats: 0 } }));

    await page.goto("/en/today");
    await expect(page.locator("tbody tr")).toHaveCount(2);
    await page.getByRole("button", { name: /≥5%/ }).click();
    await expect(page.locator("tbody tr")).toHaveCount(1);
  });
});
```

- [ ] **Step 2: Write jobs.spec.ts**

```ts
import { test, expect } from "@playwright/test";

test("jobs page lists jobs and can submit a new one", async ({ page }) => {
  await page.route("**/api/bulk-scrape", (route) => {
    if (route.request().method() === "POST") {
      route.fulfill({ json: { id: "abc" } });
    } else {
      route.fulfill({ json: [] });
    }
  });
  await page.route("**/api/bulk-scrape/jobs", (route) =>
    route.fulfill({ json: [
      { id: "j1", competition_path: "football/x/y", status: "running", progress: 0.4 }
    ]})
  );
  await page.route("**/api/db-stats", (route) => route.fulfill({ json: { ok: true, rows: 0, odds: 0, stats: 0 } }));

  await page.goto("/en/jobs");
  await expect(page.getByText("Jobs · bulk scrape")).toBeVisible();
  await page.getByPlaceholder(/football\//i).fill("football/x/y");
  await page.getByRole("button", { name: /start/i }).click();
});
```

(Adjust the route URLs to whatever the actual `useBulkScrapeJobsData` fetches.)

- [ ] **Step 3: Write keyboard.spec.ts**

```ts
import { test, expect } from "@playwright/test";

test("? opens keyboard sheet and esc closes it", async ({ page }) => {
  await page.route("**/api/db-stats", (route) => route.fulfill({ json: { ok: true, rows: 0, odds: 0, stats: 0 } }));
  await page.goto("/en/today");
  await page.keyboard.press("?");
  await expect(page.getByText(/^Keyboard$/i)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByText(/^Keyboard$/i)).toBeHidden();
});

test("g t navigates to today", async ({ page }) => {
  await page.route("**/api/db-stats", (route) => route.fulfill({ json: { ok: true, rows: 0, odds: 0, stats: 0 } }));
  await page.goto("/en/odds");
  await page.keyboard.press("g");
  await page.keyboard.press("t");
  await expect(page).toHaveURL(/\/en\/today$/);
});
```

- [ ] **Step 4: Run**

Run: `cd frontend && npm run test:e2e -- today.spec.ts jobs.spec.ts keyboard.spec.ts --project=chromium`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add frontend/tests/e2e/today.spec.ts frontend/tests/e2e/jobs.spec.ts frontend/tests/e2e/keyboard.spec.ts
git commit -m "test(frontend): add today/jobs/keyboard e2e specs"
```

---

### Task 9.5: i18n catalog additions

**Files:**
- Modify: `frontend/src/lib/i18n.ts`

- [ ] **Step 1: Add keys**

Open `frontend/src/lib/i18n.ts` and add new keys to both `enMessages` and `csMessages` objects. Add at minimum:

```
"nav.today": "Today" / "Dnes"
"nav.odds": "Odds" / "Kurzy"
"nav.matches": "Matches" / "Zápasy"
"nav.picks": "Picks" / "Tipy"
"nav.health": "Health" / "Stav"
"nav.models": "Models" / "Modely"
"nav.explore": "Explore" / "Průzkum"
"nav.jobs": "Jobs" / "Úlohy"
"nav.settings": "Settings" / "Nastavení"
"today.title": "Today · Cockpit" / "Dnes · Kokpit"
"today.heroPnl": "Model P&L · trailing 30d" / "Model P&L · posledních 30 dní"
"today.heroOpen": "Today · open picks" / "Dnes · otevřené tipy"
"today.heroQueue": "Scrape queue" / "Fronta scrapování"
"today.slate": "Today · slate" / "Dnes · seznam"
"settings.title": "Settings" / "Nastavení"
"settings.locale": "Locale" / "Jazyk"
"settings.refresh": "Auto-refresh" / "Automatická obnova"
"settings.scanlines": "CRT scanlines" / "CRT řádkování"
"empty.noPicks": "no open picks for today" / "žádné otevřené tipy"
"empty.loading": "loading…" / "načítání…"
"empty.noJobs": "no jobs" / "žádné úlohy"
```

Update the `MessageKey` type if it's declared explicitly. Replace hardcoded English strings in the new pages with `t("...")` calls — at minimum the page kickers and the empty-state strings.

- [ ] **Step 2: Build**

Run: `cd frontend && npm run build`
Expected: types pass; no missing-key errors.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/i18n.ts frontend/src/components/today frontend/src/components/matches frontend/src/components/jobs frontend/src/components/settings frontend/src/components/odds
git commit -m "feat(frontend): add i18n catalog entries for new pages"
```

---

### Task 9.6: Build SHA env wiring

**Files:**
- Modify: `frontend/next.config.js` (or `.mjs`)

- [ ] **Step 1: Inject the SHA at build time**

Read existing config. Add:

```js
const { execSync } = require("node:child_process");
let sha = "dev";
try { sha = execSync("git rev-parse --short HEAD").toString().trim(); } catch {}

module.exports = {
  // ...existing config
  env: {
    ...(existingEnv ?? {}),
    NEXT_PUBLIC_BUILD_SHA: sha
  }
};
```

If the config is TypeScript (`next.config.ts`), adapt syntax.

- [ ] **Step 2: Verify**

Run: `cd frontend && npm run build && grep -r "NEXT_PUBLIC_BUILD_SHA" .next 2>/dev/null | head -3`
Expected: the SHA is inlined.

- [ ] **Step 3: Commit**

```bash
git add frontend/next.config.js
git commit -m "build(frontend): inject git short SHA for status-bar display"
```

---

### Task 9.7: Final visual + build check

- [ ] **Step 1: Lint, type-check, build**

```bash
cd frontend
npm run lint
npm run build
```

Expected: clean.

- [ ] **Step 2: Manual smoke**

Run dev server (`npm run dev`) and click through each route:
- `/en/today` — hero + slate render; `?` overlay works; `g o` navigates to odds.
- `/en/odds` — event id form works; odds + stats render after submit.
- `/en/matches` — facets filter; row click opens detail.
- `/en/matches/<eventId>` — odds page loads pre-populated.
- `/en/picks/health` — charts render in terminal style.
- `/en/picks/models` — sortable table; row click opens deep dive.
- `/en/picks/models/<name>` — deep dive renders.
- `/en/picks/explore` — 3-up chart grid.
- `/en/jobs` — submit + cancel work.
- `/en/settings` — scanlines toggle works; refresh interval persists across reload.

For each route also verify: top bar visible, rail highlights the active item, bottom status bar shows clock + db rows + build SHA.

- [ ] **Step 3: Full e2e**

```bash
cd frontend && npm run test:e2e -- --project=chromium
```

Expected: green.

- [ ] **Step 4: Commit a tag/marker if you want**

No commit required if no files changed. Otherwise:

```bash
git commit --allow-empty -m "chore(frontend): terminal redesign rollout complete"
```

---

## Done

The frontend now ships as a unified terminal cockpit with TODAY landing page, left-rail navigation, keyboard-first interaction, manual refresh, and a small reusable design system at `frontend/src/components/terminal/`. Backend untouched; existing data hooks reused; e2e green.
