import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { daysAgo, today, getRecoveryCollection, getCycles } from "../../whoop/client.js";
import { computeHrvTrend } from "../../compute/hrv.js";

export function registerHrvTool(server: McpServer): void {
  server.tool(
    "get_hrv_trend",
    "Get heart rate variability trend: baseline, current average, coefficient of variation, and trend direction. Key indicator of autonomic nervous system recovery.",
    { days: z.number().optional().default(30).describe("Number of days to look back. Default 30.") },
    async ({ days }) => {
      const start = daysAgo(days);
      const end = today();
      const [recoveries, cycles] = await Promise.all([
        getRecoveryCollection(start, end),
        getCycles(start, end),
      ]);

      const cycleDateMap = new Map(cycles.map((c) => [c.id, c.start.split("T")[0]]));

      const dailyHrv = recoveries.map((r) => ({
        date: cycleDateMap.get(r.cycle_id) ?? "unknown",
        hrv_rmssd: r.score.hrv_rmssd_milli,
      }));

      const computed = computeHrvTrend(recoveries);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ raw: { daily_hrv: dailyHrv }, computed }, null, 2),
          },
        ],
      };
    }
  );
}
