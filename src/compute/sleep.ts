import { config } from "../config.js";
import type { Sleep } from "../whoop/types.js";
import { mean, computeTrend, type Trend } from "./recovery.js";

const MILLI_TO_HRS = 1 / (1000 * 60 * 60);

function stddev(values: number[]): number {
  if (values.length < 2) return 0;
  const avg = mean(values);
  const squaredDiffs = values.map((v) => (v - avg) ** 2);
  return Math.sqrt(mean(squaredDiffs));
}

export interface SleepDayData {
  date: string;
  duration_hrs: number;
  efficiency_pct: number | null;
  performance_pct: number | null;
  respiratory_rate: number | null;
  stages: {
    awake_hrs: number;
    light_hrs: number;
    slow_wave_hrs: number;
    rem_hrs: number;
  };
}

export function mapSleepToDay(s: Sleep): SleepDayData {
  const ss = s.score.stage_summary;
  const totalSleep =
    ss.total_light_sleep_time_milli +
    ss.total_slow_wave_sleep_time_milli +
    ss.total_rem_sleep_time_milli;

  return {
    date: s.start.split("T")[0],
    duration_hrs: Math.round(totalSleep * MILLI_TO_HRS * 100) / 100,
    efficiency_pct: s.score.sleep_efficiency_percentage,
    performance_pct: s.score.sleep_performance_percentage,
    respiratory_rate: s.score.respiratory_rate,
    stages: {
      awake_hrs: Math.round(ss.total_awake_time_milli * MILLI_TO_HRS * 100) / 100,
      light_hrs: Math.round(ss.total_light_sleep_time_milli * MILLI_TO_HRS * 100) / 100,
      slow_wave_hrs: Math.round(ss.total_slow_wave_sleep_time_milli * MILLI_TO_HRS * 100) / 100,
      rem_hrs: Math.round(ss.total_rem_sleep_time_milli * MILLI_TO_HRS * 100) / 100,
    },
  };
}

export function computeSleepTrend(sleepDays: SleepDayData[]) {
  const last7 = sleepDays.slice(0, 7);
  const prev7 = sleepDays.slice(7, 14);

  const durations7d = last7.map((d) => d.duration_hrs);
  const efficiencies7d = last7
    .map((d) => d.efficiency_pct)
    .filter((e): e is number => e != null);

  const avgDuration7d = Math.round(mean(durations7d) * 10) / 10;
  const avgEfficiency7d = Math.round(mean(efficiencies7d));

  const target = config.athlete.sleep_target_hrs;
  const sleepDebtCumulative =
    Math.round(last7.reduce((sum, d) => sum + (d.duration_hrs - target), 0) * 10) / 10;

  // Consistency: 1.0 - normalized stddev of sleep durations as proxy
  let consistencyScore = 1.0;
  if (durations7d.length >= 2) {
    const durationStddev = stddev(durations7d);
    const normalized = avgDuration7d > 0 ? durationStddev / avgDuration7d : 0;
    consistencyScore = Math.round(Math.max(0, 1.0 - normalized) * 100) / 100;
  }

  const prevDurations = prev7.map((d) => d.duration_hrs);
  const trend: Trend =
    prev7.length >= 3
      ? computeTrend(mean(durations7d), mean(prevDurations))
      : "stable";

  return {
    avg_duration_7d_hrs: avgDuration7d,
    avg_efficiency_7d_pct: avgEfficiency7d,
    sleep_debt_cumulative_hrs: sleepDebtCumulative,
    consistency_score: consistencyScore,
    trend,
  };
}
