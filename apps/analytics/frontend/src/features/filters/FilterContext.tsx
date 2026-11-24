import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import { sessionOverview, sessionTimingDistributions, type SessionCondition, type SessionFilterConfig, type SessionOverviewResult, type SessionTimingSummary } from '../session-builder/api';
import type { DistributionsResult, SessionQueryResult } from './sessionFilterTypes';
import type { DailyAnalyticsFilter, DailyCumulativeReturnPoint, DailyForwardReturnSummary } from '../daily/api';
import { errorMessage } from '../../shared/errorMessage';

export type FilterType = 'numeric' | 'boolean' | 'categorical' | 'time';
export type FilterOperator = '>=' | '<=' | '>' | '<' | '=' | '!=' | 'between';

export interface Filter {
  id: string;
  label: string;
  field: string;
  type: FilterType;
  operator?: FilterOperator;
  valueMode?: 'static' | 'field';
  value?: number | string | boolean | null;
  value2?: number | string;
  compareField?: string;
  lookbackDays?: number;
}

export type DateRangePreset = 'all' | 'last-year' | 'last-month' | 'last-7-days' | 'custom';
export type DataSource = 'events' | 'trades';
export type StatisticType = 'average' | '25th' | 'median' | '75th';

export interface SavedFilterSet {
  id: string;
  name: string;
  filters: Filter[];
  dateRange: DateRangePreset;
  customDateStart: string | null;
  customDateEnd: string | null;
  dataSource: DataSource;
  createdAt: string;
  updatedAt: string;
}

export interface DailySearchState {
  filter: DailyAnalyticsFilter | null;
  resultCount: number | null;
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
  isLoading: boolean;
  error: string | null;
}

type ExplorerView = { search: string; sortCol: string; sortDesc: boolean };

interface FilterContextValue {
  explorerView: ExplorerView;
  setExplorerView: (view: ExplorerView) => void;
  filters: Filter[];
  appliedFilters: Filter[];
  addFilter: (filter: Filter) => void;
  updateFilter: (filter: Filter) => void;
  removeFilter: (id: string) => void;
  clearFilters: () => void;
  dateRange: DateRangePreset;
  appliedDateRange: DateRangePreset;
  setDateRange: (range: DateRangePreset) => void;
  customDateStart: Date | null;
  customDateEnd: Date | null;
  appliedCustomDateStart: Date | null;
  appliedCustomDateEnd: Date | null;
  setCustomDateStart: (date: Date | null) => void;
  setCustomDateEnd: (date: Date | null) => void;
  applyFilters: () => void;
  hasPendingChanges: boolean;
  hasSearched: boolean;
  dataSource: DataSource;
  setDataSource: (source: DataSource) => void;
  selectedStatistic: StatisticType;
  setSelectedStatistic: (stat: StatisticType) => void;
  savedFilterSets: SavedFilterSet[];
  saveCurrentFilterSet: (name: string) => void;
  renameSavedFilterSet: (id: string, name: string) => void;
  loadSavedFilterSet: (id: string) => void;
  deleteSavedFilterSet: (id: string) => void;
  queryResult: SessionQueryResult | null;
  isLoading: boolean;
  queryError: string | null;
  distributions: DistributionsResult | null;
  isLoadingDist: boolean;
  recordCount: number;
  dataRoot: string;
  setDataRoot: (root: string) => void;
  liquidityTop: number;
  setLiquidityTop: (top: number) => void;
  ticker: string;
  setTicker: (ticker: string) => void;
  minTickersPerDay: number | null;
  setMinTickersPerDay: (min: number | null) => void;
  maxTickersPerDay: number | null;
  setMaxTickersPerDay: (max: number | null) => void;
  operableDays: number;
  marketDays: number;
  dailySearch: DailySearchState;
  setDailySearch: (state: DailySearchState) => void;
}

const FilterContext = createContext<FilterContextValue | undefined>(undefined);
const SAVED_FILTERS_KEY = 'qmdata.saved-filter-sets.v2';
const DATA_ROOT_KEY = 'qmdata.session-filter-root';
const DEFAULT_DATA_ROOT = 'data/analytics';

type OverviewRequestResult = {
  overview: SessionOverviewResult;
  timing: SessionTimingSummary;
};

function overviewRequestKey(dataRoot: string, config: SessionFilterConfig) {
  return `${dataRoot}\u0000${JSON.stringify(config)}`;
}

function requestOverview(
  requests: Map<string, Promise<OverviewRequestResult>>,
  dataRoot: string,
  config: SessionFilterConfig,
) {
  const key = overviewRequestKey(dataRoot, config);
  const existing = requests.get(key);
  if (existing) return existing;

  const request = Promise.all([
    sessionOverview(dataRoot, config),
    sessionTimingDistributions(dataRoot, config),
  ]).then(([overview, timing]) => ({ overview, timing }));
  requests.set(key, request);
  void request.catch(() => {
    if (requests.get(key) === request) requests.delete(key);
  });
  return request;
}

function initialDataRoot(): string {
  const stored = localStorageValue(DATA_ROOT_KEY);
  if (!stored || stored.includes('massive_liquidity_universe')) {
    return DEFAULT_DATA_ROOT;
  }
  return stored;
}

export const useFilters = () => {
  const context = useContext(FilterContext);
  if (!context) throw new Error('useFilters must be used within FilterProvider');
  return context;
};

export function FilterProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  const isOverviewRoute = location.pathname === '/' || location.pathname === '';
  const [filters, setFilters] = useState<Filter[]>([]);
  const [appliedFilters, setAppliedFilters] = useState<Filter[]>([]);
  const [dateRange, setDateRange] = useState<DateRangePreset>('all');
  const [appliedDateRange, setAppliedDateRange] = useState<DateRangePreset>('all');
  const [customDateStart, setCustomDateStart] = useState<Date | null>(null);
  const [customDateEnd, setCustomDateEnd] = useState<Date | null>(null);
  const [appliedCustomDateStart, setAppliedCustomDateStart] = useState<Date | null>(null);
  const [appliedCustomDateEnd, setAppliedCustomDateEnd] = useState<Date | null>(null);
  const [dataSource, setDataSource] = useState<DataSource>('events');
  const [selectedStatistic, setSelectedStatistic] = useState<StatisticType>('average');
  const [hasSearched, setHasSearched] = useState(false);
  const [dataRoot, setDataRootState] = useState(initialDataRoot);
  const [liquidityTop, setLiquidityTopState] = useState(500);
  const [appliedLiquidityTop, setAppliedLiquidityTop] = useState(500);
  const [ticker, setTickerState] = useState('');
  const [appliedTicker, setAppliedTicker] = useState('');
  const [minTickersPerDay, setMinTickersPerDayState] = useState<number | null>(null);
  const [appliedMinTickersPerDay, setAppliedMinTickersPerDay] = useState<number | null>(null);
  const [maxTickersPerDay, setMaxTickersPerDayState] = useState<number | null>(null);
  const [appliedMaxTickersPerDay, setAppliedMaxTickersPerDay] = useState<number | null>(null);
  const [queryResult, setQueryResult] = useState<SessionQueryResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);
  const [distributions, setDistributions] = useState<DistributionsResult | null>(null);
  const [isLoadingDist, setIsLoadingDist] = useState(false);
  const [operableDays, setOperableDays] = useState(0);
  const [marketDays, setMarketDays] = useState(0);
  const [explorerView, setExplorerView] = useState<ExplorerView>({ search: '', sortCol: 'date', sortDesc: true });
  const [dailySearch, setDailySearch] = useState<DailySearchState>({
    filter: null,
    resultCount: null,
    averageRthReturnPct: null,
    p25RthReturnPct: null,
    medianRthReturnPct: null,
    p75RthReturnPct: null,
    averageNextDayRthReturnPct: null,
    p25NextDayRthReturnPct: null,
    medianNextDayRthReturnPct: null,
    p75NextDayRthReturnPct: null,
    eventsPerDay: [],
    forwardRthReturns: [],
    forwardFromCloseReturns: [],
    cumulativeReturns: [],
    isLoading: false,
    error: null,
  });
  const overviewRequests = useRef(new Map<string, Promise<OverviewRequestResult>>());

  const [savedFilterSets, setSavedFilterSets] = useState<SavedFilterSet[]>(() => readSavedFilters());

  const effectiveDates = useMemo(() => getEffectiveDates(appliedDateRange, appliedCustomDateStart, appliedCustomDateEnd), [appliedDateRange, appliedCustomDateStart, appliedCustomDateEnd]);
  const config = useMemo<SessionFilterConfig>(() => ({
    dateFrom: effectiveDates.from,
    dateTo: effectiveDates.to,
    analysisMode: 'rth',
    liquidityTop: appliedLiquidityTop,
    ticker: appliedTicker || null,
    minTickersPerDay: appliedMinTickersPerDay,
    maxTickersPerDay: appliedMaxTickersPerDay,
    conditions: appliedFilters.flatMap(filterToConditions),
  }), [appliedFilters, effectiveDates, appliedLiquidityTop, appliedTicker, appliedMinTickersPerDay, appliedMaxTickersPerDay]);

  useEffect(() => {
    localStorage.setItem(SAVED_FILTERS_KEY, JSON.stringify(savedFilterSets));
  }, [savedFilterSets]);

  useEffect(() => {
    localStorage.setItem(DATA_ROOT_KEY, dataRoot);
  }, [dataRoot]);

  useEffect(() => {
    if (!hasSearched || !isOverviewRoute) {
      if (!hasSearched) {
        setOperableDays(0);
        setMarketDays(0);
      }
      if (!isOverviewRoute) {
        setIsLoading(false);
        setIsLoadingDist(false);
      }
      return;
    }
    let cancelled = false;
    setIsLoading(true);
    setIsLoadingDist(true);
    setQueryError(null);
    setQueryResult(null);
    setDistributions(null);
    setOperableDays(0);
    setMarketDays(0);
    const applyResult = ({ overview, timing }: OverviewRequestResult) => {
      if (cancelled) return;
      const summary = withLegacyMetricAliases(overview.summary);
      setOperableDays(Number.isFinite(overview.operableDays) ? overview.operableDays : 0);
      setMarketDays(Number.isFinite(overview.marketDays) ? overview.marketDays : 0);
      setQueryResult({
        ...summary,
        count: overview.matchedSessions,
        avg: { ...summary.avg, ...timing.avg },
        p25: { ...summary.p25, ...timing.p25 },
        median: { ...summary.median, ...timing.median },
        p75: { ...summary.p75, ...timing.p75 },
      });
      setDistributions({
        ...toDistributions(summary),
        ...timing.distributionBuckets,
        ...timing.distributionAverages,
      } as DistributionsResult);
      setIsLoading(false);
      setIsLoadingDist(false);
    };

    void requestOverview(overviewRequests.current, dataRoot, config)
      .then(applyResult)
      .catch((error: unknown) => {
        if (!cancelled) {
          setQueryError(errorMessage(error));
          setIsLoading(false);
          setIsLoadingDist(false);
        }
      });
    return () => { cancelled = true; };
  }, [config, dataRoot, hasSearched, isOverviewRoute]);

  const setDataRoot = (root: string) => setDataRootState(root.trim());
  const setLiquidityTop = (top: number) => setLiquidityTopState(Math.max(1, Math.min(65535, Math.floor(top) || 1)));
  const setTicker = (value: string) => setTickerState(value.toUpperCase());
  const setMinTickersPerDay = (min: number | null) => {
    if (min === null || !Number.isFinite(min) || min <= 0) {
      setMinTickersPerDayState(null);
      return;
    }
    setMinTickersPerDayState(Math.min(65535, Math.floor(min)));
  };
  const setMaxTickersPerDay = (max: number | null) => {
    if (max === null || !Number.isFinite(max) || max <= 0) {
      setMaxTickersPerDayState(null);
      return;
    }
    setMaxTickersPerDayState(Math.min(65535, Math.floor(max)));
  };
  const applyFilters = () => {
    setAppliedFilters(filters.map((filter) => ({ ...filter })));
    setAppliedDateRange(dateRange);
    setAppliedCustomDateStart(customDateStart);
    setAppliedCustomDateEnd(customDateEnd);
    setAppliedLiquidityTop(liquidityTop);
    setAppliedTicker(ticker.trim());
    setAppliedMinTickersPerDay(minTickersPerDay);
    setAppliedMaxTickersPerDay(maxTickersPerDay);
    setHasSearched(true);
  };
  const hasPendingChanges = !hasSearched || JSON.stringify([filters, dateRange, customDateStart?.toISOString(), customDateEnd?.toISOString(), liquidityTop, ticker, minTickersPerDay, maxTickersPerDay]) !== JSON.stringify([appliedFilters, appliedDateRange, appliedCustomDateStart?.toISOString(), appliedCustomDateEnd?.toISOString(), appliedLiquidityTop, appliedTicker, appliedMinTickersPerDay, appliedMaxTickersPerDay]);

  const value: FilterContextValue = {
    filters, appliedFilters, addFilter: (filter) => setFilters((current) => [...current, filter]),
    updateFilter: (filter) => setFilters((current) => current.map((item) => item.id === filter.id ? filter : item)),
    removeFilter: (id) => setFilters((current) => current.filter((filter) => filter.id !== id)),
    clearFilters: () => setFilters([]), dateRange, appliedDateRange, setDateRange,
    customDateStart, customDateEnd, appliedCustomDateStart, appliedCustomDateEnd,
    setCustomDateStart, setCustomDateEnd, applyFilters, hasPendingChanges, hasSearched,
    dataSource, setDataSource, selectedStatistic, setSelectedStatistic, savedFilterSets,
    saveCurrentFilterSet: (name) => saveFilter(name, filters, dateRange, customDateStart, customDateEnd, dataSource, setSavedFilterSets),
    renameSavedFilterSet: (id, name) => setSavedFilterSets((current) => current.map((set) => set.id === id ? { ...set, name: name.trim(), updatedAt: new Date().toISOString() } : set)),
    loadSavedFilterSet: (id) => {
      const saved = savedFilterSets.find((set) => set.id === id);
      if (!saved) return;
      setFilters(saved.filters.map((filter) => ({ ...filter })));
      setDateRange(saved.dateRange); setCustomDateStart(parseDate(saved.customDateStart)); setCustomDateEnd(parseDate(saved.customDateEnd)); setDataSource(saved.dataSource);
    },
    deleteSavedFilterSet: (id) => setSavedFilterSets((current) => current.filter((set) => set.id !== id)),
    queryResult, isLoading, queryError, distributions, isLoadingDist, recordCount: queryResult?.count ?? 0,
    dataRoot, setDataRoot, liquidityTop, setLiquidityTop, ticker, setTicker, minTickersPerDay, setMinTickersPerDay, maxTickersPerDay, setMaxTickersPerDay,
    operableDays, marketDays,
    dailySearch, setDailySearch, explorerView, setExplorerView,
  };
  return <FilterContext.Provider value={value}>{children}</FilterContext.Provider>;
}

export function filterToConditions(filter: Filter): SessionCondition[] {
  if (filter.field === 'date' || filter.value === undefined || filter.value === null || filter.valueMode === 'field') return [];
  if (typeof filter.value === 'boolean') return [{ fieldId: filter.field, operator: filter.operator === '=' ? 'eq' : 'neq', value: filter.value }];
  if (typeof filter.value === 'string' && filter.type === 'categorical') return [{ fieldId: filter.field, operator: filter.operator === '=' ? 'eq' : 'neq', value: filter.value }];
  if (typeof filter.value !== 'number') return [];
  const operator = filter.operator ?? '>=';
  const operatorName = operator === '=' ? 'eq' : operator === '!=' ? 'neq' : operator === '>' ? 'gt' : operator === '<' ? 'lt' : operator === '<=' ? 'lte' : 'gte';
  if (operator === 'between') return [{ fieldId: filter.field, operator: 'gte', value: filter.value, ...(filter.lookbackDays ? { lookbackDays: filter.lookbackDays } : {}) }, { fieldId: filter.field, operator: 'lte', value: filter.value2 ?? filter.value, ...(filter.lookbackDays ? { lookbackDays: filter.lookbackDays } : {}) }];
  return [{ fieldId: filter.field, operator: operatorName, value: filter.value, ...(filter.lookbackDays ? { lookbackDays: filter.lookbackDays } : {}) }];
}

function getEffectiveDates(range: DateRangePreset, start: Date | null, end: Date | null) {
  if (range === 'custom' && start && end) return { from: iso(start), to: iso(end) };
  const today = new Date();
  if (range === 'last-year') return { from: iso(shift(today, -1, 'year')), to: iso(today) };
  if (range === 'last-month') return { from: iso(shift(today, -1, 'month')), to: iso(today) };
  if (range === 'last-7-days') return { from: iso(shift(today, -7, 'day')), to: iso(today) };
  return { from: '2016-01-01', to: '2026-12-31' };
}

function emptyQueryResult(count: number): SessionQueryResult { return { count, avg: {}, p25: {}, median: {}, p75: {} }; }
function toDistributions(result: SessionQueryResult): DistributionsResult | null {
  if (!result.distributionBuckets || !result.distributionAverages) return null;
  return { ...result.distributionBuckets, ...result.distributionAverages } as DistributionsResult;
}
function withLegacyMetricAliases(result: SessionQueryResult): SessionQueryResult {
  const aliases: Record<string, string> = {
    full_hod_price: 'hod', full_lod_price: 'lod', session_vol: 'rth_vol', session_dollar_vol: 'rth_dollar_vol',
    eod_vol: 'rth_vol', eod_dollar_vol: 'rth_dollar_vol', session_return_pct: 'rth_return_pct',
    session_high_spike_pct: 'rth_high_spike_pct', session_low_spike_pct: 'rth_low_spike_pct', session_range_pct: 'rth_range_pct',
    prev_day_close_price: 'prev_day_close', ah_prev_close_price: 'ah_prev_close_price', ah_prev_high_price: 'ah_prev_high_price', ah_prev_low_price: 'ah_prev_low_price',
    ah_prev_vol: 'ah_prev_vol', ah_prev_dollar_vol: 'ah_prev_dollar_vol', ah_prev_range_pct: 'ah_prev_range_pct',
    ah_prev_return_pct: 'ah_prev_return_pct', ah_prev_high_spike_pct: 'ah_prev_high_spike_pct', ah_prev_low_spike_pct: 'ah_prev_low_spike_pct',
    ah_prev_high_fade_to_pm_open_pct: 'ah_prev_high_fade_to_pm_open_pct', overnight_high_price: 'overnight_high_price', overnight_low_price: 'overnight_low_price',
    overnight_range_pct: 'overnight_range_pct', overnight_return_pct: 'overnight_return_pct', overnight_high_spike_pct: 'overnight_high_spike_pct',
    overnight_low_spike_pct: 'overnight_low_spike_pct', pm_open_price: 'pm_open_price', pm_close_price: 'pm_close_price', pm_high_price: 'pm_high_price', pm_low_price: 'pm_low_price',
    pm_range_pct: 'pmh_gap_pct', pm_high_gap_pct: 'pmh_gap_pct', pm_low_spike_pct: 'pm_low_spike_pct', open_position_in_pm_range: 'open_position_in_pm_range',
    pmh_fade_to_open_pct: 'pmh_fade_to_open_pct', pmh_fade_to_close_pct: 'pmh_fade_to_close_pct', pmh_fade_to_m1_pct: 'pmh_fade_to_m1_pct',
    pmh_fade_to_m5_pct: 'pmh_fade_pct', pmh_fade_to_m15_pct: 'pmh_fade_pct', pmh_fade_to_m30_pct: 'pmh_fade_pct',
    pmh_fade_to_m60_pct: 'pmh_fade_to_m60_pct', pmh_fade_to_m90_pct: 'pmh_fade_to_m90_pct', pmh_fade_to_m120_pct: 'pmh_fade_to_m120_pct', pmh_fade_to_m180_pct: 'pmh_fade_to_m180_pct',
    open_price: 'open', close_price: 'close', hod_price: 'hod', lod_price: 'lod', rth_fade_to_close_pct: 'rth_fade_pct',
    close_position_in_rth_range: 'rth_range_pct', m90_return_pct: 'm120_return_pct', m180_return_pct: 'm120_return_pct',
    ret_m1_to_close_pct: 'rth_return_pct', ret_m5_to_close_pct: 'rth_return_pct', ret_m15_to_close_pct: 'rth_return_pct',
    ret_m30_to_close_pct: 'rth_return_pct', ret_m60_to_close_pct: 'rth_return_pct', ret_m90_to_close_pct: 'rth_return_pct',
    ret_m120_to_close_pct: 'rth_return_pct', ret_m180_to_close_pct: 'rth_return_pct', vwap_open: 'vwap_at_open', vwap_m1: 'vwap_at_open',
    vwap_m5: 'vwap_at_open', vwap_m15: 'vwap_at_open', vwap_m30: 'vwap_at_open', vwap_m60: 'vwap_at_open', vwap_m90: 'vwap_at_open',
    vwap_m120: 'vwap_at_open', vwap_m180: 'vwap_at_open', ah_close_price: 'ah_close_price', ah_high_price: 'ah_high_price', ah_low_price: 'ah_low_price',
    ah_vol: 'ah_vol', ah_dollar_vol: 'ah_dollar_vol', ah_range_pct: 'ah_range_pct', ah_return_pct: 'ah_return_pct',
    ah_high_spike_pct: 'ah_high_spike_pct', ah_low_spike_pct: 'ah_low_spike_pct', close_position_in_ah_range: 'ah_range_pct',
  };
  const map = (source: Record<string, number | null>) => {
    const copy = { ...source };
    for (const [alias, canonical] of Object.entries(aliases)) if (copy[alias] == null && copy[canonical] != null) copy[alias] = copy[canonical];
    return copy;
  };
  return { ...result, avg: map(result.avg), p25: map(result.p25), median: map(result.median), p75: map(result.p75) };
}
function iso(date: Date) { return date.toISOString().slice(0, 10); }
function shift(date: Date, amount: number, unit: 'day' | 'month' | 'year') { const copy = new Date(date); if (unit === 'day') copy.setUTCDate(copy.getUTCDate() + amount); if (unit === 'month') copy.setUTCMonth(copy.getUTCMonth() + amount); if (unit === 'year') copy.setUTCFullYear(copy.getUTCFullYear() + amount); return copy; }
function parseDate(value: string | null) { return value ? new Date(`${value}T00:00:00Z`) : null; }
function localStorageValue(key: string) { if (typeof window === 'undefined') return null; return window.localStorage.getItem(key); }
function readSavedFilters(): SavedFilterSet[] { const raw = localStorageValue(SAVED_FILTERS_KEY); if (!raw) return []; try { const parsed = JSON.parse(raw) as SavedFilterSet[]; return Array.isArray(parsed) ? parsed : []; } catch { return []; } }
function saveFilter(name: string, filters: Filter[], dateRange: DateRangePreset, start: Date | null, end: Date | null, dataSource: DataSource, set: (updater: (current: SavedFilterSet[]) => SavedFilterSet[]) => void) { const trimmed = name.trim(); if (!trimmed) return; const now = new Date().toISOString(); set((current) => [{ id: `saved-${Date.now()}`, name: trimmed, filters: filters.map((filter) => ({ ...filter })), dateRange, customDateStart: start ? iso(start) : null, customDateEnd: end ? iso(end) : null, dataSource, createdAt: now, updatedAt: now }, ...current]); }
