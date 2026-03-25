import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { daysAgo, today, getRecoveryCollection, getCycles } from "../../whoop/client.js";
import { computeRecoveryTrend } from "../../compute/recovery.js";

export function registerRecoveryTool(server: McpServer): void {
  server.registerTool(
    "whoop_get_recovery_trend",
    {
      title: "Recovery Score Trend",
      description: "Get recovery score trend over a time window. Includes 7-day and 30-day rolling averages, trend direction (improving/stable/declining), and consecutive green/yellow/red day counts.",
      inputSchema: {
        days: z.number().int().min(7).optional().default(30).describe("Number of days to look back. Minimum 7, default 30."),
      },
      outputSchema: {
        raw: z.object({
          daily_recovery: z.array(z.object({
            date: z.string(),
            score: z.number(),
            hrv_rmssd: z.number(),
            resting_heart_rate: z.number(),
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

        const dailyRecovery = recoveries
          .filter((r) => cycleDateMap.has(r.cycle_id))
          .map((r) => ({
            date: cycleDateMap.get(r.cycle_id)!,
            score: r.score.recovery_score,
            hrv_rmssd: r.score.hrv_rmssd_milli,
            resting_heart_rate: r.score.resting_heart_rate,
          }));

        const computed = computeRecoveryTrend(recoveries);

        const structuredContent = {
          raw: { daily_recovery: dailyRecovery },
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
          content: [{ type: "text" as const, text: `Error fetching recovery trend: ${message}` }],
        };
      }
    }
  );
}
