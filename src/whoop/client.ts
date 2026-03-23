import { getValidAccessToken } from "./auth.js";
import { config } from "../config.js";
import * as cache from "../db/cache.js";
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

// --- Private helpers ---

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

  const response = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Whoop API error ${response.status} on ${endpoint}: ${body}`);
  }

  return (await response.json()) as T;
}

async function fetchAllPages<T>(
  endpoint: string,
  params?: Record<string, string>
): Promise<T[]> {
  const allRecords: T[] = [];
  const queryParams = { ...params };

  for (;;) {
    const page = await fetchWhoop<PaginatedResponse<T>>(endpoint, queryParams);
    allRecords.push(...page.records);

    if (!page.next_token) break;
    queryParams.next_token = page.next_token;
  }

  return allRecords;
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

export async function getCycles(start: string, end: string): Promise<Cycle[]> {
  const cacheKey = `cycles:${start}:${end}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached as Cycle[];

  const data = await fetchAllPages<Cycle>("/v2/cycle", { start, end });
  cache.set(cacheKey, data, cacheTtlSeconds());
  return data;
}

export async function getRecoveryCollection(
  start: string,
  end: string
): Promise<Recovery[]> {
  const cacheKey = `recovery:${start}:${end}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached as Recovery[];

  const data = await fetchAllPages<Recovery>("/v2/recovery", { start, end });
  cache.set(cacheKey, data, cacheTtlSeconds());
  return data;
}

export async function getSleepCollection(
  start: string,
  end: string
): Promise<Sleep[]> {
  const cacheKey = `sleep:${start}:${end}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached as Sleep[];

  const data = await fetchAllPages<Sleep>("/v2/activity/sleep", { start, end });
  cache.set(cacheKey, data, cacheTtlSeconds());
  return data;
}

export async function getWorkoutCollection(
  start: string,
  end: string
): Promise<Workout[]> {
  const cacheKey = `workout:${start}:${end}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached as Workout[];

  const data = await fetchAllPages<Workout>("/v2/activity/workout", { start, end });
  cache.set(cacheKey, data, cacheTtlSeconds());
  return data;
}
