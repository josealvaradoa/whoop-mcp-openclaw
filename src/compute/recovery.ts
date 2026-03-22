import { config } from "../config.js";
import type { Recovery } from "../whoop/types.js";

export type Readiness = "green" | "yellow" | "red";
export type Recommendation = "full_training" | "reduced_intensity" | "active_recovery_only";
export type Trend = "improving" | "declining" | "stable";

export function getReadiness(recoveryScore: number): Readiness {
  if (recoveryScore >= config.thresholds.recovery_yellow) return "green";
  if (recoveryScore >= config.thresholds.recovery_red) return "yellow";
  return "red";
}

export function getRecommendation(readiness: Readiness): Recommendation {
  if (readiness === "green") return "full_training";
  if (readiness === "yellow") return "reduced_intensity";
  return "active_recovery_only";
}

export function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function computeTrend(shortAvg: number, longAvg: number): Trend {
  if (longAvg === 0) return "stable";
  const diff = (shortAvg - longAvg) / longAvg;
  if (diff > 0.05) return "improving";
  if (diff < -0.05) return "declining";
  return "stable";
}

export function computeRecoveryTrend(recoveries: Recovery[]) {
  const scores = recoveries.map((r) => r.score.recovery_score);

  const last7 = scores.slice(0, 7);
  const last30 = scores.slice(0, 30);

  const avg7d = Math.round(mean(last7));
  const avg30d = Math.round(mean(last30));
  const trend = computeTrend(mean(last7), mean(last30));

  // Count consecutive days in each zone (from most recent)
  let consecutiveRed = 0;
  let consecutiveYellow = 0;
  let consecutiveGreen = 0;
  if (scores.length > 0) {
    const firstReadiness = getReadiness(scores[0]);
    for (const score of scores) {
      const r = getReadiness(score);
      if (r !== firstReadiness) break;
      if (r === "red") consecutiveRed++;
      else if (r === "yellow") consecutiveYellow++;
      else consecutiveGreen++;
    }
  }

  return {
    avg_7d: avg7d,
    avg_30d: avg30d,
    trend,
    consecutive_red_days: consecutiveRed,
    consecutive_yellow_days: consecutiveYellow,
    consecutive_green_days: consecutiveGreen,
  };
}

export function computeBaselineComparison(
  todayValue: number,
  values30d: number[]
): number {
  const baseline = mean(values30d);
  if (baseline === 0) return 0;
  return Math.round(((todayValue - baseline) / baseline) * 1000) / 10;
}
