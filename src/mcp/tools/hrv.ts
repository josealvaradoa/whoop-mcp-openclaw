import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { daysAgo, today, getRecoveryCollection, getCycles } from "../../whoop/client.js";
import { computeHrvTrend } from "../../compute/hrv.js";

const hrvOutputSchema = z.object({
  raw: z.object({
    daily_hrv: z.array(
      z.object({
        date: z.string(),
        hrv_rmssd: z.number(),
      })
    ),
  }),
  computed: z.object({
    baseline_30d: z.number(),
    current_7d_avg: z.number(),
    cv_pct: z.number(),
    trend: z.string(),
    above_baseline: z.boolean(),
  }),
  _truncation_warning: z.string().optional(),
});

export function registerHrvTool(server: McpServer): void {
  server.registerTool(
    "whoop_get_hrv_trend",
    {
      title: "HRV Trend",
      description: "Get heart rate variability (HRV) trend: baseline, current 7-day average, coefficient of variation, and trend direction. Key indicator of autonomic nervous system recovery and training readiness.",
      inputSchema: {
        days: z.number().int().min(7).optional().default(30).describe("Number of days to look back. Minimum 7, default 30."),
      },
      outputSchema: hrvOutputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ days }) => {
      try {
        const start = daysAgo(days);
        const end = today();
        const [
          { data: recoveries, truncated: t1 },
          { data: cycles, truncated: t2 },
        ] = await Promise.all([
          getRecoveryCollection(start, end),
          getCycles(start, end),
        ]);
        const truncated = t1 || t2;

        const cycleDateMap = new Map(cycles.map((c) => [c.id, c.start.split("T")[0]]));

        const dailyHrv = recoveries
          .filter((r) => cycleDateMap.has(r.cycle_id))
          .map((r) => ({
            date: cycleDateMap.get(r.cycle_id)!,
            hrv_rmssd: r.score.hrv_rmssd_milli,
          }));

        const computed = computeHrvTrend(recoveries);

        const structuredContent = {
          raw: { daily_hrv: dailyHrv },
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
          content: [{ type: "text" as const, text: `Error fetching HRV trend: ${message}` }],
        };
      }
    }
  );
}
