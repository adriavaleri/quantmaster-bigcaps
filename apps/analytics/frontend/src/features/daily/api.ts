import { invoke } from '@tauri-apps/api/core';

export const DAILY_FILTER_CONDITIONS_KEY = 'qmdata.daily-analytics-conditions';
export const DAILY_FILTER_DATE_FROM_KEY = 'qmdata.daily-analytics-date-from';
export const DAILY_FILTER_DATE_TO_KEY = 'qmdata.daily-analytics-date-to';
export const DAILY_FILTER_TICKER_KEY = 'qmdata.daily-analytics-ticker';
export const DAILY_FILTER_MAX_EVENTS_PER_DAY_KEY = 'qmdata.daily-analytics-max-events-per-day';

export interface DailyFeatureInfo {
  name: string;
  dataType: string;
  filterable: boolean;
}

export interface DailyFeatureCondition {
  field: string;
  operator: string;
  value?: number;
  upperValue?: number;
  compareTo?: string;
}

export interface DailyAnalyticsFilter {
  dateFrom?: string;
  dateTo?: string;
  ticker?: string;
  search?: string;
  maxEventsPerDay?: number;
  conditions: DailyFeatureCondition[];
}

const MARKET_BREADTH_LABELS: Record<string, string> = {
  breadth_ad_line: 'AD Line',
  breadth_adn: 'ADn',
  breadth_rasi: 'RASI',
  breadth_rasi_percentile_252d: 'RASI Percentile (252D, %)',
  breadth_above_sma40: 'Stocks Above SMA40 (%)',
  breadth_ratio10d: 'Ratio10D',
};

export function marketBreadthLabel(field: string): string | undefined {
  return Object.hasOwn(MARKET_BREADTH_LABELS, field) ? MARKET_BREADTH_LABELS[field] : undefined;
}

export function supportsMagnitudeSuffix(field: string): boolean {
  return field === 'market_cap_estimated' || field === 'dollar_volume_20d' || field === 'volume_20d';
}

export function supportsPercentageSymbol(field: string): boolean {
  return field === 'breadth_above_sma40' || field === 'breadth_rasi_percentile_252d' || field.endsWith('_pct') || field.startsWith('momentum_') || field === 'adr_20d';
}

export function supportsCurrencySymbol(field: string): boolean {
  return field === 'market_cap_estimated' || field === 'dollar_volume_20d' || field === 'price_prev_close' || field === 'atr_14d' || ['open', 'high', 'low', 'close'].includes(field) || field.endsWith('_price') || /^(ema|sma)_\d+$/.test(field);
}

export function supportsRatioSymbol(field: string): boolean {
  return field === 'relative_volume_20d' || field === 'breadth_ratio10d';
}

export function usesFormattedNumericInput(field: string): boolean {
  return supportsMagnitudeSuffix(field) || supportsPercentageSymbol(field) || supportsCurrencySymbol(field) || supportsRatioSymbol(field);
}

export function parseDailyFeatureValue(rawValue: string, field: string): number | null {
  let raw = rawValue.trim();
  if (!raw) return null;

  if (supportsPercentageSymbol(field) && raw.endsWith('%')) raw = raw.slice(0, -1).trim();
  if (supportsRatioSymbol(field) && raw.toLowerCase().endsWith('x')) raw = raw.slice(0, -1).trim();
  if (supportsCurrencySymbol(field) && raw.startsWith('-$')) raw = `-${raw.slice(2).trim()}`;
  else if (supportsCurrencySymbol(field) && raw.startsWith('$')) raw = raw.slice(1).trim();
  raw = raw.replaceAll(',', '');

  if (supportsMagnitudeSuffix(field)) {
    const match = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+))\s*([kmbt])?$/i.exec(raw);
    if (match) {
      const suffix = match[2]?.toUpperCase();
      const multiplier = suffix === 'T' ? 1_000_000_000_000 : suffix === 'B' ? 1_000_000_000 : suffix === 'M' ? 1_000_000 : suffix === 'K' ? 1_000 : 1;
      const value = Number(match[1]) * multiplier;
      return Number.isFinite(value) ? value : null;
    }
  }

  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

export function formatDailyFeatureValue(value: number | undefined, field: string): string {
  if (value === undefined) return '';
  const numericValue = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Math.abs(value));

  if (supportsPercentageSymbol(field)) {
    return `${value < 0 ? '-' : ''}${numericValue}%`;
  }

  if (supportsRatioSymbol(field)) return `${value < 0 ? '-' : ''}${numericValue}x`;

  if (supportsMagnitudeSuffix(field)) {
    const units = [
      { suffix: 'T', value: 1_000_000_000_000 },
      { suffix: 'B', value: 1_000_000_000 },
      { suffix: 'M', value: 1_000_000 },
      ...(field === 'volume_20d' ? [{ suffix: 'K', value: 1_000 }] : []),
    ];
    const unit = units.find((candidate) => Math.abs(value) >= candidate.value);
    const compact = unit
      ? `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(Math.abs(value) / unit.value)}${unit.suffix}`
      : numericValue;
    const currencyPrefix = supportsCurrencySymbol(field) ? '$' : '';
    return `${value < 0 ? '-' : ''}${currencyPrefix}${compact}`;
  }

  if (supportsCurrencySymbol(field)) return `${value < 0 ? '-$' : '$'}${numericValue}`;

  return String(value);
}

export interface DailyAnalyticsRow {
  date: string;
  ticker: string;
  open: number;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
  returnPct: number;
  features: Record<string, number | null>;
}

export interface DailyReturnPoint {
  date: string;
  observations: number;
  meanReturnPct: number;
}

export interface DailyAnalyticsResult {
  summary: {
    observations: number;
    tickers: number;
    days: number;
    meanReturnPct: number | null;
    medianReturnPct: number | null;
    positiveReturnPct: number | null;
  };
  dailyReturns: DailyReturnPoint[];
  rows: DailyAnalyticsRow[];
  totalRows: number;
  page: number;
  pageSize: number;
  monthsScanned: number;
  elapsedMs: number;
}

export interface DailyStockFilterSummary {
  totalResults: number;
  averageRthReturnPct: number | null;
  p25RthReturnPct: number | null;
  medianRthReturnPct: number | null;
  p75RthReturnPct: number | null;
  averageNextDayRthReturnPct: number | null;
  p25NextDayRthReturnPct: number | null;
  medianNextDayRthReturnPct: number | null;
  p75NextDayRthReturnPct: number | null;
  eventsPerDay: { date: string; count: number }[];
  forwardRthReturns: DailyForwardReturnSummary[];
  forwardFromCloseReturns: DailyForwardReturnSummary[];
  cumulativeReturns: DailyCumulativeReturnPoint[];
}

export interface DailyForwardReturnSummary {
  marketSessionsAfter: number;
  observations: number;
  positiveReturnPct: number | null;
  averageReturnPct: number | null;
  p25ReturnPct: number | null;
  medianReturnPct: number | null;
  p75ReturnPct: number | null;
  cumulativeReturns: DailyCumulativeReturnPoint[];
}

export interface DailyCumulativeReturnPoint {
  date: string;
  observations: number;
  dailyReturnSumPct: number;
  cumulativeReturnPct: number;
}

export function loadDailyFeatureCatalog(dataRoot: string) {
  return invoke<DailyFeatureInfo[]>('daily_feature_catalog', { dataRoot });
}

export function queryDailyAnalytics(
  dataRoot: string,
  filters: DailyAnalyticsFilter,
  page: number,
  pageSize: number,
  sortCol: string,
  sortDesc: boolean,
) {
  return invoke<DailyAnalyticsResult>('query_daily_analytics', {
    dataRoot,
    filters,
    page,
    pageSize,
    sortCol,
    sortDesc,
  });
}

export function countDailyStocks(
  dataRoot: string,
  filters: DailyAnalyticsFilter,
) {
  return invoke<number>('count_daily_stocks', {
    dataRoot,
    filters,
  });
}

export function summarizeDailyStocks(
  dataRoot: string,
  filters: DailyAnalyticsFilter,
) {
  return invoke<DailyStockFilterSummary>('summarize_daily_stocks', {
    dataRoot,
    filters,
  });
}
