// Core pagination wrapper
export interface PaginatedResponse<T> {
  records: T[];
  next_token: string | null;
}

// User profile
export interface UserProfile {
  user_id: number;
  first_name: string;
  last_name: string;
  email: string;
}

// Body measurements
export interface BodyMeasurement {
  height_meter: number;
  weight_kilogram: number;
  max_heart_rate: number;
}

// Physiological cycle
export interface Cycle {
  id: number;
  user_id: number;
  start: string;
  end: string | null;
  score: {
    strain: number;
    kilojoule: number;
    average_heart_rate: number;
    max_heart_rate: number;
  } | null;
}

// Recovery
export interface Recovery {
  cycle_id: number;
  sleep_id: number;
  user_id: number;
  score: {
    recovery_score: number;
    resting_heart_rate: number;
    hrv_rmssd_milli: number;
    spo2_percentage: number | null;
    skin_temp_celsius: number | null;
  };
}

// Sleep
export interface Sleep {
  id: number;
  user_id: number;
  start: string;
  end: string;
  score: {
    stage_summary: {
      total_in_bed_time_milli: number;
      total_awake_time_milli: number;
      total_light_sleep_time_milli: number;
      total_slow_wave_sleep_time_milli: number;
      total_rem_sleep_time_milli: number;
      sleep_cycle_count: number;
      disturbance_count: number;
    };
    sleep_needed: {
      baseline_milli: number;
      need_from_sleep_debt_milli: number;
      need_from_recent_strain_milli: number;
      need_from_recent_nap_milli: number;
    };
    respiratory_rate: number | null;
    sleep_performance_percentage: number | null;
    sleep_consistency_percentage: number | null;
    sleep_efficiency_percentage: number | null;
  };
}

// Workout
export interface Workout {
  id: number;
  user_id: number;
  start: string;
  end: string;
  sport_id: number;
  score: {
    strain: number;
    average_heart_rate: number;
    max_heart_rate: number;
    kilojoule: number;
    percent_recorded: number;
    zone_duration: {
      zone_zero_milli: number;
      zone_one_milli: number;
      zone_two_milli: number;
      zone_three_milli: number;
      zone_four_milli: number;
      zone_five_milli: number;
    };
  };
}

// OAuth token response from Whoop
export interface OAuthTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
}

// Sport ID to name mapping
export const SPORT_ID_MAP: Record<number, string> = {
  0: "running",
  1: "cycling",
  33: "swimming",
  48: "strength_training",
  52: "yoga",
  63: "hiking",
  71: "spinning",
} as const;

export function getSportName(sportId: number): string {
  return SPORT_ID_MAP[sportId] ?? `unknown_${sportId}`;
}
