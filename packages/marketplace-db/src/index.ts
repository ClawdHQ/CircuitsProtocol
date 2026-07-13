import { PrismaClient } from "@prisma/client";

// Standard Next.js/Prisma singleton pattern: without it, every hot-reload in dev creates a
// fresh PrismaClient (and a fresh connection pool) without closing the last one.
const globalForPrisma = globalThis as unknown as { __clawdhqMarketplacePrisma?: PrismaClient };

export const prisma = globalForPrisma.__clawdhqMarketplacePrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.__clawdhqMarketplacePrisma = prisma;
}

export * from "@prisma/client";
