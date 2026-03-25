import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { daysAgo, today, getSleepCollection } from "../../whoop/client.js";
import { mapSleepToDay, computeSleepTrend } from "../../compute/sleep.js";

export function registerSleepTool(server: McpServer): void {
  server.registerTool(
    "whoop_get_sleep_trend",
    {
      title: "Sleep Trend",
      description: "Get sleep trend data: duration, efficiency, consistency, and cumulative sleep debt over a time window.",
      inputSchema: {
        days: z.number().int().min(3).optional().default(14).describe("Number of days to look back. Minimum 3, default 14."),
      },
      outputSchema: {
        raw: z.object({
          daily_sleep: z.array(z.record(z.string(), z.unknown())),
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
        const sleepsResult = await getSleepCollection(daysAgo(days), today());
        const { records: sleeps } = sleepsResult;

        const warnings: string[] = sleepsResult.truncated
          ? ["Sleep data truncated at 50 pages — some history omitted"]
          : [];

        const sleepDays = sleeps.map(mapSleepToDay);
        const computed = computeSleepTrend(sleepDays);

        const structuredContent = {
          raw: { daily_sleep: sleepDays as unknown as Record<string, unknown>[] },
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
          content: [{ type: "text" as const, text: `Error fetching sleep trend: ${message}` }],
        };
      }
    }
  );
}
