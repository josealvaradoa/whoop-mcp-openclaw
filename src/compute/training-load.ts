import { config } from "../config.js";
import { mean } from "./recovery.js";

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const squaredDiffs = values.map((v) => (v - avg) ** 2);
  return Math.sqrt(mean(squaredDiffs));
}

export type AcwrZone = "undertrained" | "optimal" | "caution" | "danger";
export type TrendDirection = "building" | "maintaining" | "tapering" | "deloading";

export function computeTrainingLoad(dailyStrains: number[]) {
  const last7 = dailyStrains.slice(0, 7);
  const last28 = dailyStrains.slice(0, 28);
  const prev7 = dailyStrains.slice(7, 14);

  const acuteLoad = Math.round(mean(last7) * 100) / 100;
  const chronicLoad = Math.round(mean(last28) * 100) / 100;

  const acwr = chronicLoad > 0 ? Math.round((acuteLoad / chronicLoad) * 100) / 100 : null;

  let acwrZone: AcwrZone = "optimal";
  if (acwr !== null) {
    const { acwr_optimal_low, acwr_optimal_high, acwr_danger } = config.thresholds;
    if (acwr < acwr_optimal_low) acwrZone = "undertrained";
    else if (acwr <= acwr_optimal_high) acwrZone = "optimal";
    else if (acwr < acwr_danger) acwrZone = "caution";
    else acwrZone = "danger";
  }

  const sd7 = stddev(last7);
  const monotony = sd7 > 0 ? Math.round((mean(last7) / sd7) * 100) / 100 : 0;

  const trainingStrain7d = Math.round(last7.reduce((a, b) => a + b, 0) * 10) / 10;

  let trendDirection: TrendDirection = "maintaining";
  if (prev7.length >= 7) {
    const currentAvg = mean(last7);
    const prevAvg = mean(prev7);
    if (prevAvg > 0) {
      const change = (currentAvg - prevAvg) / prevAvg;
      if (change < -0.2) trendDirection = "deloading";
      else if (change < -0.1) trendDirection = "tapering";
      else if (change > 0.1) trendDirection = "building";
    }
  }

  return {
    acute_load_7d: acuteLoad,
    chronic_load_28d: chronicLoad,
    acwr,
    acwr_zone: acwrZone,
    monotony,
    training_strain_7d: trainingStrain7d,
    trend_direction: trendDirection,
  };
}
