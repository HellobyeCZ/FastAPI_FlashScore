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
