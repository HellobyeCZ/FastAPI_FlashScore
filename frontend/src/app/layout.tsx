import type { Metadata } from "next";
import type { ReactNode } from "react";
import "@/styles/globals.css";
import { LocaleProvider } from "@/contexts/LocaleContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { QueryProvider } from "@/contexts/QueryProvider";
import { AppShell } from "@/components/AppShell";

export const metadata: Metadata = {
  title: "FlashScore Dashboard",
  description:
    "Odds explorer, match statistics, and prediction model tracker powered by FastAPI and FlashScore data."
};

export default function RootLayout({
  children
}: {
  children: ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var t=localStorage.getItem("theme");var d=t==="dark"||(t!=="light"&&matchMedia("(prefers-color-scheme:dark)").matches);document.documentElement.setAttribute("data-theme",d?"dark":"light")}catch(e){}})()`,
          }}
        />
      </head>
      <body>
        <ThemeProvider>
          <LocaleProvider>
            <QueryProvider>
              <AppShell>{children}</AppShell>
            </QueryProvider>
          </LocaleProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
