import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { daysAgo, today, getRecoveryCollection } from "../../whoop/client.js";
import { computeHrvTrend } from "../../compute/hrv.js";

export function registerHrvTool(server: McpServer): void {
  server.tool(
    "get_hrv_trend",
    "Get heart rate variability trend: baseline, current average, coefficient of variation, and trend direction. Key indicator of autonomic nervous system recovery.",
    { days: z.number().optional().default(30).describe("Number of days to look back. Default 30.") },
    async ({ days }) => {
      const recoveries = await getRecoveryCollection(daysAgo(days), today());

      const dailyHrv = recoveries.map((r) => ({
        date: new Date(r.cycle_id).toISOString().split("T")[0],
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
