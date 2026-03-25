import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { daysAgo, today, getCycles, getRecoveryCollection, getSleepCollection, getWorkoutCollection } from "../../whoop/client.js";
import { config } from "../../config.js";
import { computeRecoveryTrend } from "../../compute/recovery.js";
import { computeHrvTrend } from "../../compute/hrv.js";
import { mapSleepToDay, computeSleepTrend } from "../../compute/sleep.js";
import { computeTrainingLoad } from "../../compute/training-load.js";
import {
  getDaysToRace,
  getCurrentPhase,
  computeFitnessTrend,
  computeFatigueStatus,
  computeKeyConcerns,
  buildWeeklySummary,
} from "../../compute/race-readiness.js";

export function registerRaceReadinessTool(server: McpServer): void {
  server.registerTool(
    "whoop_get_race_readiness",
    {
      title: "Race Readiness Assessment",
      description: "Get a comprehensive race readiness assessment: days to race, current training phase, fitness trend, fatigue status, key concerns, and a weekly summary. Uses the configured race date and periodization phases.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const start42d = daysAgo(42);
        const start30d = daysAgo(30);
        const start14d = daysAgo(14);
        const end = today();

        const [cycles, recoveries, sleeps, workouts] = await Promise.all([
          getCycles(start42d, end),
          getRecoveryCollection(start30d, end),
          getSleepCollection(start14d, end),
          getWorkoutCollection(daysAgo(7), end),
        ]);

        // Training load
        const strainValues = cycles.map((c) => c.score?.strain ?? 0);
        const trainingLoad = computeTrainingLoad(strainValues);

        // Recovery
        const recoveryResult = computeRecoveryTrend(recoveries);

        // HRV
        const hrvResult = computeHrvTrend(recoveries);

        // Sleep
        const sleepDays = sleeps.map(mapSleepToDay);
        const sleepResult = computeSleepTrend(sleepDays);

        // Weekly volume
        const weeklyVolumeHrs = workouts.reduce((sum, w) => {
          const dur = (new Date(w.end).getTime() - new Date(w.start).getTime()) / (1000 * 60 * 60);
          return sum + dur;
        }, 0);

        const currentPhase = getCurrentPhase();
        const fitnessTrend = computeFitnessTrend(trainingLoad.acwr_zone, recoveryResult.trend);
        const fatigueStatus = computeFatigueStatus(
          recoveryResult.avg_7d,
          recoveryResult.avg_30d,
          recoveryResult.consecutive_red_days
        );
        const concerns = computeKeyConcerns({
          sleepDebtHrs: sleepResult.sleep_debt_cumulative_hrs,
          monotony: trainingLoad.monotony,
          acwr: trainingLoad.acwr,
          recoveryTrend: recoveryResult.trend,
          hrvTrend: hrvResult.trend,
          weeklyVolumeHrs: Math.round(weeklyVolumeHrs * 10) / 10,
          currentPhase,
        });
        const weeklySummary = buildWeeklySummary({
          recoveryTrend: recoveryResult.trend,
          acwrZone: trainingLoad.acwr_zone,
          acwr: trainingLoad.acwr,
          concerns,
          fatigueStatus,
        });

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  computed: {
                    days_to_race: getDaysToRace(),
                    race_name: config.race.name,
                    race_date: config.race.date,
                    current_phase: currentPhase,
                    fitness_trend: fitnessTrend,
                    fatigue_status: fatigueStatus,
                    key_concerns: concerns,
                    weekly_summary: weeklySummary,
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error fetching race readiness: ${message}` }],
        };
      }
    }
  );
}
