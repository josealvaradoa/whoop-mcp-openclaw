import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { daysAgo, today, getCycles, getRecoveryCollection, getSleepCollection } from "../../whoop/client.js";
import { config } from "../../config.js";
import {
  getReadiness,
  getRecommendation,
  computeBaselineComparison,
} from "../../compute/recovery.js";
import { mapSleepToDay } from "../../compute/sleep.js";

const overviewOutputSchema = z.object({
  raw: z.object({
    recovery_score: z.number(),
    hrv_rmssd: z.number(),
    resting_heart_rate: z.number(),
    spo2_pct: z.number().nullable(),
    skin_temp_celsius: z.number().nullable(),
    sleep_performance_pct: z.number().nullable(),
    sleep_duration_hrs: z.number().nullable(),
    sleep_efficiency_pct: z.number().nullable(),
    day_strain: z.number(),
    day_calories: z.number(),
  }),
  computed: z.object({
    readiness: z.string(),
    hrv_vs_baseline_pct: z.number().nullable(),
    rhr_vs_baseline_pct: z.number().nullable(),
    sleep_debt_hrs: z.number(),
    recommendation: z.string(),
  }),
  _truncation_warning: z.string().optional(),
});

export function registerOverviewTool(server: McpServer): void {
  server.registerTool(
    "whoop_get_today_overview",
    {
      title: "Today's Whoop Overview",
      description: "Get today's Whoop overview: recovery score, HRV, resting heart rate, SpO2, skin temperature, sleep score, sleep duration, strain, and calories. Includes computed readiness assessment (green/yellow/red) and comparison to 30-day baselines.",
      inputSchema: {},
      outputSchema: overviewOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async () => {
      try {
        const start = daysAgo(1);
        const end = today();
        const start30d = daysAgo(30);

        const [
          { data: cycles, truncated: t1 },
          { data: recoveries, truncated: t2 },
          { data: sleeps, truncated: t3 },
          { data: recoveries30d, truncated: t4 },
        ] = await Promise.all([
          getCycles(start, end),
          getRecoveryCollection(start, end),
          getSleepCollection(start, end),
          getRecoveryCollection(start30d, end),
        ]);
        const truncated = t1 || t2 || t3 || t4;

        const todayCycle = cycles[0];
        const todayRecovery = recoveries[0];
        const todaySleep = sleeps[0];

        const recoveryScore = todayRecovery?.score.recovery_score ?? 0;
        const hrvRmssd = todayRecovery?.score.hrv_rmssd_milli ?? 0;
        const rhr = todayRecovery?.score.resting_heart_rate ?? 0;
        const spo2 = todayRecovery?.score.spo2_percentage ?? null;
        const skinTemp = todayRecovery?.score.skin_temp_celsius ?? null;

        const sleepDay = todaySleep ? mapSleepToDay(todaySleep) : null;
        const sleepPerfPct = todaySleep?.score.sleep_performance_percentage ?? null;
        const sleepEffPct = todaySleep?.score.sleep_efficiency_percentage ?? null;

        const strain = todayCycle?.score?.strain ?? 0;
        const calories = todayCycle?.score
          ? Math.round(todayCycle.score.kilojoule * 0.239006)
          : 0;

        const readiness = getReadiness(recoveryScore);
        const recommendation = getRecommendation(readiness);

        const hrvValues30d = recoveries30d.map((r) => r.score.hrv_rmssd_milli);
        const rhrValues30d = recoveries30d.map((r) => r.score.resting_heart_rate);

        const hrvVsBaseline = computeBaselineComparison(hrvRmssd, hrvValues30d);
        const rhrVsBaseline = computeBaselineComparison(rhr, rhrValues30d);
        const sleepDebtHrs = sleepDay
          ? Math.round((sleepDay.duration_hrs - config.athlete.sleep_target_hrs) * 10) / 10
          : 0;

        const structuredContent = {
          raw: {
            recovery_score: recoveryScore,
            hrv_rmssd: hrvRmssd,
            resting_heart_rate: rhr,
            spo2_pct: spo2,
            skin_temp_celsius: skinTemp,
            sleep_performance_pct: sleepPerfPct,
            sleep_duration_hrs: sleepDay?.duration_hrs ?? null,
            sleep_efficiency_pct: sleepEffPct,
            day_strain: strain,
            day_calories: calories,
          },
          computed: {
            readiness,
            hrv_vs_baseline_pct: hrvVsBaseline,
            rhr_vs_baseline_pct: rhrVsBaseline,
            sleep_debt_hrs: sleepDebtHrs,
            recommendation,
          },
          ...(truncated && {
            _truncation_warning: "Some data pages were truncated at the 50-page API limit. Results may be incomplete.",
          }),
        };

        return {
          structuredContent,
          content: [{ type: "text" as const, text: JSON.stringify(structuredContent, null, 2) }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Error fetching today's overview: ${message}` }],
        };
      }
    }
  );
}
