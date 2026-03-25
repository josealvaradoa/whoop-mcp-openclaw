import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { daysAgo, today, getSleepCollection } from "../../whoop/client.js";
import { mapSleepToDay, computeSleepTrend } from "../../compute/sleep.js";

const sleepOutputSchema = z.object({
  raw: z.object({
    daily_sleep: z.array(
      z.object({
        date: z.string(),
        duration_hrs: z.number(),
        efficiency_pct: z.number(),
        performance_pct: z.number().nullable(),
        respiratory_rate: z.number().nullable(),
        stages: z.object({
          awake_hrs: z.number(),
          light_hrs: z.number(),
          slow_wave_hrs: z.number(),
          rem_hrs: z.number(),
        }),
      })
    ),
  }),
  computed: z.object({
    avg_duration_7d_hrs: z.number(),
    avg_efficiency_7d_pct: z.number(),
    sleep_debt_cumulative_hrs: z.number(),
    consistency_score: z.number(),
    trend: z.string(),
  }),
  _truncation_warning: z.string().optional(),
});

export function registerSleepTool(server: McpServer): void {
  server.registerTool(
    "whoop_get_sleep_trend",
    {
      title: "Sleep Trend",
      description: "Get sleep trend data: duration, efficiency, consistency, and cumulative sleep debt over a time window.",
      inputSchema: {
        days: z.number().int().min(3).optional().default(14).describe("Number of days to look back. Minimum 3, default 14."),
      },
      outputSchema: sleepOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ days }) => {
      try {
        const { data: sleeps, truncated } = await getSleepCollection(daysAgo(days), today());
        const sleepDays = sleeps.map(mapSleepToDay);
        const computed = computeSleepTrend(sleepDays);

        const structuredContent = {
          raw: { daily_sleep: sleepDays },
          computed,
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
          content: [{ type: "text" as const, text: `Error fetching sleep trend: ${message}` }],
        };
      }
    }
  );
}
