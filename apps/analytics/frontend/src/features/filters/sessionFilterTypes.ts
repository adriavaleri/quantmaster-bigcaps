export interface SessionQueryResult {
  count: number;
  avg: Record<string, number | null>;
  p25: Record<string, number | null>;
  median: Record<string, number | null>;
  p75: Record<string, number | null>;
  distributionBuckets?: Record<string, DistributionBucket[]>;
  distributionAverages?: Record<string, number | null>;
}

export interface DistributionBucket {
  label: string;
  count: number;
}

export interface DistributionsResult {
  [key: string]: number | string | DistributionBucket[] | null;
  high_spike: DistributionBucket[];
  low_spike: DistributionBucket[];
  hod_time: DistributionBucket[];
  lod_time: DistributionBucket[];
  full_hod_time: DistributionBucket[];
  full_lod_time: DistributionBucket[];
  day_return: DistributionBucket[];
  session_high_spike: DistributionBucket[];
  session_low_spike: DistributionBucket[];
  session_return: DistributionBucket[];
  hod_time_avg: string | null;
  lod_time_avg: string | null;
}
