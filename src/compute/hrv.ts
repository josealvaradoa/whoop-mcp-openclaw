import type { Recovery } from "../whoop/types.js";
import { mean, computeTrend, type Trend } from "./recovery.js";

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const squaredDiffs = values.map((v) => (v - avg) ** 2);
  return Math.sqrt(mean(squaredDiffs));
}

export function computeHrvTrend(recoveries: Recovery[]) {
  const hrvValues = recoveries.map((r) => r.score.hrv_rmssd_milli);

  const last7 = hrvValues.slice(0, 7);
  const last30 = hrvValues.slice(0, 30);

  const baseline30d = Math.round(mean(last30) * 10) / 10;
  const current7dAvg = Math.round(mean(last7) * 10) / 10;
  const sd = stddev(last7);
  const cvPct = current7dAvg > 0 ? Math.round((sd / mean(last7)) * 1000) / 10 : 0;
  const trend: Trend = computeTrend(mean(last7), mean(last30));
  const aboveBaseline = current7dAvg > baseline30d;

  return {
    baseline_30d: baseline30d,
    current_7d_avg: current7dAvg,
    cv_pct: cvPct,
    trend,
    above_baseline: aboveBaseline,
  };
}
