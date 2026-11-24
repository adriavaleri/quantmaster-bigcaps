import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Activity,
  CircleHelp,
  LoaderCircle,
  Plus,
  RotateCcw,
  Search,
  Trash2,
} from 'lucide-react';
import { errorMessage } from '../../shared/errorMessage';
import {
  DAILY_FILTER_CONDITIONS_KEY,
  DAILY_FILTER_DATE_FROM_KEY,
  DAILY_FILTER_DATE_TO_KEY,
  DAILY_FILTER_TICKER_KEY,
  countDailyStocks,
  formatDailyFeatureValue,
  loadDailyFeatureCatalog,
  marketBreadthLabel,
  parseDailyFeatureValue,
  supportsCurrencySymbol,
  supportsMagnitudeSuffix,
  supportsPercentageSymbol,
  supportsRatioSymbol,
  usesFormattedNumericInput,
  type DailyAnalyticsFilter,
  type DailyFeatureCondition,
  type DailyFeatureInfo,
} from './api';

type Operator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'ne';
type ValueMode = 'value' | 'field';
type ConditionDraft = {
  id: string;
  field: string;
  operator: Operator;
  mode: ValueMode;
  value: string;
  compareTo: string;
};

const RESULT_FORMATTER = new Intl.NumberFormat('en-US');
const OPERATORS: { value: Operator; label: string }[] = [
  { value: 'gte', label: '≥' },
  { value: 'gt', label: '>' },
  { value: 'lte', label: '≤' },
  { value: 'lt', label: '<' },
  { value: 'eq', label: '=' },
  { value: 'ne', label: '≠' },
];

const FIELD_LABELS: Record<string, string> = {
  market_cap_estimated: 'Estimated Market Cap ($)',
  dollar_volume_20d: 'Median Dollar Volume (20D, $)',
  volume_20d: 'Median Volume (20D, shares)',
  relative_volume_20d: 'Relative Volume (20D)',
  gap_pct: 'Gap (%)',
  price_prev_close: 'Previous Close ($)',
  momentum_1d: 'Momentum (1D, Close-to-Close, %)',
  prev_day_return_pct: 'Previous Day RTH Return (Open-to-Close, %)',
  consecutive_green_bars: 'Consecutive Green Candles',
  consecutive_red_bars: 'Consecutive Red Candles',
  open: 'Open (Current Day, $)',
  close: 'Close (Current Day, $)',
  momentum_1m: 'Momentum (1M, %)',
  momentum_3m: 'Momentum (3M, %)',
  momentum_6m: 'Momentum (6M, %)',
  momentum_1w: 'Momentum (1W, %)',
  momentum_3d: 'Momentum (3D, %)',
  rank_1d: 'Momentum Rank (1D)',
  rank_3d: 'Momentum Rank (3D)',
  rank_1w: 'Momentum Rank (1W)',
  rank_1m: 'Momentum Rank (1M)',
  rank_3m: 'Momentum Rank (3M)',
  rank_6m: 'Momentum Rank (6M)',
  ema_10: 'EMA (10)',
  ema_20: 'EMA (20)',
  sma_50: 'SMA (50)',
  sma_200: 'SMA (200)',
  adr_20d: 'Average Daily Range (20D, %)',
  distance_52w_high_pct: 'Distance from 52-Week High (%)',
  distance_52w_low_pct: 'Rise from 52-Week Low (%)',
  distance_ath_high_pct: 'Distance from All-Time High (%)',
  distance_atl_low_pct: 'Distance from All-Time Low at Open (%)',
  atr_14d: 'ATR (14D, $)',
  atr_14d_pct: 'ATR (14D, % of Close)',
  rth_return_pct: 'RTH Return (Open-to-Close, %)',
};

const GROUP_ORDER = [
  'Size & Liquidity',
  'Price & Gap',
  'Momentum',
  'Momentum Rankings',
  'Moving Averages',
  'Volatility & Price Extremes',
  'Market Breadth',
  'Other Features',
];

function featureGroup(name: string): string {
  if (marketBreadthLabel(name)) return 'Market Breadth';
  if (['market_cap_estimated', 'dollar_volume_20d', 'volume_20d', 'relative_volume_20d'].includes(name)) return 'Size & Liquidity';
  if (['gap_pct', 'price_prev_close', 'open', 'close'].includes(name)) return 'Price & Gap';
  if (/^momentum_/.test(name) || ['prev_day_return_pct', 'consecutive_green_bars', 'consecutive_red_bars'].includes(name)) return 'Momentum';
  if (/^(rank|pct_rank)_/.test(name)) return 'Momentum Rankings';
  if (/^(ema|sma)_/.test(name)) return 'Moving Averages';
  if (['adr_20d', 'distance_52w_high_pct', 'distance_52w_low_pct', 'distance_ath_high_pct', 'distance_atl_low_pct', 'atr_14d', 'atr_14d_pct'].includes(name)) return 'Volatility & Price Extremes';
  return 'Other Features';
}

function fieldLabel(name: string): string {
  return marketBreadthLabel(name) ?? FIELD_LABELS[name] ?? name.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function makeCondition(field: string): ConditionDraft {
  return {
    id: `condition-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    field,
    operator: 'gte',
    mode: 'value',
    value: '',
    compareTo: '',
  };
}

function restoreConditions(): ConditionDraft[] {
  try {
    const stored = window.localStorage.getItem(DAILY_FILTER_CONDITIONS_KEY);
    const parsed = stored ? JSON.parse(stored) as DailyFeatureCondition[] : [];
    return parsed
      .filter((condition) => condition.operator !== 'is_null' && condition.operator !== 'is_not_null')
      .map((condition, index) => ({
      id: `stored-condition-${index}-${Date.now()}`,
      field: condition.field,
      operator: OPERATORS.some((item) => item.value === condition.operator) ? condition.operator as Operator : 'gte',
      mode: condition.compareTo ? 'field' : 'value',
      value: condition.value == null ? '' : formatDailyFeatureValue(condition.value, condition.field),
      compareTo: condition.compareTo ?? '',
      }));
  } catch {
    return [];
  }
}

function storedValue(key: string, fallback: string): string {
  try {
    return window.localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

export default function DailyAnalytics({ dataRoot }: { dataRoot: string }) {
  const [catalog, setCatalog] = useState<DailyFeatureInfo[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState(() => storedValue(DAILY_FILTER_DATE_FROM_KEY, '2017-01-01'));
  const [dateTo, setDateTo] = useState(() => storedValue(DAILY_FILTER_DATE_TO_KEY, '2023-12-31'));
  const [ticker, setTicker] = useState(() => storedValue(DAILY_FILTER_TICKER_KEY, ''));
  const [conditions, setConditions] = useState<ConditionDraft[]>(restoreConditions);
  const [result, setResult] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [queryError, setQueryError] = useState<string | null>(null);
  const requestId = useRef(0);

  const numericFeatures = useMemo(
    () => catalog.filter((feature) => feature.filterable && feature.name !== 'rth_return_pct' && feature.name !== 'ema_50' && !feature.name.startsWith('pct_rank_')),
    [catalog],
  );
  const featuresByGroup = useMemo(() => {
    const grouped = new Map<string, DailyFeatureInfo[]>();
    for (const feature of numericFeatures) {
      const group = featureGroup(feature.name);
      grouped.set(group, [...(grouped.get(group) ?? []), feature]);
    }
    return GROUP_ORDER
      .filter((group) => grouped.has(group))
      .map((group) => [group, grouped.get(group)!] as const);
  }, [numericFeatures]);

  useEffect(() => {
    let active = true;
    requestId.current += 1;
    setLoading(false);
    setCatalogLoading(true);
    setCatalogError(null);
    setCatalog([]);
    setResult(null);
    setQueryError(null);
    void loadDailyFeatureCatalog(dataRoot)
      .then((fields) => {
        if (active) setCatalog(fields);
      })
      .catch((error: unknown) => {
        if (active) setCatalogError(errorMessage(error));
      })
      .finally(() => {
        if (active) setCatalogLoading(false);
      });
    return () => { active = false; };
  }, [dataRoot]);

  useEffect(() => {
    const stored: DailyFeatureCondition[] = conditions.map((condition) => {
      const value = parseDailyFeatureValue(condition.value, condition.field);
      return {
        field: condition.field,
        operator: condition.operator,
        ...(value !== null ? { value } : {}),
        ...(condition.compareTo ? { compareTo: condition.compareTo } : {}),
      };
    });
    window.localStorage.setItem(DAILY_FILTER_CONDITIONS_KEY, JSON.stringify(stored));
  }, [conditions]);

  useEffect(() => {
    window.localStorage.setItem(DAILY_FILTER_DATE_FROM_KEY, dateFrom);
    window.localStorage.setItem(DAILY_FILTER_DATE_TO_KEY, dateTo);
    window.localStorage.setItem(DAILY_FILTER_TICKER_KEY, ticker);
  }, [dateFrom, dateTo, ticker]);

  const updateCondition = (id: string, patch: Partial<ConditionDraft>) => {
    setConditions((current) => current.map((condition) => condition.id === id ? { ...condition, ...patch } : condition));
  };

  const addCondition = () => {
    const firstField = numericFeatures[0]?.name;
    if (firstField) setConditions((current) => [...current, makeCondition(firstField)]);
  };

  const buildFilter = (): DailyAnalyticsFilter | null => {
    const mapped: DailyFeatureCondition[] = [];
    for (const condition of conditions) {
      if (!condition.field) {
        setQueryError('Choose a feature for every condition.');
        return null;
      }
      if (condition.mode === 'field') {
        if (!condition.compareTo) {
          setQueryError('Choose a second feature to compare.');
          return null;
        }
        mapped.push({ field: condition.field, operator: condition.operator, compareTo: condition.compareTo });
        continue;
      }
      const value = parseDailyFeatureValue(condition.value, condition.field);
      if (value === null) {
        setQueryError('Enter a numeric value for every condition.');
        return null;
      }
      mapped.push({ field: condition.field, operator: condition.operator, value });
    }
    setQueryError(null);
    return {
      ...(dateFrom ? { dateFrom } : {}),
      ...(dateTo ? { dateTo } : {}),
      ...(ticker.trim() ? { ticker: ticker.trim().toUpperCase() } : {}),
      conditions: mapped,
    };
  };

  const runQuery = async (filters: DailyAnalyticsFilter) => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    setResult(null);
    setQueryError(null);
    try {
      const nextResult = await countDailyStocks(dataRoot, filters);
      if (requestId.current === currentRequest) setResult(nextResult);
    } catch (error) {
      if (requestId.current === currentRequest) setQueryError(errorMessage(error));
    } finally {
      if (requestId.current === currentRequest) setLoading(false);
    }
  };

  const handleSearch = () => {
    const filters = buildFilter();
    if (!filters) return;
    void runQuery(filters);
  };

  const clearFilters = () => {
    requestId.current += 1;
    setLoading(false);
    setDateFrom('');
    setDateTo('');
    setTicker('');
    setConditions([]);
    setResult(null);
    setQueryError(null);
  };

  return (
    <div className="mx-auto w-full max-w-[1800px] space-y-6 px-5 py-6 text-[#E9EEF5] lg:px-8">
      <section className="rounded-2xl border border-[#2B2E34] bg-[#111720] shadow-[0_12px_36px_rgba(0,0,0,0.18)]">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-white/[0.07] px-5 py-5 lg:px-6">
          <div>
            <div className="flex items-center gap-2 text-[11px] font-bold uppercase tracking-[0.16em] text-red-300">
              <Activity className="h-4 w-4" /> Daily stock filtering
            </div>
            <h2 className="mt-2 text-xl font-semibold text-white">General</h2>
            <p className="mt-1 text-sm text-slate-400">Set the date range and daily feature conditions to find matching stocks.</p>
          </div>
          <div className="flex items-center gap-2 rounded-lg border border-white/[0.08] bg-black/20 px-3 py-2 text-[11px] text-slate-400">
            <CircleHelp className="h-4 w-4 shrink-0 text-slate-500" />
            All conditions must match
          </div>
        </div>

        <div className="space-y-5 px-5 py-5 lg:px-6">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-[1fr_1fr_1.2fr_auto]">
            <label className="block">
              <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">Date from</span>
              <input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} className="mt-1.5 h-10 w-full rounded-lg border border-white/[0.09] bg-[#0a0e14] px-3 text-sm text-slate-200 outline-none focus:border-red-500/50 [color-scheme:dark]" />
            </label>
            <label className="block">
              <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">Date to</span>
              <input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} className="mt-1.5 h-10 w-full rounded-lg border border-white/[0.09] bg-[#0a0e14] px-3 text-sm text-slate-200 outline-none focus:border-red-500/50 [color-scheme:dark]" />
            </label>
            <label className="block">
              <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-500">Ticker</span>
              <input type="text" value={ticker} onChange={(event) => setTicker(event.target.value.toUpperCase())} placeholder="Any ticker" className="mt-1.5 h-10 w-full rounded-lg border border-white/[0.09] bg-[#0a0e14] px-3 font-mono text-sm uppercase text-slate-200 outline-none placeholder:normal-case placeholder:text-slate-600 focus:border-red-500/50" />
            </label>
            <div className="flex items-end gap-2">
              <button type="button" onClick={clearFilters} className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-white/[0.1] px-3 text-xs font-semibold text-slate-400 transition hover:bg-white/[0.04] hover:text-white" title="Clear all filters">
                <RotateCcw className="h-3.5 w-3.5" /> Clear
              </button>
              <button type="button" onClick={handleSearch} disabled={loading || catalogLoading || !catalog.length} className="inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-gradient-to-r from-red-600 to-red-700 px-4 text-xs font-bold text-white shadow-[0_8px_20px_rgba(220,38,38,0.2)] transition hover:from-red-500 hover:to-red-600 disabled:cursor-not-allowed disabled:opacity-50">
                {loading ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                Search stocks
              </button>
            </div>
          </div>

          <div className="border-t border-white/[0.07] pt-5">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold text-slate-100">Daily feature filters</h3>
                <p className="mt-1 text-xs text-slate-500">Choose fields from the loaded daily_features catalog.</p>
              </div>
              <button type="button" onClick={addCondition} disabled={catalogLoading || !numericFeatures.length} className="inline-flex items-center gap-2 rounded-lg border border-red-500/30 bg-red-500/[0.08] px-3 py-2 text-xs font-semibold text-red-200 transition hover:border-red-400/50 hover:bg-red-500/[0.14] disabled:opacity-40">
                <Plus className="h-3.5 w-3.5" /> Add Filter
              </button>
            </div>

            {catalogLoading ? (
              <div className="flex items-center gap-2 rounded-xl border border-white/[0.06] bg-black/15 px-4 py-5 text-sm text-slate-400"><LoaderCircle className="h-4 w-4 animate-spin" /> Loading daily feature fields…</div>
            ) : catalogError ? (
              <div className="rounded-xl border border-red-500/20 bg-red-500/[0.06] px-4 py-3 text-sm text-red-200">Could not load daily feature fields: {catalogError}</div>
            ) : conditions.length === 0 ? (
              <div className="rounded-xl border border-dashed border-white/[0.1] bg-black/10 px-4 py-5 text-sm text-slate-500">No feature conditions added. Date and ticker filters will still apply.</div>
            ) : (
              <div className="space-y-2.5">
                {conditions.map((condition, index) => (
                  <div key={condition.id} className="grid gap-2 rounded-xl border border-white/[0.07] bg-[#0c1118] p-3 lg:grid-cols-[minmax(190px,1.25fr)_minmax(130px,0.7fr)_minmax(145px,1fr)_minmax(150px,1fr)_auto] lg:items-end">
                    <label className="block">
                      <span className="mb-1 block text-[9px] font-bold uppercase tracking-[0.12em] text-slate-600">{index === 0 ? 'Feature' : 'And feature'}</span>
                      <select value={condition.field} onChange={(event) => {
                        const field = event.target.value;
                        updateCondition(condition.id, { field, compareTo: condition.compareTo === field ? '' : condition.compareTo });
                      }} className="h-10 w-full rounded-lg border border-white/[0.08] bg-[#131a23] px-2.5 text-xs text-slate-200 outline-none focus:border-red-500/50">
                        {featuresByGroup.map(([group, fields]) => <optgroup key={group} label={group}>{fields.map((feature) => <option key={feature.name} value={feature.name}>{fieldLabel(feature.name)}</option>)}</optgroup>)}
                      </select>
                    </label>

                    <label className="block">
                      <span className="mb-1 block text-[9px] font-bold uppercase tracking-[0.12em] text-slate-600">Operator</span>
                      <select value={condition.operator} onChange={(event) => {
                        const operator = event.target.value as Operator;
                        updateCondition(condition.id, { operator });
                      }} className="h-10 w-full rounded-lg border border-white/[0.08] bg-[#131a23] px-2.5 text-xs text-slate-200 outline-none focus:border-red-500/50">
                        {OPERATORS.map((operator) => <option key={operator.value} value={operator.value}>{operator.label}</option>)}
                      </select>
                    </label>

                    <div>
                      <span className="mb-1 block text-[9px] font-bold uppercase tracking-[0.12em] text-slate-600">Compare</span>
                      <div className="flex h-10 rounded-lg border border-white/[0.08] bg-[#131a23] p-1">
                        <button type="button" onClick={() => updateCondition(condition.id, { mode: 'value' })} className={`flex-1 rounded-md px-2 text-[10px] font-semibold ${condition.mode === 'value' ? 'bg-white/[0.1] text-white' : 'text-slate-500 hover:text-slate-300'}`}>Value</button>
                        <button type="button" onClick={() => updateCondition(condition.id, { mode: 'field' })} className={`flex-1 rounded-md px-2 text-[10px] font-semibold ${condition.mode === 'field' ? 'bg-white/[0.1] text-white' : 'text-slate-500 hover:text-slate-300'}`}>Other field</button>
                      </div>
                    </div>

                    {condition.mode === 'field' ? (
                      <label className="block">
                        <span className="mb-1 block text-[9px] font-bold uppercase tracking-[0.12em] text-slate-600">Other field</span>
                        <select value={condition.compareTo} onChange={(event) => updateCondition(condition.id, { compareTo: event.target.value })} className="h-10 w-full rounded-lg border border-white/[0.08] bg-[#131a23] px-2.5 text-xs text-slate-200 outline-none focus:border-red-500/50">
                          <option value="">Choose a field</option>
                          {featuresByGroup.map(([group, fields]) => <optgroup key={group} label={group}>{fields.filter((feature) => feature.name !== condition.field).map((feature) => <option key={feature.name} value={feature.name}>{fieldLabel(feature.name)}</option>)}</optgroup>)}
                        </select>
                      </label>
                    ) : (
                      <label className="block">
                        <span className="mb-1 block text-[9px] font-bold uppercase tracking-[0.12em] text-slate-600">Value</span>
                        <input type={usesFormattedNumericInput(condition.field) ? 'text' : 'number'} inputMode={usesFormattedNumericInput(condition.field) ? 'decimal' : undefined} value={condition.value} onChange={(event) => updateCondition(condition.id, { value: event.target.value })} placeholder={supportsMagnitudeSuffix(condition.field) ? (supportsCurrencySymbol(condition.field) ? 'e.g. $500M, $1B, $1T' : 'e.g. 20K, 20M, 2B') : supportsPercentageSymbol(condition.field) ? 'e.g. 5%' : supportsRatioSymbol(condition.field) ? 'e.g. 2x' : 'Enter value'} className="h-10 w-full rounded-lg border border-white/[0.08] bg-[#131a23] px-2.5 font-mono text-xs text-slate-200 outline-none placeholder:text-slate-600 focus:border-red-500/50" />
                      </label>
                    )}

                    <button type="button" onClick={() => setConditions((current) => current.filter((item) => item.id !== condition.id))} className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-slate-600 transition hover:bg-red-500/[0.1] hover:text-red-300" aria-label="Remove condition" title="Remove condition">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="mt-4 rounded-lg border border-white/[0.05] bg-black/10 px-3.5 py-3 text-[11px] leading-5 text-slate-500">
              Search filters daily stock observations using the selected features. No returns or other analysis metrics are calculated.
            </div>
          </div>
        </div>
      </section>

      {(result !== null || loading || queryError) && (
        <section className="qm-overview-card ml-auto w-full max-w-[600px] overflow-hidden">
          <header className="qm-overview-header">
            <div className="qm-overview-header-copy">
              <h3 className="qm-overview-header-title">Filtered Universe</h3>
              <p className="qm-overview-header-subtitle">Matching daily stock observations</p>
            </div>
            <span className="qm-overview-header-code">N</span>
          </header>
          <div className="px-4 py-3">
            <div className="flex h-[42px] items-center justify-between">
              <span className="text-[10px] uppercase text-[#718096]">Total Results</span>
              <strong className="font-mono text-[26px] text-[#4ADE80]">
                {loading ? <LoaderCircle className="h-5 w-5 animate-spin" /> : queryError ? 'ERR' : RESULT_FORMATTER.format(result ?? 0)}
              </strong>
            </div>
            {queryError && <p className="mt-1 truncate font-mono text-[9px] text-[#EF4444]" title={queryError}>{queryError}</p>}
          </div>
        </section>
      )}

      {result === null && !loading && !queryError && !catalogError && (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-dashed border-white/[0.08] px-4 py-10 text-sm text-slate-600"><Activity className="h-4 w-4" /> Set your filters and click Search stocks.</div>
      )}
    </div>
  );
}
