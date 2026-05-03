import { PrismaClient } from "@prisma/client";

// Lazily instantiated so Next.js can statically collect API routes at build
// time (when DATABASE_URL isn't set) without throwing. Routes that touch the
// DB should also export `dynamic = "force-dynamic"` to opt out of static
// collection — the lazy `getPrisma()` call here is a belt-and-braces guard.

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

export function getPrisma(): PrismaClient {
  if (globalForPrisma.prisma) return globalForPrisma.prisma;
  if (!process.env.DATABASE_URL) {
    throw new Error("Missing DATABASE_URL environment variable for Prisma.");
  }
  const client = new PrismaClient({ log: ["error"] });
  if (process.env.NODE_ENV !== "production") {
    globalForPrisma.prisma = client;
  }
  return client;
}

// Backwards-compatible default export. Reading this triggers instantiation,
// so callers in module top-level code should use getPrisma() instead.
export const prisma = new Proxy({} as PrismaClient, {
  get(_target, prop) {
    return Reflect.get(getPrisma(), prop);
  },
});
