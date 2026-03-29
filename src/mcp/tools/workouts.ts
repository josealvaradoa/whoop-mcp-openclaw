import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { daysAgo, today, getWorkoutCollection } from "../../whoop/client.js";

const MILLI_TO_MIN = 1 / (1000 * 60);

export function registerWorkoutsTool(server: McpServer): void {
  server.registerTool(
    "whoop_get_workouts",
    {
      title: "Workout History",
      description: "Get workout history with sport type, strain, duration, heart rate data, and HR zone distribution. Includes weekly volume and intensity analysis.",
      inputSchema: {
        days: z.number().int().min(1).optional().default(14).describe("Number of days to look back. Minimum 1, default 14."),
        sport: z.string().optional().describe("Filter by sport name (e.g. 'running', 'cycling', 'swimming'). Optional."),
      },
      outputSchema: {
        raw: z.object({
          workouts: z.array(z.record(z.string(), z.unknown())),
        }),
        computed: z.object({
          total_workouts: z.number(),
          weekly_volume_hrs: z.number(),
          weekly_strain_total: z.number(),
          sport_distribution: z.record(z.string(), z.number()),
          intensity_distribution: z.object({
            zone1_2_pct: z.number(),
            zone3_pct: z.number(),
            zone4_5_pct: z.number(),
          }),
        }),
        warnings: z.array(z.string()).optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ days, sport }) => {
      try {
        const workoutsResult = await getWorkoutCollection(daysAgo(days), today());
        const { records: workouts } = workoutsResult;

        const warnings: string[] = workoutsResult.truncated
          ? ["Workout data truncated at 50 pages — some history omitted"]
          : [];

        // Map to readable format — filter out unscored workouts
        const mapped = workouts
          .filter((w) => w.score_state === "SCORED" && w.score)
          .map((w) => {
            const zd = w.score.zone_durations;
            const durationMin = Math.round(
              (new Date(w.end).getTime() - new Date(w.start).getTime()) / (1000 * 60)
            );
            return {
              date: w.start.split("T")[0],
              sport: w.sport_name,
              strain: w.score.strain,
              duration_min: durationMin,
              avg_hr: w.score.average_heart_rate,
              max_hr: w.score.max_heart_rate,
              calories: Math.round(w.score.kilojoule * 0.239006),
              hr_zones_minutes: {
                zone1: Math.round(zd.zone_one_milli * MILLI_TO_MIN),
                zone2: Math.round(zd.zone_two_milli * MILLI_TO_MIN),
                zone3: Math.round(zd.zone_three_milli * MILLI_TO_MIN),
                zone4: Math.round(zd.zone_four_milli * MILLI_TO_MIN),
                zone5: Math.round(zd.zone_five_milli * MILLI_TO_MIN),
              },
            };
          });

        // Filter by sport if specified
        const filtered = sport
          ? mapped.filter((w) => w.sport.toLowerCase() === sport.toLowerCase())
          : mapped;

        // Compute: last 7 days only
        const sevenDaysAgo = new Date(daysAgo(7)).toISOString().split("T")[0];
        const last7 = filtered.filter((w) => w.date >= sevenDaysAgo);

        const weeklyVolumeHrs = Math.round(last7.reduce((s, w) => s + w.duration_min, 0) / 60 * 10) / 10;
        const weeklyStrainTotal = Math.round(last7.reduce((s, w) => s + w.strain, 0) * 10) / 10;

        // Sport distribution (full window)
        const sportDist: Record<string, number> = {};
        for (const w of filtered) {
          sportDist[w.sport] = (sportDist[w.sport] ?? 0) + 1;
        }

        // Intensity distribution (last 7 days)
        let z12 = 0, z3 = 0, z45 = 0;
        for (const w of last7) {
          const hz = w.hr_zones_minutes;
          z12 += hz.zone1 + hz.zone2;
          z3 += hz.zone3;
          z45 += hz.zone4 + hz.zone5;
        }
        const totalZone = z12 + z3 + z45;
        const intensityDist = totalZone > 0
          ? {
              zone1_2_pct: Math.round((z12 / totalZone) * 100),
              zone3_pct: Math.round((z3 / totalZone) * 100),
              zone4_5_pct: Math.round((z45 / totalZone) * 100),
            }
          : { zone1_2_pct: 0, zone3_pct: 0, zone4_5_pct: 0 };

        const structuredContent = {
          raw: { workouts: filtered as unknown as Record<string, unknown>[] },
          computed: {
            total_workouts: filtered.length,
            weekly_volume_hrs: weeklyVolumeHrs,
            weekly_strain_total: weeklyStrainTotal,
            sport_distribution: sportDist,
            intensity_distribution: intensityDist,
          },
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
          content: [{ type: "text" as const, text: `Error fetching workouts: ${message}` }],
        };
      }
    }
  );
}
