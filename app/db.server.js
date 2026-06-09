import { PrismaClient } from "@prisma/client";

// Prevent multiple Prisma instances in development (HMR reloads)
const globalForPrisma = global;

const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}

export default db;
