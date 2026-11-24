import { invoke } from "@tauri-apps/api/core";
import type { SessionQueryResult } from "../filters/sessionFilterTypes";

export type SessionCondition = {
  fieldId: string;
  operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte";
  value: number | string | boolean;
  lookbackDays?: number;
};

export type SessionFilterConfig = {
  dateFrom: string;
  dateTo: string;
  analysisMode?: 'rth' | 'overnight';
  liquidityTop: number | null;
  ticker: string | null;
  minTickersPerDay: number | null;
  maxTickersPerDay: number | null;
  conditions: SessionCondition[];
};

export type SessionKey = { referenceDate: string; ticker: string };

export type SessionSelectionResult = {
  matchedSessions: number;
  filesScanned: number;
  elapsedMs: number;
  sessionKeys?: SessionKey[];
  summary?: SessionQueryResult;
};

export type SessionCountResult = {
  matchedSessions: number;
  filesScanned: number;
  elapsedMs: number;
  /** Optional for compatibility with a Tauri process running the previous backend binary. */
  operableDays?: number;
  marketDays?: number;
};

export type SessionOverviewResult = {
  matchedSessions: number;
  filesScanned: number;
  elapsedMs: number;
  operableDays: number;
  marketDays: number;
  summary: SessionQueryResult;
};

export type SessionTimingSummary = {
  distributionBuckets: Record<string, { label: string; count: number }[]>;
  distributionAverages: Record<string, number | null>;
  avg: Record<string, number | null>;
  p25: Record<string, number | null>;
  median: Record<string, number | null>;
  p75: Record<string, number | null>;
};

export type SessionHeatmapCell = {
  bucketIndex: number;
  timeIndex: number;
  count: number;
  averageReturn: number | null;
  medianReturn: number | null;
};

export type SessionHeatmapResult = {
  cells: SessionHeatmapCell[];
  includedObservations: number;
  xLabels: string[];
  yLabels: string[];
};

export type SessionReturnTrendPoint = {
  year: number;
  bucket: string;
  count: number;
  averageReturn: number | null;
  medianReturn: number | null;
  totalReturn: number | null;
  cumulativeReturn: number | null;
};

export type SessionReturnTrendResult = {
  field: string;
  points: SessionReturnTrendPoint[];
};

export type SessionIntradayReturnPoint = {
  minute: number;
  time: string;
  phase: 'RTH' | 'AH' | 'PM';
  count: number;
  averageReturn: number | null;
};

export type SessionIntradayReturnResult = {
  points: SessionIntradayReturnPoint[];
};

export type SessionTickerReturnBucket = {
  label: string;
  days: number;
  averageReturn: number | null;
  averageTickers: number | null;
};

export type SessionTickerReturnResult = {
  field: string;
  buckets: SessionTickerReturnBucket[];
  operableDays: number;
  marketDays: number;
};

export type StoreBuildReport = {
  outputDir: string;
  years: number[];
  rows: number;
  sourceFiles: number;
  manifestPath: string;
  reused: boolean;
  profileOutputDir: string;
  profileYears: number[];
  profileRows: number;
};

export const previewSessions = (dataRoot: string, config: SessionFilterConfig) =>
  invoke<SessionSelectionResult>("preview_sessions", { dataRoot, config });

export const countSessions = (dataRoot: string, config: SessionFilterConfig) =>
  invoke<SessionCountResult>("count_sessions", { dataRoot, config });

export const sessionSummary = (dataRoot: string, config: SessionFilterConfig) =>
  invoke<SessionQueryResult>("session_summary", { dataRoot, config });

export const sessionOverview = (dataRoot: string, config: SessionFilterConfig) =>
  invoke<SessionOverviewResult>("session_overview", { dataRoot, config });

export const selectSessions = (dataRoot: string, config: SessionFilterConfig) =>
  invoke<SessionSelectionResult>("select_sessions", { dataRoot, config });

export const sessionHeatmap = (dataRoot: string, config: SessionFilterConfig, bucketField: string, direction: 'greater' | 'less') =>
  invoke<SessionHeatmapResult>("session_heatmap", { dataRoot, config, bucketField, direction });

export const sessionReturnTrend = (dataRoot: string, config: SessionFilterConfig, returnField: string, granularity: 'year' | 'month' | 'week' | 'day') =>
  invoke<SessionReturnTrendResult>("session_return_trend", { dataRoot, config, returnField, granularity });

export const sessionIntradayReturnProfile = (dataRoot: string, config: SessionFilterConfig) =>
  invoke<SessionIntradayReturnResult>("session_intraday_return_profile", { dataRoot, config });

export const sessionTickerReturnDistribution = (dataRoot: string, config: SessionFilterConfig, returnField: string) =>
  invoke<SessionTickerReturnResult>("session_ticker_return_distribution", { dataRoot, config, returnField });

export const sessionTimingDistributions = (dataRoot: string, config: SessionFilterConfig) =>
  invoke<SessionTimingSummary>("session_timing_distributions", { dataRoot, config });

export const buildSessionFilterStore = (dataRoot: string) =>
  invoke<StoreBuildReport>("build_session_filter_store", { dataRoot, outputDir: null });
