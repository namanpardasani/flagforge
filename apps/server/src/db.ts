import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../generated/prisma/client.js";

const connectionString = process.env["DATABASE_URL"];
if (!connectionString) {
  throw new Error(
    "DATABASE_URL is not set. Copy apps/server/.env.example to apps/server/.env and fill it in.",
  );
}

// One shared client for the whole server: it owns a pool of Postgres connections.
const adapter = new PrismaPg({ connectionString });
export const prisma = new PrismaClient({ adapter });
