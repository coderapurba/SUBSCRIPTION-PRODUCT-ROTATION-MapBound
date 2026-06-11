import { PrismaClient } from "@prisma/client";

const globalForPrisma = global;

function buildDatabaseUrl() {
  const url = process.env.DATABASE_URL ?? "";
  // Serverless: limit each function instance to 1 connection to avoid exhausting
  // the Prisma Postgres free-tier connection limit across concurrent invocations.
  if (process.env.NODE_ENV === "production" && !url.includes("connection_limit")) {
    return `${url}&connection_limit=2&pool_timeout=20`;
  }
  return url;
}

const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
    datasources: { db: { url: buildDatabaseUrl() } },
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = db;
}

export default db;
