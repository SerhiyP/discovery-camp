import { Db, MongoClient } from "mongodb";
import { config } from "./config";

export const COLLECTIONS = {
  masterclasses: "masterclasses",
  mcSchedule: "mcSchedule",
  mcTopics: "mcTopics",
  registrations: "registrations",
  visitors: "visitors",
  mcSeats: "mcSeats",
  campSchedule: "campSchedule",
  phishCatches: "phishCatches",
  phishScans: "phishScans",
} as const;

export function mongoEnabled(): boolean {
  return !!config.mongoUri;
}

// One client per serverless instance, reused across invocations. Vercel spawns many
// lambdas under load, so a per-request client would exhaust the Atlas connection limit.
// The object is created lazily and connect() is never awaited at module scope —
// api/bot.ts has maxDuration 10, and import-time work is paid by every cold start.
let client: MongoClient | null = null;
let connecting: Promise<Db> | null = null;

export async function db(): Promise<Db> {
  if (!config.mongoUri) throw new Error("MONGO_URI is not configured");
  if (connecting) return connecting;
  connecting = (async () => {
    client = new MongoClient(config.mongoUri, {
      maxPoolSize: 5,
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 5000,
    });
    await client.connect();
    return client.db(config.mongoDb);
  })();
  try {
    return await connecting;
  } catch (err) {
    // Let the next request retry instead of caching a failed connection forever.
    connecting = null;
    client = null;
    throw err;
  }
}
