import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { daysAgo, today, getCycles } from "../../whoop/client.js";
import { computeTrainingLoad } from "../../compute/training-load.js";

export function registerTrainingLoadTool(server: McpServer): void {
  server.tool(
    "get_training_load",
    "Get training load analysis: 7-day acute load, 28-day chronic load, acute-to-chronic workload ratio (ACWR), training monotony, and trend direction. Critical for injury prevention and periodization decisions.",
    { days: z.number().optional().default(42).describe("Number of days of strain history to use for calculation. Minimum 28. Default 42.") },
    async ({ days }) => {
      const effectiveDays = Math.max(days, 28);
      const cycles = await getCycles(daysAgo(effectiveDays), today());

      const dailyStrain = cycles.map((c) => ({
        date: c.start.split("T")[0],
        strain: c.score?.strain ?? 0,
      }));

      const strainValues = dailyStrain.map((d) => d.strain);
      const computed = computeTrainingLoad(strainValues);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ raw: { daily_strain: dailyStrain }, computed }, null, 2),
          },
        ],
      };
    }
  );
}
