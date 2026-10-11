import { NextResponse, type NextRequest } from "next/server";

const LOCALES = ["en", "cs"] as const;
const DEFAULT = "en";

function preferredLocale(req: NextRequest): string {
  const cookie = req.cookies.get("NEXT_LOCALE")?.value;
  if (cookie && (LOCALES as readonly string[]).includes(cookie)) return cookie;
  const accept = req.headers.get("accept-language") ?? "";
  for (const part of accept.split(",")) {
    const tag = part.split(";")[0].trim().toLowerCase().slice(0, 2);
    if ((LOCALES as readonly string[]).includes(tag)) return tag;
  }
  return DEFAULT;
}

/** Prefix locale-less paths: "/" → "/en/today", "/matches" → "/cs/matches". */
export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  const first = pathname.split("/")[1];
  if ((LOCALES as readonly string[]).includes(first)) return NextResponse.next();
  const locale = preferredLocale(req);
  const target = pathname === "/" ? `/${locale}/today` : `/${locale}${pathname}`;
  return NextResponse.redirect(new URL(`${target}${search}`, req.url));
}

export const config = {
  // Skip API routes, Next internals and files with an extension.
  matcher: ["/((?!api|_next|.*\\..*).*)"]
};
