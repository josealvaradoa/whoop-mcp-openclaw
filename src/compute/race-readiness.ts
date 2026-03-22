import { config } from "../config.js";
import type { Trend } from "./recovery.js";
import type { AcwrZone } from "./training-load.js";

export type FitnessTrend = "on_track" | "undertrained" | "overreaching" | "injury_risk";
export type FatigueStatus = "fresh" | "manageable" | "accumulating" | "critical";

export function getDaysToRace(): number {
  const raceDate = new Date(config.race.date);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  raceDate.setHours(0, 0, 0, 0);
  return Math.ceil((raceDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24));
}

export function getCurrentPhase(): string {
  const today = new Date().toISOString().split("T")[0];
  for (const phase of config.race.phases) {
    if (today >= phase.start && today <= phase.end) {
      return phase.name;
    }
  }
  return "off_season";
}

export function computeFitnessTrend(
  acwrZone: AcwrZone,
  recoveryTrend: Trend
): FitnessTrend {
  if (acwrZone === "danger") return "injury_risk";
  if (acwrZone === "caution") return "overreaching";
  if (acwrZone === "undertrained") return "undertrained";
  if (acwrZone === "optimal" && (recoveryTrend === "stable" || recoveryTrend === "improving")) {
    return "on_track";
  }
  return "on_track";
}

export function computeFatigueStatus(
  avg7d: number,
  avg30d: number,
  consecutiveRedDays: number
): FatigueStatus {
  if (consecutiveRedDays >= config.thresholds.consecutive_red_alert) return "critical";
  if (avg30d === 0) return "manageable";
  const diff = (avg7d - avg30d) / avg30d;
  if (diff > 0.1) return "fresh";
  if (diff > -0.1) return "manageable";
  return "accumulating";
}

export function computeKeyConcerns(data: {
  sleepDebtHrs: number;
  monotony: number;
  acwr: number | null;
  recoveryTrend: Trend;
  hrvTrend: Trend;
  weeklyVolumeHrs: number;
  currentPhase: string;
}): string[] {
  const concerns: string[] = [];
  const t = config.thresholds;

  if (data.sleepDebtHrs < -3) concerns.push("sleep_debt");
  if (data.monotony > 2.0) concerns.push("high_monotony");
  if (data.acwr !== null && data.acwr > t.acwr_danger) concerns.push("acwr_danger");
  else if (data.acwr !== null && data.acwr > t.acwr_optimal_high) concerns.push("acwr_high");
  if (data.recoveryTrend === "declining") concerns.push("declining_recovery");
  if (data.hrvTrend === "declining") concerns.push("declining_hrv");
  if (
    data.weeklyVolumeHrs < 5 &&
    (data.currentPhase === "build" || data.currentPhase === "peak")
  ) {
    concerns.push("low_volume");
  }

  return concerns;
}

export function buildWeeklySummary(data: {
  recoveryTrend: Trend;
  acwrZone: AcwrZone;
  acwr: number | null;
  concerns: string[];
  fatigueStatus: FatigueStatus;
}): string {
  const parts: string[] = [];

  // Recovery trend
  if (data.recoveryTrend === "improving") {
    parts.push("Recovery trending well.");
  } else if (data.recoveryTrend === "declining") {
    parts.push("Recovery has been declining.");
  } else {
    parts.push("Recovery is stable.");
  }

  // ACWR
  if (data.acwr !== null) {
    parts.push(`ACWR is ${data.acwr} (${data.acwrZone} zone).`);
  }

  // Concerns
  for (const c of data.concerns) {
    switch (c) {
      case "sleep_debt":
        parts.push("Sleep debt is accumulating — prioritize 8+ hrs next 3 nights.");
        break;
      case "high_monotony":
        parts.push("Training monotony is high — add more variety to sessions.");
        break;
      case "acwr_danger":
        parts.push("ACWR in danger zone — mandatory deload, reduce to 60% volume.");
        break;
      case "acwr_high":
        parts.push("ACWR elevated — consider reducing volume this week.");
        break;
      case "declining_recovery":
        parts.push("Recovery declining — consider an extra rest day.");
        break;
      case "declining_hrv":
        parts.push("HRV trending down — investigate sleep, stress, or alcohol.");
        break;
      case "low_volume":
        parts.push("Weekly volume is low for this training phase.");
        break;
    }
  }

  // Actionable recommendation
  if (data.concerns.length === 0) {
    parts.push("Continue current plan.");
  }

  return parts.join(" ");
}
