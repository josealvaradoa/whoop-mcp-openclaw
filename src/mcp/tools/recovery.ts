import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { daysAgo, today, getRecoveryCollection, getCycles } from "../../whoop/client.js";
import { computeRecoveryTrend } from "../../compute/recovery.js";

export function registerRecoveryTool(server: McpServer): void {
  server.tool(
    "get_recovery_trend",
    "Get recovery score trend over a time window. Includes rolling averages, trend direction, and consecutive green/yellow/red day counts.",
    { days: z.number().optional().default(30).describe("Number of days to look back. Default 30.") },
    async ({ days }) => {
      const start = daysAgo(days);
      const end = today();
      const [recoveries, cycles] = await Promise.all([
        getRecoveryCollection(start, end),
        getCycles(start, end),
      ]);

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

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ raw: { daily_recovery: dailyRecovery }, computed }, null, 2),
          },
        ],
      };
    }
  );
}
