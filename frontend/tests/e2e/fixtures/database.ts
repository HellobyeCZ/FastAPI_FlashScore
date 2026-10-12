import path from "node:path";

/**
 * Point the app's Prisma client at `dbUrl` for this test worker.
 *
 * src/server/prisma caches one client on globalThis and Node caches the
 * modules that imported it, so a second spec in the same worker would
 * otherwise reuse the first spec's (possibly deleted) database. Clearing both
 * makes the next require() of a route handler bind to the new file.
 */
export function bindDatabase(dbUrl: string): void {
  process.env.DATABASE_URL = dbUrl;
  const g = globalThis as { prisma?: unknown; prismaAdapter?: unknown };
  delete g.prisma;
  delete g.prismaAdapter;
  const src = path.resolve(__dirname, "../../../src") + path.sep;
  for (const key of Object.keys(require.cache)) {
    if (key.startsWith(src)) delete require.cache[key];
  }
}
