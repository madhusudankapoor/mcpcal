import fs from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";

/* ---------------------------------------------------------------------------
 * Global daily request limit — protects against runaway LLM costs.
 * Counter stored in a local JSON file; resets each calendar day (or on redeploy).
 * --------------------------------------------------------------------------- */

export const DAILY_REQUEST_LIMIT = Number(process.env.DAILY_REQUEST_LIMIT ?? "1000");
const DAILY_LIMIT_FILE = path.resolve(process.cwd(), "daily-usage.json");

interface DailyUsage {
  date: string;   // "YYYY-MM-DD"
  count: number;
}

function todayDateString(): string {
  return new Date().toISOString().slice(0, 10);
}

export function getDailyUsage(): DailyUsage {
  try {
    const raw = fs.readFileSync(DAILY_LIMIT_FILE, "utf-8");
    const data = JSON.parse(raw) as DailyUsage;
    if (data.date === todayDateString()) {
      return data;
    }
  } catch {
    // File missing or corrupt — start fresh.
  }
  return { date: todayDateString(), count: 0 };
}

function incrementDailyUsage(): DailyUsage {
  const usage = getDailyUsage();
  usage.count += 1;
  fs.writeFileSync(DAILY_LIMIT_FILE, JSON.stringify(usage), "utf-8");
  return usage;
}

export function isDailyLimitReached(): boolean {
  return getDailyUsage().count >= DAILY_REQUEST_LIMIT;
}

/** Middleware that enforces the global daily request cap on LLM endpoints. */
export function dailyLimitMiddleware(_req: Request, res: Response, next: NextFunction): void {
  if (isDailyLimitReached()) {
    res.status(429).json({
      error: `Daily demo limit reached (${String(DAILY_REQUEST_LIMIT)} requests). Come back tomorrow!`
    });
    return;
  }
  incrementDailyUsage();
  next();
}
