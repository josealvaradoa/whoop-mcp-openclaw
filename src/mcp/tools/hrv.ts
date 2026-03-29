import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { daysAgo, today, getRecoveryCollection, getCycles } from "../../whoop/client.js";
import { computeHrvTrend } from "../../compute/hrv.js";

export function registerHrvTool(server: McpServer): void {
  server.registerTool(
    "whoop_get_hrv_trend",
    {
      title: "HRV Trend",
      description: "Get heart rate variability (HRV) trend: baseline, current 7-day average, coefficient of variation, and trend direction. Key indicator of autonomic nervous system recovery and training readiness.",
      inputSchema: {
        days: z.number().int().min(7).optional().default(30).describe("Number of days to look back. Minimum 7, default 30."),
      },
      outputSchema: {
        raw: z.object({
          daily_hrv: z.array(z.object({
            date: z.string(),
            hrv_rmssd: z.number(),
          })),
        }),
        computed: z.record(z.string(), z.unknown()),
        warnings: z.array(z.string()).optional(),
      },
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
        const [recoveriesResult, cyclesResult] = await Promise.all([
          getRecoveryCollection(start, end),
          getCycles(start, end),
        ]);

        const { records: recoveries } = recoveriesResult;
        const { records: cycles } = cyclesResult;

        const warnings: string[] = [
          recoveriesResult.truncated && "Recovery data truncated at 50 pages — some history omitted",
          cyclesResult.truncated && "Cycle data truncated at 50 pages — some history omitted",
        ].filter((w): w is string => typeof w === "string");

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
          ...(warnings.length > 0 && { warnings }),
        };

        return {
          structuredContent,
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(structuredContent, null, 2),
            },
          ],
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
