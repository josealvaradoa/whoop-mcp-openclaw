import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { daysAgo, today, getSleepCollection } from "../../whoop/client.js";
import { mapSleepToDay, computeSleepTrend } from "../../compute/sleep.js";

export function registerSleepTool(server: McpServer): void {
  server.tool(
    "get_sleep_trend",
    "Get sleep trend data: duration, efficiency, consistency, and cumulative sleep debt over a time window.",
    { days: z.number().optional().default(14).describe("Number of days to look back. Default 14.") },
    async ({ days }) => {
      const sleeps = await getSleepCollection(daysAgo(days), today());
      const sleepDays = sleeps.map(mapSleepToDay);
      const computed = computeSleepTrend(sleepDays);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ raw: { daily_sleep: sleepDays }, computed }, null, 2),
          },
        ],
      };
    }
  );
}
