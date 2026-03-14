"use client";

import { useState } from "react";
import { Sidebar } from "@/components/Sidebar";

export function AppShell({ children }: { children: React.ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="flex h-screen overflow-hidden bg-[var(--color-brand-surface)]">
      <Sidebar isOpen={sidebarOpen} onClose={() => setSidebarOpen(false)} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <header className="flex h-14 items-center border-b border-[var(--sidebar-border)] bg-[var(--color-brand-surface-alt)] px-4 md:hidden">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            className="rounded-lg p-2 text-[var(--color-text-muted)] transition hover:bg-[var(--sidebar-hover)] hover:text-[var(--color-text-high)]"
            aria-label="Open navigation"
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 12h18M3 6h18M3 18h18" />
            </svg>
          </button>
          <span className="ml-3 text-sm font-bold text-[var(--color-text-high)]">FlashScore</span>
        </header>
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[var(--max-content-width)] px-6 py-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
