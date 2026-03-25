import { getValidAccessToken } from "./auth.js";
import { config } from "../config.js";
import * as cache from "../db/cache.js";
import logger from "../logger.js";
import type {
  PaginatedResponse,
  UserProfile,
  BodyMeasurement,
  Cycle,
  Recovery,
  Sleep,
  Workout,
} from "./types.js";

const BASE_URL = "https://api.prod.whoop.com/developer";
const log = logger.child({ component: "whoop-api" });

// --- Private helpers ---

const REQUEST_TIMEOUT_MS = 30_000;

export interface PagedResult<T> {
  records: T[];
  truncated: boolean;
}

async function fetchWhoop<T>(
  endpoint: string,
  params?: Record<string, string>
): Promise<T> {
  const accessToken = await getValidAccessToken();
  const url = new URL(`${BASE_URL}${endpoint}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, value);
    }
  }

  log.info({ endpoint, params }, "API request");
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: globalThis.Response;
  try {
    response = await fetch(url.toString(), {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const body = await response.text();
    log.error({ endpoint, status: response.status, body: body.slice(0, 200) }, "API error");
    throw new Error(`Whoop API error ${response.status} on ${endpoint}: ${body}`);
  }

  log.info({ endpoint, status: response.status }, "API response");
  return (await response.json()) as T;
}

async function fetchAllPages<T>(
  endpoint: string,
  params?: Record<string, string>
): Promise<PagedResult<T>> {
  const allRecords: T[] = [];
  const queryParams = { ...params };
  let truncated = false;

  for (let page_num = 0; page_num < 50; page_num++) {
    const page = await fetchWhoop<PaginatedResponse<T>>(endpoint, queryParams);
    allRecords.push(...page.records);

    if (!page.next_token || page.records.length === 0) break;

    if (page_num === 49) {
      // 50-page limit reached with more data remaining
      truncated = true;
      log.warn(
        { endpoint, totalFetched: allRecords.length },
        "Pagination limit reached (50 pages); results are truncated"
      );
      break;
    }
    queryParams.nextToken = page.next_token;
  }

  return { records: allRecords, truncated };
}

function cacheTtlSeconds(): number {
  return config.cache.ttl_minutes * 60;
}

// --- Date helpers ---

export function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

export function today(): string {
  return new Date().toISOString();
}

// --- Public methods ---

export async function getProfile(): Promise<UserProfile> {
  const cacheKey = "profile";
  const cached = cache.get(cacheKey);
  if (cached) return cached as UserProfile;

  const data = await fetchWhoop<UserProfile>("/v2/user/profile/basic");
  cache.set(cacheKey, data, cacheTtlSeconds());
  return data;
}

export async function getBodyMeasurements(): Promise<BodyMeasurement> {
  const cacheKey = "body_measurement";
  const cached = cache.get(cacheKey);
  if (cached) return cached as BodyMeasurement;

  const data = await fetchWhoop<BodyMeasurement>("/v2/user/measurement/body");
  cache.set(cacheKey, data, cacheTtlSeconds());
  return data;
}

// Normalize an ISO timestamp to YYYY-MM-DD for stable, reusable cache keys.
// daysAgo()/today() embed milliseconds, so raw ISO strings would cause a cache miss on every call.
function datePart(iso: string): string {
  return iso.split("T")[0];
}

function cachedPagedResult<T>(cached: unknown): PagedResult<T> {
  // Handle old cache format (plain array) and new format ({ records, truncated })
  if (Array.isArray(cached)) return { records: cached as T[], truncated: false };
  return cached as PagedResult<T>;
}

export async function getCycles(start: string, end: string): Promise<PagedResult<Cycle>> {
  const cacheKey = `cycles:${datePart(start)}:${datePart(end)}`;
  const cached = cache.get(cacheKey);
  if (cached) return cachedPagedResult<Cycle>(cached);

  const result = await fetchAllPages<Cycle>("/v2/cycle", { start, end });
  cache.set(cacheKey, result, cacheTtlSeconds());
  return result;
}

export async function getRecoveryCollection(
  start: string,
  end: string
): Promise<PagedResult<Recovery>> {
  const cacheKey = `recovery:${datePart(start)}:${datePart(end)}`;
  const cached = cache.get(cacheKey);
  if (cached) return cachedPagedResult<Recovery>(cached);

  const result = await fetchAllPages<Recovery>("/v2/recovery", { start, end });
  cache.set(cacheKey, result, cacheTtlSeconds());
  return result;
}

export async function getSleepCollection(
  start: string,
  end: string
): Promise<PagedResult<Sleep>> {
  const cacheKey = `sleep:${datePart(start)}:${datePart(end)}`;
  const cached = cache.get(cacheKey);
  if (cached) return cachedPagedResult<Sleep>(cached);

  const result = await fetchAllPages<Sleep>("/v2/activity/sleep", { start, end });
  cache.set(cacheKey, result, cacheTtlSeconds());
  return result;
}

export async function getWorkoutCollection(
  start: string,
  end: string
): Promise<PagedResult<Workout>> {
  const cacheKey = `workout:${datePart(start)}:${datePart(end)}`;
  const cached = cache.get(cacheKey);
  if (cached) return cachedPagedResult<Workout>(cached);

  const result = await fetchAllPages<Workout>("/v2/activity/workout", { start, end });
  cache.set(cacheKey, result, cacheTtlSeconds());
  return result;
}
