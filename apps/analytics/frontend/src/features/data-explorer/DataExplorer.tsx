import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useOutletContext } from 'react-router';
import { Search, ArrowUpDown, ArrowUp, ArrowDown, ChevronUp, ChevronDown, Download, X, BarChart2, Eye, Check, Plus, RotateCcw, SlidersHorizontal, DollarSign, BarChart3, Activity, Clock, TrendingUp, LineChart } from 'lucide-react';
import { invoke } from '@tauri-apps/api/core';
import { Input } from '../../shared/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../shared/components/ui/dialog';
import FilterBar from '../filters/FilterBar';
import { useFilters } from '../filters/FilterContext';
import { queryDailyAnalytics, loadDailyFeatureCatalog, type DailyFeatureInfo } from '../daily/api';
import { buildTableColumns, downloadDailyCsv, groupKey, normalizeDailyRow, normalizeTicker, withExplorerSearch, type ColumnDef } from '../daily/dailyTable';
import SessionChart, { type BarCandle, type VolumeMode } from './SessionChart';

const PAGE_SIZE = 20;
const SEARCH_DEBOUNCE_MS = 120;

type ColKey = string;
type ChartTimeframe = '30s' | '15s' | '10s' | '5s' | '3s' | '1s' | '1m' | '2m' | '3m' | '5m' | '10m' | '15m' | '30m' | '1h' | '4h' | '1D';
const SUBMINUTE_TIMEFRAMES: ChartTimeframe[] = ['30s', '15s', '10s', '5s', '3s', '1s'];
const SUBMINUTE_CACHE_MAX_BARS = 150_000;
type SubminuteChartCache = {
  key: string;
  includeDelta: boolean;
  byTimeframe: Map<ChartTimeframe, BarCandle[]>;
  totalBars: number;
};
const PINNED_COLUMNS: ColKey[] = ['date', 'ticker'];
const SHORT_SECTION_LABELS: Record<string, string> = {
  GENERAL: 'General',
  'SIZE & LIQUIDITY': 'Liquidity',
  'PRICE & GAP': 'Price',
  MOMENTUM: 'Momentum',
  RETURNS: 'Returns',
  VOLATILITY: 'Volatility',
  OTHER: 'Other',
};

function formatCell(key: ColKey, value: any, columns: ColumnDef[]): JSX.Element {
  if (value === null || value === undefined) return <span className="text-[#4A5568]">-</span>;
  const col = columns.find((c) => c.key === key)!;

  if (col.type === 'date') {
    return <span className="font-mono text-[11px] font-semibold text-[#A9B7CB]">{formatDateCell(value)}</span>;
  }

  if (col.type === 'ticker') {
    return <span className="font-mono text-[12px] font-black text-[#E6EDF6]">{String(value)}</span>;
  }

  if (col.type === 'price') {
    const v = Number(value);
    if (!Number.isFinite(v)) return <span className="text-[#4A5568]">-</span>;
    return <span className="font-mono text-[11px] font-semibold tabular-nums text-[#C7D2E1]">${v.toFixed(2)}</span>;
  }

  if (col.type === 'money') {
    const v = Number(value);
    if (!Number.isFinite(v)) return <span className="text-[#4A5568]">-</span>;
    return <span className="font-mono text-[11px] font-semibold tabular-nums text-[#FCA5A5]">{formatMoney(v)}</span>;
  }

  if (col.type === 'ratio') {
    const v = Number(value);
    if (!Number.isFinite(v)) return <span className="text-[#4A5568]">-</span>;
    return <span className="font-mono text-[11px] font-semibold tabular-nums text-[#C7D2E1]">{v.toFixed(2)}x</span>;
  }

  if (col.type === 'count') {
    const v = Number(value);
    if (!Number.isFinite(v)) return <span className="text-[#4A5568]">-</span>;
    return <span className="font-mono text-[11px] font-semibold tabular-nums text-[#C7D2E1]">{Math.trunc(v).toLocaleString('en-US')}</span>;
  }

  if (col.type === 'ret') {
    const v = Number(value);
    if (!Number.isFinite(v)) return <span className="text-[#4A5568]">-</span>;
    return <PillValue value={v} signed />;
  }

  if (col.type === 'pct') {
    const v = Number(value);
    if (!Number.isFinite(v)) return <span className="text-[#4A5568]">-</span>;
    return <PillValue value={v} />;
  }

  if (col.type === 'vol') {
    const v = Number(value);
    if (!Number.isFinite(v)) return <span className="text-[#4A5568]">-</span>;
    return <span className="font-mono text-[11px] font-semibold tabular-nums text-[#A0AEC0]">{formatVolume(v)}</span>;
  }

  if (col.type === 'dir') {
    const v = Number(value);
    return (
      <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 text-[10px] font-black ${
        v > 0
          ? 'border-[rgba(52,211,153,0.28)] bg-[rgba(52,211,153,0.12)] text-[#34D399]'
          : v < 0
            ? 'border-[rgba(248,113,113,0.28)] bg-[rgba(248,113,113,0.12)] text-[#F87171]'
            : 'border-[rgba(113,128,150,0.24)] bg-[rgba(113,128,150,0.10)] text-[#718096]'
      }`}>
        {v > 0 ? 'UP' : v < 0 ? 'DN' : '-'}
      </span>
    );
  }

  if (col.type === 'time') {
    return <span className="font-mono text-[11px] font-semibold tabular-nums text-[#F87171]">{formatTimeCell(value)}</span>;
  }

  return <span className="text-[#A0AEC0]">{String(value)}</span>;
}

function extractDate(row: Record<string, any>): string {
  const raw = String(row['date'] ?? row['reference_date'] ?? '');
  return raw.replace(/^Date\((.+)\)$/, '$1').replace(/^"(.+)"$/, '$1').slice(0, 10);
}


function commandErrorMessage(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object') {
    const detail = error as Record<string, unknown>;
    const message = typeof detail.message === 'string' ? detail.message : '';
    const code = typeof detail.code === 'string' ? detail.code : '';
    if (message) return code ? `${code}: ${message}` : message;
    try {
      return JSON.stringify(detail);
    } catch {
      return Object.prototype.toString.call(error);
    }
  }
  return String(error);
}

function PillValue({ value, signed = false }: { value: number; signed?: boolean }) {
  const positive = value > 0;
  const negative = value < 0;
  const tone = negative
    ? 'border-[rgba(248,113,113,0.20)] bg-[rgba(248,113,113,0.12)] text-[#F87171]'
    : positive
      ? 'border-[rgba(52,211,153,0.20)] bg-[rgba(52,211,153,0.12)] text-[#34D399]'
      : 'border-[rgba(113,128,150,0.18)] bg-[rgba(113,128,150,0.10)] text-[#8A97AA]';

  return (
    <span className={`inline-flex min-w-[64px] justify-center rounded-full border px-2 py-0.5 font-mono text-[11px] font-black tabular-nums ${tone}`}>
      {signed && positive ? '+' : ''}{value.toFixed(2)}%
    </span>
  );
}

function formatDateCell(value: any): string {
  const clean = String(value).replace(/^Date\((.+)\)$/, '$1').replace(/^"(.+)"$/, '$1').slice(0, 10);
  const [year, month, day] = clean.split('-').map((part) => Number(part));
  if (!year || !month || !day) return clean || '-';
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(Date.UTC(year, month - 1, day)));
}

function formatTimeCell(value: any): string {
  const clean = String(value).trim().replace(/^Time\((.+)\)$/, '$1').replace(/^"(.+)"$/, '$1');
  const match = clean.match(/(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : clean || '-';
}

function formatVolume(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return value.toFixed(0);
}

function formatMoney(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `$${(value / 1_000_000_000).toFixed(2)}B`;
  if (abs >= 1_000_000) return `$${(value / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${(value / 1_000).toFixed(1)}K`;
  return `$${value.toFixed(0)}`;
}

function categoryIcon(group: string) {
  if (group === 'Identity') return SlidersHorizontal;
  if (group.includes('Price') || group === 'VWAP') return DollarSign;
  if (group.includes('Volume')) return BarChart3;
  if (group.includes('Fade')) return TrendingUp;
  if (group.includes('Spike') || group === 'Behavior') return Activity;
  if (group.includes('Return')) return LineChart;
  if (group.includes('Timing')) return Clock;
  return LineChart;
}

export interface DataExplorerProps {
  title?: string;
}

export default function DataExplorer({ title = 'Data Explorer' }: DataExplorerProps = {}) {
  const { dataRoot } = useOutletContext<{ dataRoot: string }>();
  const { dailySearch, explorerView, setExplorerView } = useFilters();
  const { search, sortCol, sortDesc } = explorerView;

  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<Record<string, any>[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isExporting, setIsExporting] = useState(false);
  const [featureCatalog, setFeatureCatalog] = useState<DailyFeatureInfo[]>([]);
  const [catalogReady, setCatalogReady] = useState(false);
  const [catalogError, setCatalogError] = useState<string | null>(null);

  const [selectedRow, setSelectedRow] = useState<Record<string, any> | null>(null);
  const [candles, setCandles] = useState<BarCandle[]>([]);
  const [chartLoading, setChartLoading] = useState(false);
  const [chartLoadProgress, setChartLoadProgress] = useState(0);
  const [chartLoadingTimeframe, setChartLoadingTimeframe] = useState<ChartTimeframe>('1D');
  const [chartLoadingVolumeMode, setChartLoadingVolumeMode] = useState<VolumeMode>('volume');
  const [chartError, setChartError] = useState<string | null>(null);
  const [chartOpen, setChartOpen] = useState(false);
  const [activeExplorerTab, setActiveExplorerTab] = useState<'chart' | 'list'>('list');
  const [chartTimeframe, setChartTimeframe] = useState<ChartTimeframe>('1D');
  const [volumeMode, setVolumeMode] = useState<VolumeMode>('volume');
  const tableColumns = useMemo(() => buildTableColumns(featureCatalog), [featureCatalog]);
  const defaultColumns = useMemo(() => tableColumns.filter((column) => column.defaultVisible).map((column) => column.key), [tableColumns]);
  const pinnedColumns = PINNED_COLUMNS;
  const availableGroups = useMemo(() => tableColumns.reduce<Array<{ section: string; group: string }>>((groups, column) => groups.some((g) => g.section === column.section && g.group === column.group) ? groups : [...groups, { section: column.section, group: column.group }], []), [tableColumns]);
  const firstGroup = groupKey(availableGroups[0]?.section ?? 'GENERAL', availableGroups[0]?.group ?? 'Identity');
  const [selectedColumns, setSelectedColumns] = useState<ColKey[]>([]);
  const [columnPickerOpen, setColumnPickerOpen] = useState(false);
  const [columnCategory, setColumnCategory] = useState('GENERAL::Identity');

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rowRequestRef = useRef(0);
  const chartRequestRef = useRef(0);
  const subminuteCacheRef = useRef<SubminuteChartCache | null>(null);
  const dailyChartCacheRef = useRef(new Map<string, BarCandle[]>());
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const baseFilter = dailySearch.filter;
  const baseFilterKey = baseFilter ? JSON.stringify(baseFilter) : '';
  const queryEnabled = baseFilter !== null && dailySearch.resultCount !== null && !dailySearch.isLoading && dailySearch.error === null;
  const activeFilterCount = baseFilter
    ? baseFilter.conditions.length + Number(Boolean(baseFilter.dateFrom || baseFilter.dateTo)) + Number(Boolean(baseFilter.ticker)) + Number(baseFilter.maxEventsPerDay != null)
    : 0;
  const usesMassiveChartDownload = SUBMINUTE_TIMEFRAMES.includes(chartLoadingTimeframe) || chartLoadingVolumeMode === 'delta';
  const visibleColumns = useMemo(
    () => tableColumns.filter((column) => selectedColumns.includes(column.key)),
    [selectedColumns, tableColumns],
  );

  useEffect(() => {
    let active = true;
    setCatalogReady(false);
    setCatalogError(null);
    void loadDailyFeatureCatalog(dataRoot)
      .then((catalog) => {
        if (active) setFeatureCatalog(catalog);
      })
      .catch((loadError) => {
        if (active) {
          setFeatureCatalog([]);
          setCatalogError(String(loadError));
        }
      })
      .finally(() => {
        if (active) setCatalogReady(true);
      });
    return () => { active = false; };
  }, [dataRoot]);

  useEffect(() => {
    if (!catalogReady) return;
    const validKeys = new Set(tableColumns.map((column) => column.key));
    setSelectedColumns((current) => {
      const retained = current.filter((key) => validKeys.has(key));
      if (retained.length === 0) return defaultColumns;
      return Array.from(new Set([...pinnedColumns, ...retained]));
    });
  }, [catalogReady, defaultColumns, pinnedColumns, tableColumns]);

  useEffect(() => {
    if (!availableGroups.some(({ section, group }) => groupKey(section, group) === columnCategory)) {
      setColumnCategory(firstGroup);
    }
  }, [availableGroups, columnCategory, firstGroup]);
  const clearSubminuteChartCache = useCallback(() => {
    const cache = subminuteCacheRef.current;
    if (cache) {
      cache.byTimeframe.clear();
      cache.totalBars = 0;
    }
    subminuteCacheRef.current = null;
  }, []);

  useEffect(() => clearSubminuteChartCache, [clearSubminuteChartCache]);

  useEffect(() => {
    if (!chartLoading || !usesMassiveChartDownload) return;

    // The Massive endpoint is paginated and does not expose a reliable total
    // before all trade/quote pages have been read. Advance the compact UI
    // indicator while the existing download is running, then finish it when
    // the command resolves.
    const progressTimer = window.setInterval(() => {
      setChartLoadProgress((current) => current >= 88 ? current : Math.min(88, current + (current < 40 ? 4 : 2)));
    }, 450);

    return () => window.clearInterval(progressTimer);
  }, [chartLoading, usesMassiveChartDownload]);

  const fetchRows = useCallback(async (_page: number, _search: string, _sortCol: string, _sortDesc: boolean) => {
    if (!baseFilter) return;
    const requestId = ++rowRequestRef.current;
    setIsLoading(true);
    setError(null);
    try {
      const result = await queryDailyAnalytics(dataRoot, withExplorerSearch(baseFilter, _search), _page, PAGE_SIZE, _sortCol, _sortDesc);
      if (requestId !== rowRequestRef.current) return;
      setRows(result.rows.map(normalizeDailyRow));
      setTotal(result.totalRows);
    } catch (e) {
      if (requestId === rowRequestRef.current) {
        setError(String(e));
        setRows([]);
        setTotal(0);
      }
    } finally {
      if (requestId === rowRequestRef.current) setIsLoading(false);
    }
  }, [baseFilter, dataRoot]);

  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (!queryEnabled) {
      rowRequestRef.current += 1;
      setRows([]);
      setTotal(0);
      setIsLoading(false);
      setError(null);
      return;
    }
    timerRef.current = setTimeout(() => fetchRows(page, search, sortCol, sortDesc), search.trim() ? SEARCH_DEBOUNCE_MS : 0);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryEnabled, baseFilterKey, search, sortCol, sortDesc, page, fetchRows]);

  useEffect(() => {
    setPage(1);
  }, [queryEnabled, baseFilterKey, search, sortCol, sortDesc]);

  const handleSort = (col: ColKey) => {
    setExplorerView({ ...explorerView, sortCol: col, sortDesc: sortCol === col ? !sortDesc : true });
  };

  const toggleColumn = (column: ColKey) => {
    if (pinnedColumns.includes(column)) return;
    setSelectedColumns((current) => {
      if (current.includes(column)) return current.filter((item) => item !== column);
      const next = tableColumns.map((candidate) => candidate.key).filter((key) => current.includes(key) || key === column);
      return next;
    });
  };

  const resetColumns = () => {
    setSelectedColumns([...defaultColumns]);
    setColumnCategory(firstGroup);
  };

  const loadChart = useCallback(async (row: Record<string, any>) => {
    const ticker = normalizeTicker(row['ticker']);
    const date = extractDate(row);
    if (!ticker || !date) return;
    const requestId = ++chartRequestRef.current;
    const cacheKey = `${dataRoot}|${ticker}|split-adjusted-v1`;
    const cachedCandles = dailyChartCacheRef.current.get(cacheKey);
    const cachedThroughDate = cachedCandles?.at(-1)?.time.slice(0, 10) ?? '';

    setChartLoadingTimeframe('1D');
    setChartLoadingVolumeMode('volume');
    setChartError(null);
    setVolumeMode('volume');
    setChartTimeframe('1D');

    if (cachedCandles && cachedThroughDate >= date) {
      setCandles(cachedCandles.filter((candle) => candle.time.slice(0, 10) <= date));
      setChartLoading(false);
      return;
    }

    setChartLoading(true);
    setChartLoadProgress(0);
    try {
      const fetchedCandles = await invoke<BarCandle[]>('daily_ticker_candles', {
        ticker,
        dateTo: date,
        dataRoot,
      });
      if (requestId !== chartRequestRef.current) return;

      const byDate = new Map<string, BarCandle>();
      for (const candle of cachedCandles ?? []) byDate.set(candle.time.slice(0, 10), candle);
      for (const candle of fetchedCandles) byDate.set(candle.time.slice(0, 10), candle);
      const allCandles = Array.from(byDate.values()).sort((left, right) => left.time.localeCompare(right.time));
      dailyChartCacheRef.current.set(cacheKey, allCandles);
      if (dailyChartCacheRef.current.size > 32) {
        const oldestKey = dailyChartCacheRef.current.keys().next().value;
        if (oldestKey) dailyChartCacheRef.current.delete(oldestKey);
      }

      setCandles(allCandles.filter((candle) => candle.time.slice(0, 10) <= date));
    } catch (loadError) {
      if (requestId !== chartRequestRef.current) return;
      setChartError(commandErrorMessage(loadError));
      setCandles([]);
    } finally {
      if (requestId === chartRequestRef.current) setChartLoading(false);
    }
  }, [dataRoot]);

  const selectedRowIndex = useMemo(() => {
    if (!selectedRow) return -1;
    const selectedTicker = String(selectedRow['ticker'] ?? '');
    const selectedDate = extractDate(selectedRow);
    return rows.findIndex((row) => row === selectedRow || (
      String(row['ticker'] ?? '') === selectedTicker && extractDate(row) === selectedDate
    ));
  }, [rows, selectedRow]);

  const navigateChartRow = useCallback((offset: -1 | 1) => {
    if (!chartOpen || activeExplorerTab !== 'chart' || selectedRowIndex < 0) return;
    const nextIndex = selectedRowIndex + offset;
    if (nextIndex < 0 || nextIndex >= rows.length) return;
    const nextRow = rows[nextIndex];
    setSelectedRow(nextRow);
    void loadChart(nextRow);
  }, [activeExplorerTab, chartOpen, loadChart, rows, selectedRowIndex]);

  useEffect(() => {
    const handleChartNavigationKey = (event: KeyboardEvent) => {
      if (!chartOpen || activeExplorerTab !== 'chart') return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? '')) return;
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;

      event.preventDefault();
      navigateChartRow(event.key === 'ArrowUp' ? -1 : 1);
    };

    window.addEventListener('keydown', handleChartNavigationKey);
    return () => window.removeEventListener('keydown', handleChartNavigationKey);
  }, [activeExplorerTab, chartOpen, navigateChartRow]);

  const openChart = async (row: Record<string, any>) => {
    setSelectedRow(row);
    setChartOpen(true);
    setActiveExplorerTab('chart');
    await loadChart(row);
  };

  const selectRow = (row: Record<string, any>) => {
    setSelectedRow(row);
    if (chartOpen && activeExplorerTab === 'chart') {
      void loadChart(row);
    }
  };

  const handleTimeframeChange = async (timeframe: ChartTimeframe) => {
    if (timeframe === chartTimeframe) return;
    if (chartOpen && selectedRow) await loadChart(selectedRow);
  };

  const handleVolumeModeChange = async (nextMode: VolumeMode) => {
    if (nextMode !== 'volume') return;
    if (nextMode === volumeMode) return;
    setVolumeMode(nextMode);
    if (chartOpen && selectedRow) await loadChart(selectedRow);
  };

  const handleExport = async () => {
    if (!queryEnabled || !baseFilter || total <= 0 || isExporting) return;
    setIsExporting(true);
    setError(null);
    try {
      const exportColumns = visibleColumns.length ? visibleColumns : tableColumns.filter((column) => defaultColumns.includes(column.key));
      await downloadDailyCsv(dataRoot, withExplorerSearch(baseFilter, search), sortCol, sortDesc, exportColumns);
    } catch (e) {
      setError(`CSV export failed: ${String(e)}`);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="flex h-full min-h-[calc(100vh-56px)] flex-col bg-[#080A0F]">
      <FilterBar />

      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="shrink-0 border-b border-[rgba(255,255,255,0.08)] bg-[#0A0E14] px-3 py-3">
            <div className="mb-3 flex items-center justify-between gap-3">
              <div>
                <h2 className="text-base font-bold tracking-tight text-[#E1E7EF]">{title}</h2>
                <p className="mt-0.5 font-mono text-[10px] text-[#66748A]">
                  {!queryEnabled
                    ? dailySearch.isLoading ? 'Searching daily filters...' : dailySearch.error ? 'Daily filter search failed' : 'Run Search in the filter bar to load matching tickers'
                    : isLoading
                      ? 'Loading...'
                      : error
                        ? 'Error loading filtered ticker-days'
                        : `${total.toLocaleString()} ticker-days · ${activeFilterCount} active filters · double-click ticker to chart`}
                </p>
                {catalogError && <p className="mt-1 max-w-[560px] truncate text-[10px] text-[#F87171]" title={catalogError}>Could not load current feature columns</p>}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setColumnPickerOpen(true)}
                  className="flex h-8 items-center gap-2 rounded-lg border border-[rgba(22,101,52,0.50)] bg-[rgba(22,101,52,0.18)] px-3 text-[11px] font-bold text-green-300 transition-all hover:border-[rgba(21,128,61,0.75)] hover:bg-[rgba(22,101,52,0.28)]"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Columns
                  <span className="font-mono text-white">{selectedColumns.length} selected</span>
                </button>
                <button
                  type="button"
                  onClick={resetColumns}
                  className="flex h-8 items-center gap-1.5 rounded-lg border border-[rgba(220,38,38,0.32)] bg-transparent px-3 text-[11px] font-bold text-[#FCA5A5] transition-all hover:bg-[rgba(220,38,38,0.10)]"
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                  Reset
                </button>
                <div className="relative">
                  <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#718096]" />
                  <Input
                    type="text"
                    placeholder="ticker or date..."
                    value={search}
                  onChange={(e) => setExplorerView({ ...explorerView, search: e.target.value })}
                    disabled={!queryEnabled}
                    className="h-8 w-44 border-[rgba(255,255,255,0.08)] bg-[#141A22] pl-8 text-[12px] text-[#E1E7EF] focus:border-[rgba(220,38,38,0.45)]"
                  />
                </div>
                <button
                  onClick={() => { void handleExport(); }}
                  disabled={!queryEnabled || total === 0 || isExporting}
                  className="flex items-center gap-1.5 rounded-lg border border-[rgba(255,255,255,0.08)] bg-[#141A22] px-3 py-1.5 text-[11px] font-bold text-[#A0AEC0] transition-all hover:border-[rgba(220,38,38,0.35)] hover:text-[#F87171] disabled:opacity-30"
                >
                  <Download className="h-3.5 w-3.5" />
                  {isExporting ? 'Exporting…' : `CSV (${total.toLocaleString()})`}
                </button>
              </div>
            </div>

            <ColumnPickerDialog
              open={columnPickerOpen}
              selectedColumns={selectedColumns}
              activeCategory={columnCategory}
              onOpenChange={setColumnPickerOpen}
              onCategoryChange={setColumnCategory}
              onToggleColumn={toggleColumn}
              onReset={resetColumns}
              onShowAll={() => setSelectedColumns(tableColumns.map((column) => column.key))}
              tableColumns={tableColumns}
              availableGroups={availableGroups}
              pinnedColumns={pinnedColumns}
            />
          </div>

          {selectedRow && (!chartOpen || activeExplorerTab === 'list') && (
            <SelectedSessionStrip row={selectedRow} onOpenChart={() => void openChart(selectedRow)} />
          )}

          <div className="flex min-h-0 flex-1 flex-col bg-[#080A0F]">
            <div className="flex shrink-0 items-center justify-between gap-3 border-b border-[rgba(255,255,255,0.08)] bg-[#0D1117] px-3 py-2">
              <div className="inline-flex rounded-lg border border-[rgba(255,255,255,0.08)] bg-[#080C12] p-1">
                <button
                  type="button"
                  onClick={() => {
                    clearSubminuteChartCache();
                    setActiveExplorerTab('list');
                  }}
                  className={`rounded-md px-3 py-1.5 text-[11px] font-bold transition-all ${
                    activeExplorerTab === 'list'
                      ? 'bg-[rgba(220,38,38,0.18)] text-[#FCA5A5]'
                      : 'text-[#718096] hover:text-[#E1E7EF]'
                  }`}
                >
                  List
                </button>
                <button
                  type="button"
                  onClick={() => {
                    if (selectedRow) {
                      setChartOpen(true);
                      setActiveExplorerTab('chart');
                      void loadChart(selectedRow);
                    }
                  }}
                  disabled={!selectedRow}
                  className={`rounded-md px-3 py-1.5 text-[11px] font-bold transition-all disabled:opacity-30 ${
                    activeExplorerTab === 'chart'
                      ? 'bg-[rgba(220,38,38,0.16)] text-[#FECACA]'
                      : 'text-[#718096] hover:text-[#E1E7EF]'
                  }`}
                >
                  Chart
                </button>
              </div>

              {chartOpen && selectedRow && (
                <div className="flex min-w-0 items-center gap-2">
                  <span className="truncate font-mono text-[11px] font-bold text-[#E1E7EF]">
                    {normalizeTicker(selectedRow['ticker']) || '-'} {candles.length.toLocaleString()} bars {extractDate(selectedRow)}
                  </span>
                  <div className="flex items-center gap-1" aria-label="Navigate chart tickers">
                    <button
                      type="button"
                      onClick={() => navigateChartRow(-1)}
                      disabled={selectedRowIndex <= 0}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-[rgba(255,255,255,0.08)] bg-[#151B23] text-[#A0AEC0] transition-all hover:border-[rgba(220,38,38,0.45)] hover:text-[#FECACA] disabled:cursor-not-allowed disabled:opacity-30"
                      title="Previous ticker (ArrowUp)"
                      aria-label="Previous ticker"
                    >
                      <ChevronUp className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => navigateChartRow(1)}
                      disabled={selectedRowIndex < 0 || selectedRowIndex >= rows.length - 1}
                      className="inline-flex h-6 w-6 items-center justify-center rounded-md border border-[rgba(255,255,255,0.08)] bg-[#151B23] text-[#A0AEC0] transition-all hover:border-[rgba(220,38,38,0.45)] hover:text-[#FECACA] disabled:cursor-not-allowed disabled:opacity-30"
                      title="Next ticker (ArrowDown)"
                      aria-label="Next ticker"
                    >
                      <ChevronDown className="h-3.5 w-3.5" />
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      clearSubminuteChartCache();
                      setChartOpen(false);
                      setActiveExplorerTab('list');
                    }}
                    className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-[rgba(255,255,255,0.08)] bg-[#151B23] text-[#718096] transition-all hover:border-[rgba(239,68,68,0.3)] hover:text-[#EF4444]"
                    title="Close chart"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}
            </div>

            {activeExplorerTab === 'chart' && chartOpen && (
              <div className="relative min-h-[560px] flex-1 bg-[#000000]">
                {chartLoading && (
                  <div className="absolute inset-0 z-30 flex min-h-[560px] flex-col items-center justify-center gap-3 bg-[rgba(0,0,0,0.72)]">
                    {usesMassiveChartDownload ? (
                      <div
                        className="h-1.5 w-56 overflow-hidden rounded-full bg-[#1B2230] shadow-[0_0_12px_rgba(220,38,38,0.16)]"
                        role="progressbar"
                        aria-label="Loading chart data"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(chartLoadProgress)}
                      >
                        <div
                          className="h-full rounded-full bg-gradient-to-r from-[#166534] to-[#4ADE80] transition-[width] duration-300 ease-out"
                          style={{ width: `${chartLoadProgress}%` }}
                        />
                      </div>
                    ) : (
                      <div className="h-7 w-7 animate-spin rounded-full border-2 border-[#1F2430] border-t-[#22C55E]" />
                    )}
                    <p className="text-[11px] text-[#787B86]">
                      {usesMassiveChartDownload
                        ? chartLoadingVolumeMode === 'delta' && !SUBMINUTE_TIMEFRAMES.includes(chartLoadingTimeframe)
                          ? `Loading stored ${chartLoadingTimeframe} candles + 30s volume delta...`
                          : `Loading ${chartLoadingTimeframe} bars from Massive...`
                        : `Loading ${chartLoadingTimeframe} bars...`}
                    </p>
                  </div>
                )}
                {!chartLoading && chartError && (
                  <div className="flex h-full min-h-[560px] flex-col items-center justify-center gap-2 px-8">
                    <p className="text-center text-xs text-[#EF5350]">{chartError.slice(0, 200)}</p>
                    <p className="text-[10px] text-[#787B86]">Could not load daily bars for this ticker</p>
                  </div>
                )}
                {!chartLoading && !chartError && candles.length === 0 && selectedRow && (
                  <div className="flex h-full min-h-[560px] flex-col items-center justify-center gap-2">
                    <p className="text-sm font-medium text-[#787B86]">No chart data available</p>
                    <p className="font-mono text-[10px] text-[#4A5568]">{String(selectedRow['ticker'])} · {extractDate(selectedRow)}</p>
                  </div>
                )}
                {!chartLoading && !chartError && candles.length > 0 && selectedRow && (
                  <div className="absolute inset-0">
                    <SessionChart
                      candles={candles}
                      ticker={normalizeTicker(selectedRow['ticker'])}
                      date={extractDate(selectedRow)}
                      timeframe={chartTimeframe}
                      initialVisibleBars={180}
                      availableTimeframes={['1D']}
                      availableVolumeModes={['volume']}
                      volumeMode={volumeMode}
                      onTimeframeChange={(timeframe) => { void handleTimeframeChange(timeframe); }}
                      onVolumeModeChange={(mode) => { void handleVolumeModeChange(mode); }}
                    />
                  </div>
                )}
              </div>
            )}

            {activeExplorerTab === 'list' && (
              <div className="min-h-[260px] flex-1 overflow-auto p-3">
            <table className="w-full min-w-[1080px] overflow-hidden rounded-lg border border-[rgba(255,255,255,0.085)] bg-[#0A0E14] text-sm shadow-[0_14px_30px_rgba(0,0,0,0.22)]">
              <thead className="sticky top-0 z-10">
                <tr className="border-b border-[rgba(255,255,255,0.08)] bg-[linear-gradient(180deg,rgba(17,24,34,0.98),rgba(13,17,23,0.98))] shadow-[0_5px_14px_rgba(0,0,0,0.16)]">
                  <th className="w-8 px-3 py-2.5"><Eye className="mx-auto h-3.5 w-3.5 text-[#64748B]" /></th>
                  {visibleColumns.map((col) => (
                    <th key={col.key} className="whitespace-nowrap px-3 py-2.5 text-left">
                      <button
                        onClick={() => handleSort(col.key as ColKey)}
                        disabled={!queryEnabled}
                        className="flex items-center gap-1 text-[10px] font-black uppercase tracking-wide text-[#718096] transition-colors hover:text-green-300 disabled:hover:text-[#718096]"
                      >
                        {col.label}
                        {sortCol === col.key
                          ? sortDesc ? <ArrowDown className="h-3 w-3 text-[#DC2626]" /> : <ArrowUp className="h-3 w-3 text-[#DC2626]" />
                          : <ArrowUpDown className="h-3 w-3 text-[#586174]" />}
                      </button>
                    </th>
                  ))}
                  <th className="sticky right-0 z-20 w-20 whitespace-nowrap bg-[#0D1117] px-3 py-2.5 text-right">
                    <span className="text-[10px] font-black uppercase tracking-wide text-[#718096]">Chart</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {isLoading && Array.from({ length: PAGE_SIZE }).map((_, i) => (
                  <tr key={i} className="border-b border-[rgba(255,255,255,0.035)] bg-[#0B1017]">
                    <td className="px-2 py-2"><div className="h-3 w-4 animate-pulse rounded bg-[rgba(255,255,255,0.04)]" /></td>
                    {visibleColumns.map((c) => (
                      <td key={c.key} className="px-2 py-2">
                        <div className="h-3 animate-pulse rounded bg-[rgba(255,255,255,0.04)]" style={{ width: `${35 + (c.key.length * 3)}%` }} />
                      </td>
                    ))}
                    <td className="px-2 py-2"><div className="ml-auto h-6 w-14 animate-pulse rounded bg-[rgba(255,255,255,0.04)]" /></td>
                  </tr>
                ))}
                {!isLoading && error && (
                  <tr><td colSpan={visibleColumns.length + 2} className="px-4 py-8 text-center font-mono text-xs text-[#EF4444]">{error.slice(0, 300)}</td></tr>
                )}
                {!isLoading && !error && !queryEnabled && (
                  <tr>
                    <td colSpan={visibleColumns.length + 2} className="px-4 py-16 text-center">
                      <div className="mx-auto max-w-[360px] rounded-lg border border-[rgba(255,255,255,0.08)] bg-[#0D1117] px-5 py-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]">
                        <div className="mx-auto mb-3 flex h-9 w-9 items-center justify-center rounded-lg border border-[rgba(34,197,94,0.40)] bg-[rgba(22,101,52,0.18)]">
                          <SlidersHorizontal className="h-4 w-4 text-green-300" />
                        </div>
                        <div className="text-sm font-semibold text-[#E1E7EF]">Run Search to load filtered tickers</div>
                        <div className="mt-1 text-[11px] leading-5 text-[#718096]">
                          The list uses the latest search from the filter bar and shows each matching ticker and market day.
                        </div>
                      </div>
                    </td>
                  </tr>
                )}
                {!isLoading && !error && queryEnabled && rows.length === 0 && (
                  <tr><td colSpan={visibleColumns.length + 2} className="py-12 text-center text-sm font-medium text-[#4A5568]">
                    No ticker-days match the current search
                  </td></tr>
                )}
                {!isLoading && !error && rows.map((row, i) => {
                  const isSelected = selectedRow === row;
                  const quality = classifySession(row);
                  return (
                    <tr
                      key={i}
                      onClick={() => selectRow(row)}
                      className={`relative cursor-pointer border-b border-[rgba(50,68,91,0.32)] transition-colors ${
                        isSelected
                          ? 'border-l-2 border-l-[#DC2626] bg-[rgba(220,38,38,0.075)]'
                          : i % 2 === 0
                            ? 'bg-[#0B1017] hover:bg-[rgba(255,255,255,0.03)]'
                            : 'bg-[#0D1117] hover:bg-[rgba(255,255,255,0.03)]'
                      }`}
                    >
                      <td className="px-3 py-2 text-center">
                        <span className="mx-auto block h-2 w-2 rounded-sm" style={{ backgroundColor: quality.color }} title={quality.label} />
                      </td>
                      {visibleColumns.map((col) => (
                        <td
                          key={col.key}
                          className={`px-3 py-2 text-[11px] ${col.key === 'ticker' ? 'cursor-pointer' : ''}`}
                          onDoubleClick={col.key === 'ticker' ? () => void openChart(row) : undefined}
                          title={col.key === 'ticker' ? 'Double-click to open chart' : undefined}
                        >
                          {formatCell(col.key as ColKey, row[col.key], tableColumns)}
                        </td>
                      ))}
                      <td className="sticky right-0 bg-[#0D1117]/95 px-3 py-2 text-right backdrop-blur">
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            void openChart(row);
                          }}
                          className="inline-flex min-h-[25px] items-center gap-1.5 rounded-md border border-[rgba(22,101,52,0.45)] bg-[rgba(22,101,52,0.18)] px-2 py-1 text-[11px] font-bold text-green-300 transition-all hover:border-[rgba(21,128,61,0.70)] hover:bg-[rgba(22,101,52,0.28)] hover:text-green-100"
                          title="Open chart"
                        >
                          Chart
                          <BarChart2 className="h-3.5 w-3.5" />
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
              </div>
            )}
          </div>

          <div className="flex shrink-0 items-center justify-between border-t border-[rgba(255,255,255,0.08)] bg-[#0D1117] px-4 py-2">
            <span className="font-mono text-[10px] text-[#4A5568]">
              {total === 0 ? '-' : `${((page - 1) * PAGE_SIZE) + 1}-${Math.min(page * PAGE_SIZE, total)} / ${total.toLocaleString()}`}
            </span>
            <div className="flex items-center gap-1">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} className="rounded border border-[rgba(255,255,255,0.08)] bg-[#141A22] px-2 py-0.5 text-[11px] text-[#A0AEC0] hover:border-[rgba(255,255,255,0.15)] disabled:opacity-30">
                Prev
              </button>
              {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                let pg = i + 1;
                if (totalPages > 5) {
                  if (page <= 3) pg = i + 1;
                  else if (page >= totalPages - 2) pg = totalPages - 4 + i;
                  else pg = page - 2 + i;
                }
                return (
                  <button key={pg} onClick={() => setPage(pg)} className={`h-6 w-6 rounded text-[11px] transition-all ${pg === page ? 'bg-[#DC2626] text-white' : 'text-[#718096] hover:text-[#E1E7EF]'}`}>
                    {pg}
                  </button>
                );
              })}
              <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages} className="rounded border border-[rgba(255,255,255,0.08)] bg-[#141A22] px-2 py-0.5 text-[11px] text-[#A0AEC0] hover:border-[rgba(255,255,255,0.15)] disabled:opacity-30">
                Next
              </button>
            </div>
          </div>
        </div>

      </div>
    </div>
  );
}

function ColumnPickerDialog({
  open,
  selectedColumns,
  activeCategory,
  onOpenChange,
  onCategoryChange,
  onToggleColumn,
  onReset,
  onShowAll,
  tableColumns,
  availableGroups,
  pinnedColumns,
}: {
  open: boolean;
  selectedColumns: ColKey[];
  activeCategory: string;
  onOpenChange: (open: boolean) => void;
  onCategoryChange: (category: string) => void;
  onToggleColumn: (column: ColKey) => void;
  onReset: () => void;
  onShowAll: () => void;
  tableColumns: ColumnDef[];
  availableGroups: Array<{ section: string; group: string }>;
  pinnedColumns: string[];
}) {
  const [fieldSearch, setFieldSearch] = useState('');
  const columnSections = availableGroups.reduce<string[]>((sections, group) => sections.includes(group.section) ? sections : [...sections, group.section], []);
  const selectedGroupInfo = availableGroups.find(({ section, group }) => groupKey(section, group) === activeCategory) ?? availableGroups[0];
  const selectedSection = selectedGroupInfo?.section ?? 'GENERAL';
  const selectedCategoryColumns = tableColumns.filter((column) => column.category === activeCategory);
  const columnsInCategory = selectedCategoryColumns.filter((column) => {
    if (!fieldSearch.trim()) return true;
    const q = fieldSearch.trim().toLowerCase();
    return column.label.toLowerCase().includes(q) || column.key.toLowerCase().includes(q) || column.group.toLowerCase().includes(q) || column.section.toLowerCase().includes(q);
  });
  const groupsWithMatches = availableGroups.filter(({ section, group }) => {
    if (section !== selectedSection) return false;
    if (!fieldSearch.trim()) return true;
    const q = fieldSearch.trim().toLowerCase();
    return tableColumns.some((column) => column.section === section && column.group === group && (column.label.toLowerCase().includes(q) || column.key.toLowerCase().includes(q)));
  });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setFieldSearch('');
      }}
    >
      <DialogContent
        className="flex flex-col overflow-hidden border border-[rgba(255,255,255,0.08)] bg-gradient-to-br from-[#151B23] via-[#131821] to-[#0F141B] p-0 text-[#E1E7EF] shadow-2xl"
        style={{
          width: 'min(1120px, calc(100vw - 2rem))',
          maxWidth: 'none',
          height: 'min(760px, 88vh)',
          maxHeight: '88vh',
        }}
      >
        <DialogHeader className="border-b border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] px-5 py-4">
          <DialogTitle className="flex items-center gap-2 text-[15px] font-semibold text-[#E1E7EF]">
            <SlidersHorizontal className="h-4 w-4 text-green-500" />
            Column definitions
          </DialogTitle>
          <DialogDescription className="text-sm text-[#8f9bb0]">
            Pick the variables that should appear in the Data Explorer table.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 grid-cols-1 overflow-hidden lg:grid-cols-[282px_minmax(0,1fr)]">
          <aside className="flex min-h-0 flex-col overflow-hidden border-b border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] p-4 lg:border-b-0 lg:border-r">
            <div className="shrink-0 space-y-3">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-[#718096]">Categories</div>
                <p className="mt-1 text-[11px] text-[#4A5568]">Select a group to browse related variables.</p>
              </div>

              <div className="relative">
                <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-[#718096]" />
                <Input
                  value={fieldSearch}
                  onChange={(event) => setFieldSearch(event.target.value)}
                  placeholder="Search variables"
                  className="h-9 border-[rgba(255,255,255,0.08)] bg-[#0D1117] pl-8 text-[13px] text-[#E1E7EF]"
                />
              </div>

              <div className="grid grid-cols-2 gap-1.5 rounded-xl border border-[rgba(255,255,255,0.08)] bg-[#0D1117] p-1.5">
                {columnSections.map((section) => {
                  const active = selectedSection === section;
                  return (
                    <button
                      key={section}
                      type="button"
                      onClick={() => {
                        const firstGroup = availableGroups.find((group) => group.section === section);
                        if (firstGroup) onCategoryChange(groupKey(firstGroup.section, firstGroup.group));
                      }}
                      className={[
                        'min-h-[34px] rounded-lg px-2.5 py-1.5 text-[11px] font-semibold leading-tight transition-all duration-150',
                        active
                          ? 'bg-[rgba(22,101,52,0.30)] text-green-200 shadow-[0_0_0_1px_rgba(21,128,61,0.35)]'
                          : 'text-[#8F9BB0] hover:bg-[rgba(255,255,255,0.04)] hover:text-[#E1E7EF]',
                      ].join(' ')}
                    >
                      {SHORT_SECTION_LABELS[section] ?? section}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1">
              <div className="space-y-1.5">
                <div className="sticky top-0 z-10 -mx-1 bg-[#171D26] px-1 pb-2 text-[10px] font-bold uppercase tracking-[0.14em] text-[#718096]">
                  {selectedSection}
                </div>
                {groupsWithMatches.map(({ section, group }) => {
                  const key = groupKey(section, group);
                  const Icon = categoryIcon(group);
                  const selectedInCategory = tableColumns.filter((column) => column.category === key && selectedColumns.includes(column.key)).length;
                  const totalInCategory = tableColumns.filter((column) => column.category === key).length;
                  const active = activeCategory === key;
                  return (
                    <button
                      key={key}
                      type="button"
                      onClick={() => onCategoryChange(key)}
                      className={[
                        'flex w-full items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 text-left transition-all duration-150',
                        active
                          ? 'border-[rgba(220,38,38,0.24)] bg-[rgba(220,38,38,0.10)] text-[#E1E7EF] shadow-[0_0_0_1px_rgba(220,38,38,0.04)]'
                          : 'border-[rgba(255,255,255,0.06)] bg-[#0D1117] text-[#A0AEC0] hover:border-[rgba(255,255,255,0.12)] hover:bg-[rgba(255,255,255,0.03)]',
                      ].join(' ')}
                    >
                      <span className="flex min-w-0 items-center gap-3">
                        <Icon className="h-4 w-4 shrink-0 text-green-300" />
                        <span className="truncate text-[13px] font-medium leading-tight">{group}</span>
                      </span>
                      <span className="rounded-md border border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.04)] px-1.5 py-0.5 font-mono text-[10px] text-[#A7B1C2]">
                        {selectedInCategory}/{totalInCategory}
                      </span>
                    </button>
                  );
                })}
              </div>
            </div>
          </aside>

          <div className="flex min-h-0 flex-col overflow-hidden bg-transparent p-5">
            <div className="mb-4 flex shrink-0 items-start justify-between gap-4">
              <div>
                <h3 className="text-[14px] font-semibold tracking-tight text-[#E1E7EF]">{selectedGroupInfo?.group ?? 'Columns'}</h3>
                <p className="mt-1 text-[11px] text-[#708096]">
                  {selectedSection} · {selectedColumns.length} visible columns. Date and ticker stay pinned for context.
                </p>
              </div>
              <div className="text-right">
                <div className="text-[10px] uppercase tracking-wide text-[#708096]">Selected</div>
                <div className="font-mono text-[13px] font-medium text-green-500">{selectedColumns.length} / {tableColumns.length}</div>
              </div>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto pr-1">
              <div className="grid justify-start gap-1.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 220px))' }}>
                {columnsInCategory.map((column) => {
                  const selected = selectedColumns.includes(column.key);
                  const pinned = pinnedColumns.includes(column.key);
                  return (
                    <button
                      key={column.key}
                      type="button"
                      disabled={pinned}
                      onClick={() => onToggleColumn(column.key)}
                      className={[
                        'min-h-[38px] rounded-lg border px-3 py-1.5 text-[11.5px] font-medium leading-tight transition-all duration-150',
                        selected
                          ? 'border-[rgba(34,197,94,0.55)] bg-[rgba(22,101,52,0.28)] text-green-200 shadow-[0_0_0_1px_rgba(34,197,94,0.16)]'
                          : 'border-[rgba(255,255,255,0.04)] bg-[#1A222D] text-[#7E8A9E] hover:border-[rgba(255,255,255,0.08)] hover:bg-[#202A36] hover:text-[#AFC6DD]',
                        pinned ? 'cursor-not-allowed opacity-80' : '',
                      ].join(' ')}
                    >
                      <span className="flex items-center justify-center gap-2 text-center">
                        {selected && <Check className="h-3.5 w-3.5 shrink-0" />}
                        {column.label}
                      </span>
                    </button>
                  );
                })}
              </div>

              {columnsInCategory.length === 0 && (
                <div className="mt-8 text-center text-[12px] text-[#586174]">
                  No variables match this category and search.
                </div>
              )}
            </div>
          </div>
        </div>

        <DialogFooter className="shrink-0 border-t border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] px-5 py-4">
          <button
            type="button"
            onClick={onReset}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[rgba(255,255,255,0.08)] bg-[#0D1117] px-3 py-2 text-[12px] font-semibold text-[#A0AEC0] transition-all hover:bg-[rgba(255,255,255,0.04)]"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            Default columns
          </button>
          <button
            type="button"
            onClick={onShowAll}
            className="inline-flex items-center gap-1.5 rounded-lg border border-[rgba(22,101,52,0.45)] bg-[rgba(22,101,52,0.18)] px-3 py-2 text-[12px] font-semibold text-green-300 transition-all hover:bg-[rgba(22,101,52,0.28)]"
          >
            <Check className="h-3.5 w-3.5" />
            Show all
          </button>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="inline-flex items-center rounded-lg bg-gradient-to-r from-[#166534] to-[#15803D] px-4 py-2 text-[12px] font-semibold text-white transition-all hover:shadow-lg hover:shadow-[#15803D]/30"
          >
            Apply
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SelectedSessionStrip({ row, onOpenChart }: { row: Record<string, any>; onOpenChart: () => void }) {
  const quality = classifySession(row);
  return (
    <div className="shrink-0 border-b border-[rgba(255,255,255,0.08)] bg-[#0D1117] px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-[rgba(255,255,255,0.07)] bg-[#101720] px-3 py-2">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-[13px] font-black text-[#E6EDF6]">{normalizeTicker(row['ticker']) || '-'}</span>
          <span className="font-mono text-[11px] text-[#8A97AA]">{extractDate(row)}</span>
          <span className="rounded-md border px-2 py-1 text-[10px] font-black uppercase" style={{ borderColor: `${quality.color}66`, color: quality.color, backgroundColor: `${quality.color}18` }}>
            {quality.label}
          </span>
          <span className="text-[11px] text-[#8A97AA]">Day {formatPct(Number(row['day_return_pct'] ?? 0))}</span>
          <span className="text-[11px] text-[#8A97AA]">PM Fade {formatPct(Number(row['pmh_fade_to_open_pct'] ?? 0))}</span>
        </div>
        <button onClick={onOpenChart} className="inline-flex items-center gap-1.5 rounded-md border border-[rgba(220,38,38,0.28)] bg-[rgba(220,38,38,0.08)] px-2.5 py-1 text-[11px] font-bold text-[#F87171]">
          <BarChart2 className="h-3.5 w-3.5" />
          Open chart
        </button>
      </div>
    </div>
  );
}

function classifySession(row: Record<string, any>) {
  const day = Number(row['day_return_pct'] ?? 0);
  const fade = Number(row['pmh_fade_to_open_pct'] ?? 0);
  if (day > 2 || fade > 0) return { label: 'Strong', color: '#34D399' };
  if (day < -2 || fade < -15) return { label: 'Weak', color: '#F87171' };
  if (Math.abs(day) < 0.35) return { label: 'Flat', color: '#718096' };
  return { label: 'Mixed', color: '#DC2626' };
}

function formatPct(value: number) {
  if (!Number.isFinite(value)) return '-';
  return `${value > 0 ? '+' : ''}${value.toFixed(2)}%`;
}

function buildSampleCandles(): BarCandle[] {
  const start = new Date('2026-06-24T08:00:00Z').getTime();
  let lastClose = 18.35;

  return Array.from({ length: 122 }, (_, index) => {
    const trend =
      index < 26 ? 0.115 :
      index < 50 ? -0.075 :
      index < 78 ? 0.052 :
      index < 98 ? -0.032 :
      0.038;
    const rhythm = Math.sin(index / 3.4) * 0.04 + Math.cos(index / 8.7) * 0.032;
    const impulse =
      index === 18 ? 0.22 :
      index === 63 ? 0.34 :
      index === 66 ? -0.18 :
      index === 101 ? -0.28 :
      0;

    const open = lastClose;
    const close = Math.max(1, open + trend + rhythm + impulse);
    const high = Math.max(open, close) + 0.06 + Math.abs(Math.sin(index / 5.2)) * 0.12;
    const low = Math.min(open, close) - 0.05 - Math.abs(Math.cos(index / 6.1)) * 0.09;
    const spike =
      index === 18 || index === 63 || index === 64 ? 620_000 :
      index === 37 || index === 88 || index === 101 ? 360_000 :
      0;
    const volume =
      145_000 +
      Math.round((Math.sin(index / 6.5) + 1.35) * 105_000) +
      (index > 54 && index < 76 ? 250_000 : 0) +
      spike;

    lastClose = close;

    return {
      time: new Date(start + index * 60_000).toISOString().slice(0, 19).replace('T', ' '),
      open: roundPrice(open),
      high: roundPrice(high),
      low: roundPrice(low),
      close: roundPrice(close),
      volume,
    };
  });
}

function rememberSubminuteCandles(
  cache: SubminuteChartCache,
  timeframe: ChartTimeframe,
  candles: BarCandle[],
): void {
  const previous = cache.byTimeframe.get(timeframe);
  cache.totalBars += candles.length - (previous?.length ?? 0);
  cache.byTimeframe.set(timeframe, candles);

  // Keep the 1s source and the newest result alive. If an unusually large
  // session exceeds the budget, evict derived resolutions first instead of
  // allowing repeated chart changes to grow the process indefinitely.
  if (cache.totalBars <= SUBMINUTE_CACHE_MAX_BARS) return;
  for (const cachedTimeframe of cache.byTimeframe.keys()) {
    if (cache.totalBars <= SUBMINUTE_CACHE_MAX_BARS) break;
    if (cachedTimeframe === '1s' || cachedTimeframe === timeframe) continue;
    const cached = cache.byTimeframe.get(cachedTimeframe);
    cache.totalBars -= cached?.length ?? 0;
    cache.byTimeframe.delete(cachedTimeframe);
  }
}

async function precomputeSubminuteCandles(
  source: BarCandle[],
  cache: SubminuteChartCache,
  sessionDate: string,
): Promise<void> {
  rememberSubminuteCandles(cache, '1s', source);
  const timeframes = SUBMINUTE_TIMEFRAMES.filter((timeframe) => (
    timeframe !== '1s' && !cache.byTimeframe.has(timeframe)
  )) as Array<'3s' | '5s' | '10s' | '15s' | '30s'>;
  if (!timeframes.length) return;

  // Aggregating a full 1s session is CPU-heavy. Keep it completely outside
  // the browser's main thread so the chart remains interactive while every
  // cached resolution (including its volumeDelta) is being prepared.
  let calculatedByTimeframe: Partial<Record<'3s' | '5s' | '10s' | '15s' | '30s', BarCandle[]>>;
  try {
    calculatedByTimeframe = await aggregateSubminuteInWorker(source, sessionDate, timeframes);
  } catch {
    // The selected resolution is already visible; a background worker error
    // must not interrupt chart interaction or turn the load into a failure.
    return;
  }
  for (const timeframe of timeframes) {
    const calculated = calculatedByTimeframe[timeframe];
    if (calculated) rememberSubminuteCandles(cache, timeframe, calculated);
  }
}

function aggregateSubminuteInWorker(
  source: BarCandle[],
  sessionDate: string,
  timeframes: Array<'3s' | '5s' | '10s' | '15s' | '30s'>,
): Promise<Partial<Record<'3s' | '5s' | '10s' | '15s' | '30s', BarCandle[]>>> {
  const worker = new Worker(
    new URL('./subminuteAggregation.worker.ts', import.meta.url),
    { type: 'module' },
  );

  return new Promise((resolve, reject) => {
    worker.onmessage = (event: MessageEvent<{ results: Record<string, BarCandle[]> }>) => {
      worker.terminate();
      resolve(event.data.results as Partial<Record<'3s' | '5s' | '10s' | '15s' | '30s', BarCandle[]>>);
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || 'Sub-minute aggregation worker failed'));
    };
    worker.postMessage({ source, sessionDate, timeframes });
  });
}

export function aggregateCandles(candles: BarCandle[], timeframe: ChartTimeframe, sessionDate?: string, includeTradeTimeframes = false): BarCandle[] {
  if (!includeTradeTimeframes && (timeframe === '1m' || timeframe === '1D')) return candles;

  const secondsByTimeframe: Partial<Record<ChartTimeframe, number>> = {
    '1s': 1,
    '3s': 3,
    '5s': 5,
    '10s': 10,
    '15s': 15,
    '30s': 30,
  };
  if (includeTradeTimeframes) secondsByTimeframe['1m'] = 60;
  const seconds = secondsByTimeframe[timeframe];
  if (seconds) return aggregateCandlesBySeconds(candles, seconds, sessionDate);

  const minutesByTimeframe: Partial<Record<ChartTimeframe, number>> = {
    '2m': 2,
    '3m': 3,
    '5m': 5,
    '10m': 10,
    '15m': 15,
    '30m': 30,
    '1h': 60,
    '4h': 240,
  };
  const minutes = minutesByTimeframe[timeframe];
  if (!minutes) return candles;
  const buckets = new Map<number, BarCandle[]>();

  normalizeCandlesBeforeAggregation(candles, sessionDate).forEach((candle) => {
    const unix = parseCandleTime(candle.time, sessionDate);
    if (!Number.isFinite(unix)) return;
    const bucket = Math.floor(unix / (minutes * 60)) * minutes * 60;
    const entries = buckets.get(bucket) ?? [];
    entries.push(candle);
    buckets.set(bucket, entries);
  });

    return Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([bucket, entries]) => {
      const sorted = [...entries].sort((a, b) => parseCandleTime(a.time, sessionDate) - parseCandleTime(b.time, sessionDate));
      const first = sorted[0];
      const last = sorted[sorted.length - 1];
      return {
        time: formatUnixAsNyLocal(bucket),
        open: first.open,
        high: Math.max(...sorted.map((entry) => entry.high)),
        low: Math.min(...sorted.map((entry) => entry.low)),
        close: last.close,
        volume: sorted.reduce((sum, entry) => sum + Number(entry.volume || 0), 0),
        volumeDelta: sorted.reduce((sum, entry) => sum + Number(entry.volumeDelta || 0), 0),
        vwap: last.vwap,
      };
    });
}

function timeframeSeconds(timeframe: ChartTimeframe): number | null {
  const secondsByTimeframe: Partial<Record<ChartTimeframe, number>> = {
    '1m': 60,
    '2m': 120,
    '3m': 180,
    '5m': 300,
    '10m': 600,
    '15m': 900,
    '30m': 1800,
    '1h': 3600,
    '4h': 14400,
  };
  return secondsByTimeframe[timeframe] ?? null;
}

function candleDateKey(candle: BarCandle, sessionDate?: string): string | null {
  const raw = String(candle.time).trim().replace(/^"+|"+$/g, '');
  const explicitDate = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  if (explicitDate) return explicitDate[1];
  const unix = parseCandleTime(raw, sessionDate);
  if (!Number.isFinite(unix)) return null;
  return formatUnixAsNyLocal(unix).slice(0, 10);
}

export function mergeVolumeDeltaFromThirtySecondCandles(
  candles: BarCandle[],
  thirtySecondCandles: BarCandle[],
  timeframe: ChartTimeframe,
  sessionDate: string,
): BarCandle[] {
  if (timeframe === '1D') {
    const deltaByDate = new Map<string, number>();
    for (const candle of thirtySecondCandles) {
      const dateKey = candleDateKey(candle, sessionDate);
      if (!dateKey) continue;
      deltaByDate.set(dateKey, (deltaByDate.get(dateKey) ?? 0) + Number(candle.volumeDelta || 0));
    }
    return candles.map((candle) => ({
      ...candle,
      volumeDelta: deltaByDate.get(candleDateKey(candle, sessionDate) ?? '') ?? 0,
    }));
  }

  const seconds = timeframeSeconds(timeframe);
  if (!seconds) return candles;

  const deltaByBucket = new Map<number, number>();
  for (const candle of thirtySecondCandles) {
    const unix = parseCandleTime(candle.time, sessionDate);
    if (!Number.isFinite(unix)) continue;
    const bucket = Math.floor(unix / seconds) * seconds;
    deltaByBucket.set(bucket, (deltaByBucket.get(bucket) ?? 0) + Number(candle.volumeDelta || 0));
  }

  return candles.map((candle) => {
    const unix = parseCandleTime(candle.time, sessionDate);
    if (!Number.isFinite(unix)) return { ...candle, volumeDelta: 0 };
    const bucket = Math.floor(unix / seconds) * seconds;
    return { ...candle, volumeDelta: deltaByBucket.get(bucket) ?? 0 };
  });
}

function aggregateCandlesBySeconds(candles: BarCandle[], seconds: number, sessionDate?: string): BarCandle[] {
  const buckets = new Map<number, BarCandle>();

  normalizeCandlesBeforeAggregation(candles, sessionDate).forEach((candle) => {
    const unix = parseCandleTime(candle.time, sessionDate);
    if (!Number.isFinite(unix)) return;
    const bucket = Math.floor(unix / seconds) * seconds;
    const existing = buckets.get(bucket);
    if (!existing) {
      buckets.set(bucket, {
        time: formatUnixAsNyLocal(bucket),
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
        volume: Number(candle.volume || 0),
        volumeDelta: Number(candle.volumeDelta || 0),
        vwap: candle.vwap,
      });
      return;
    }
    existing.high = Math.max(existing.high, candle.high);
    existing.low = Math.min(existing.low, candle.low);
    existing.close = candle.close;
    existing.volume += Number(candle.volume || 0);
    existing.volumeDelta = Number(existing.volumeDelta || 0) + Number(candle.volumeDelta || 0);
    existing.vwap = candle.vwap;
  });

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a - b)
    .map(([, candle]) => candle);
}

function normalizeCandlesBeforeAggregation(candles: BarCandle[], sessionDate?: string): BarCandle[] {
  if (!sessionDate || candles.length <= 960 || !candles.every((candle) => /^\d{2}:\d{2}(?::\d{2})?$/.test(String(candle.time).trim().replace(/^"+|"+$/g, '')))) {
    return candles;
  }

  const currentDate = sessionDate.slice(0, 10);
  const previousDate = previousCalendarDate(currentDate);
  const byClock = new Map<string, BarCandle[]>();

  candles.forEach((candle) => {
    const clean = normalizeClockTime(candle.time);
    const entries = byClock.get(clean) ?? [];
    entries.push(candle);
    byClock.set(clean, entries);
  });

  const normalized: BarCandle[] = [];

  for (const [clean, entries] of byClock.entries()) {
    if (entries.length > 1) {
      normalized.push({ ...entries[0], time: `${previousDate} ${clean}` });
      normalized.push({ ...entries[entries.length - 1], time: `${currentDate} ${clean}` });
    } else {
      const only = entries[0];
      const inferredDate = inferSingletonLegacyDate(clean, only, byClock, previousDate, currentDate);
      if (inferredDate) normalized.push({ ...only, time: `${inferredDate} ${clean}` });
    }
  }

  return normalized.sort((a, b) => parseCandleTime(a.time) - parseCandleTime(b.time));
}

function normalizeClockTime(raw: string): string {
  const clean = String(raw).trim().replace(/^"+|"+$/g, '');
  return clean.length === 5 ? `${clean}:00` : clean.slice(0, 8);
}

function parseCandleTime(raw: string, fallbackDate?: string): number {
  const clean = raw.trim().replace(/^"+|"+$/g, '');
  if (fallbackDate && /^\d{2}:\d{2}(?::\d{2})?$/.test(clean)) {
    return parseCandleTime(`${fallbackDate.slice(0, 10)} ${normalizeClockTime(clean)}`);
  }
  const nyLocal = clean.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (nyLocal && !/[zZ]|[+-]\d{2}:?\d{2}$/.test(clean)) {
    return nyLocalToUnixSec(
      Number(nyLocal[1]),
      Number(nyLocal[2]),
      Number(nyLocal[3]),
      Number(nyLocal[4]),
      Number(nyLocal[5]),
      Number(nyLocal[6]),
    );
  }
  const date = new Date(clean.replace(' ', 'T') + (/[zZ]|[+-]\d{2}:?\d{2}$/.test(clean) ? '' : 'Z'));
  return Math.floor(date.getTime() / 1000);
}

function nyLocalToUnixSec(year: number, month: number, day: number, hour: number, minute: number, second: number): number {
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const offset = getTimeZoneOffsetMs(utcGuess, 'America/New_York');
  return Math.floor((utcGuess - offset) / 1000);
}

function getTimeZoneOffsetMs(utcMillis: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(utcMillis));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const zonedAsUtc = Date.UTC(
    Number(values.year),
    Number(values.month) - 1,
    Number(values.day),
    Number(values.hour),
    Number(values.minute),
    Number(values.second),
  );
  return zonedAsUtc - utcMillis;
}

function clockMinutesFromTime(time: string): number {
  const [hours, minutes] = time.split(':').map((part) => Number(part));
  return hours * 60 + minutes;
}

function previousCalendarDate(date: string): string {
  const parsed = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  if (isNaN(parsed.getTime())) return date.slice(0, 10);
  parsed.setUTCDate(parsed.getUTCDate() - 1);
  return parsed.toISOString().slice(0, 10);
}

function inferSingletonLegacyDate(
  cleanTime: string,
  candle: BarCandle,
  byClock: Map<string, BarCandle[]>,
  previousDate: string,
  currentDate: string,
): string | null {
  const clock = clockMinutesFromTime(cleanTime);
  const previousNeighbor = nearestDuplicateEntry(byClock, clock, 0, 45);
  const currentNeighbor = nearestDuplicateEntry(byClock, clock, -1, 45);
  const previousDistance = previousNeighbor ? Math.abs(candle.close - previousNeighbor.close) : Number.POSITIVE_INFINITY;
  const currentDistance = currentNeighbor ? Math.abs(candle.close - currentNeighbor.close) : Number.POSITIVE_INFINITY;

  if (!Number.isFinite(previousDistance) && !Number.isFinite(currentDistance)) return null;
  if (Math.abs(previousDistance - currentDistance) < 0.02) return null;
  return previousDistance <= currentDistance ? previousDate : currentDate;
}

function nearestDuplicateEntry(byClock: Map<string, BarCandle[]>, clock: number, entryIndex: 0 | -1, windowMinutes: number): BarCandle | null {
  let best: { distance: number; candle: BarCandle } | null = null;
  for (const [time, entries] of byClock.entries()) {
    if (entries.length <= 1) continue;
    const distance = Math.abs(clockMinutesFromTime(time) - clock);
    if (distance > windowMinutes) continue;
    const candle = entryIndex === 0 ? entries[0] : entries[entries.length - 1];
    if (!best || distance < best.distance) best = { distance, candle };
  }
  return best?.candle ?? null;
}

function formatUnixAsNyLocal(unix: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(new Date(unix * 1000));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day} ${values.hour}:${values.minute}:${values.second}`;
}

function roundPrice(value: number) {
  return Number(value.toFixed(2));
}

