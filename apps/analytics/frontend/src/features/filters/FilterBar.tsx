import { useEffect, useRef, useState } from 'react';
import { Bookmark, Calendar, Check, ChevronDown, LoaderCircle, Search, Trash2, X } from 'lucide-react';
import { useOutletContext } from 'react-router';
import { errorMessage } from '../../shared/errorMessage';
import {
  DAILY_FILTER_CONDITIONS_KEY,
  DAILY_FILTER_DATE_FROM_KEY,
  DAILY_FILTER_DATE_TO_KEY,
  DAILY_FILTER_MAX_EVENTS_PER_DAY_KEY,
  DAILY_FILTER_TICKER_KEY,
  formatDailyFeatureValue,
  summarizeDailyStocks,
  type DailyAnalyticsFilter,
  type DailyFeatureCondition,
} from '../daily/api';
import { fieldLabel } from '../daily/dailyFilterFields';
import DailyFilterComposerDialog from '../daily/DailyFilterComposerDialog';
import { Badge } from '../../shared/components/ui/badge';
import { Button } from '../../shared/components/ui/button';
import { Input } from '../../shared/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '../../shared/components/ui/popover';
import { useFilters } from './FilterContext';

const SAVED_FILTERS_KEY = 'qmdata.daily-analytics-saved-filter-sets';
const BIGCAPS_DEFAULT_DATE_FROM = '2017-01-01';
const BIGCAPS_DEFAULT_DATE_TO = '2023-12-31';

interface SavedDailyFilterSet {
  id: string;
  name: string;
  conditions: DailyFeatureCondition[];
  dateFrom: string;
  dateTo: string;
  ticker: string;
  maxEventsPerDay?: number | null;
}

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) as T : fallback;
  } catch {
    return fallback;
  }
}

function formatConditionValue(value: number | undefined, field: string): string {
  return formatDailyFeatureValue(value, field);
}

function conditionLabel(condition: DailyFeatureCondition): string {
  const operatorLabels: Record<string, string> = { gte: '≥', gt: '>', lte: '≤', lt: '<', eq: '=', ne: '≠', between: 'between', is_null: 'is empty', is_not_null: 'is not empty' };
  if (condition.operator === 'is_null' || condition.operator === 'is_not_null') return `${fieldLabel(condition.field)} ${operatorLabels[condition.operator]}`;
  const value = condition.compareTo
    ? fieldLabel(condition.compareTo)
    : condition.operator === 'between'
      ? `${formatConditionValue(condition.value, condition.field)}–${formatConditionValue(condition.upperValue, condition.field)}`
      : formatConditionValue(condition.value, condition.field);
  return `${fieldLabel(condition.field)} ${operatorLabels[condition.operator] ?? condition.operator} ${value}`;
}

export default function FilterBar({ allowSearchWithoutChanges: _allowSearchWithoutChanges = false }: { allowSearchWithoutChanges?: boolean }) {
  const { dataRoot } = useOutletContext<{ dataRoot: string }>();
  return <FilterBarContent key={dataRoot} dataRoot={dataRoot} />;
}

function FilterBarContent({ dataRoot }: { dataRoot: string }) {
  const { dailySearch, setDailySearch } = useFilters();
  const searchRequestId = useRef(0);
  const conditionsKey = DAILY_FILTER_CONDITIONS_KEY;
  const dateFromKey = DAILY_FILTER_DATE_FROM_KEY;
  const dateToKey = DAILY_FILTER_DATE_TO_KEY;
  const tickerKey = DAILY_FILTER_TICKER_KEY;
  const maxEventsKey = DAILY_FILTER_MAX_EVENTS_PER_DAY_KEY;
  const savedSetsKey = SAVED_FILTERS_KEY;
  const [conditions, setConditions] = useState<DailyFeatureCondition[]>(() => readStored(conditionsKey, []));
  const [dateFrom, setDateFrom] = useState(() => window.localStorage.getItem(dateFromKey) ?? BIGCAPS_DEFAULT_DATE_FROM);
  const [dateTo, setDateTo] = useState(() => window.localStorage.getItem(dateToKey) ?? BIGCAPS_DEFAULT_DATE_TO);
  const [ticker, setTicker] = useState(() => window.localStorage.getItem(tickerKey) ?? '');
  const [maxEventsPerDay, setMaxEventsPerDay] = useState(() => window.localStorage.getItem(maxEventsKey) ?? '');
  const [datePopoverOpen, setDatePopoverOpen] = useState(false);
  const [savedPopoverOpen, setSavedPopoverOpen] = useState(false);
  const [savedSets, setSavedSets] = useState<SavedDailyFilterSet[]>(() => readStored(savedSetsKey, []));
  const [newSetName, setNewSetName] = useState('');
  const [editingCondition, setEditingCondition] = useState<{ condition: DailyFeatureCondition; index: number } | null>(null);

  useEffect(() => { window.localStorage.setItem(conditionsKey, JSON.stringify(conditions)); }, [conditions, conditionsKey]);
  useEffect(() => {
    window.localStorage.setItem(dateFromKey, dateFrom);
    window.localStorage.setItem(dateToKey, dateTo);
    window.localStorage.setItem(tickerKey, ticker);
    window.localStorage.setItem(maxEventsKey, maxEventsPerDay);
  }, [dateFrom, dateTo, ticker, maxEventsPerDay, dateFromKey, dateToKey, tickerKey, maxEventsKey]);
  useEffect(() => { window.localStorage.setItem(savedSetsKey, JSON.stringify(savedSets)); }, [savedSets, savedSetsKey]);

  const runAnalysis = async () => {
    const requestId = ++searchRequestId.current;
    const parsedMaxEventsPerDay = maxEventsPerDay.trim() ? Number(maxEventsPerDay) : undefined;
    if (parsedMaxEventsPerDay !== undefined && (!Number.isInteger(parsedMaxEventsPerDay) || parsedMaxEventsPerDay < 1 || parsedMaxEventsPerDay > 65_535)) {
      setDailySearch({ filter: null, resultCount: null, averageRthReturnPct: null, p25RthReturnPct: null, medianRthReturnPct: null, p75RthReturnPct: null, averageNextDayRthReturnPct: null, p25NextDayRthReturnPct: null, medianNextDayRthReturnPct: null, p75NextDayRthReturnPct: null, eventsPerDay: [], forwardRthReturns: [], forwardFromCloseReturns: [], cumulativeReturns: [], isLoading: false, error: 'Max events per day must be a whole number from 1 to 65,535.' });
      return;
    }
    const filters: DailyAnalyticsFilter = {
      ...(dateFrom ? { dateFrom } : {}),
      ...(dateTo ? { dateTo } : {}),
      ...(ticker.trim() ? { ticker: ticker.trim().toUpperCase() } : {}),
      ...(parsedMaxEventsPerDay !== undefined ? { maxEventsPerDay: parsedMaxEventsPerDay } : {}),
      conditions,
    };
    setDailySearch({ filter: filters, resultCount: null, averageRthReturnPct: null, p25RthReturnPct: null, medianRthReturnPct: null, p75RthReturnPct: null, averageNextDayRthReturnPct: null, p25NextDayRthReturnPct: null, medianNextDayRthReturnPct: null, p75NextDayRthReturnPct: null, eventsPerDay: [], forwardRthReturns: [], forwardFromCloseReturns: [], cumulativeReturns: [], isLoading: true, error: null });
    try {
      const summary = await summarizeDailyStocks(dataRoot, filters);
      if (searchRequestId.current === requestId) {
        setDailySearch({ filter: filters, resultCount: summary.totalResults, averageRthReturnPct: summary.averageRthReturnPct, p25RthReturnPct: summary.p25RthReturnPct, medianRthReturnPct: summary.medianRthReturnPct, p75RthReturnPct: summary.p75RthReturnPct, averageNextDayRthReturnPct: summary.averageNextDayRthReturnPct, p25NextDayRthReturnPct: summary.p25NextDayRthReturnPct, medianNextDayRthReturnPct: summary.medianNextDayRthReturnPct, p75NextDayRthReturnPct: summary.p75NextDayRthReturnPct, eventsPerDay: summary.eventsPerDay, forwardRthReturns: summary.forwardRthReturns, forwardFromCloseReturns: summary.forwardFromCloseReturns, cumulativeReturns: summary.cumulativeReturns, isLoading: false, error: null });
      }
    } catch (error) {
      if (searchRequestId.current === requestId) {
        setDailySearch({ filter: null, resultCount: null, averageRthReturnPct: null, p25RthReturnPct: null, medianRthReturnPct: null, p75RthReturnPct: null, averageNextDayRthReturnPct: null, p25NextDayRthReturnPct: null, medianNextDayRthReturnPct: null, p75NextDayRthReturnPct: null, eventsPerDay: [], forwardRthReturns: [], forwardFromCloseReturns: [], cumulativeReturns: [], isLoading: false, error: errorMessage(error) });
      }
    }
  };
  const saveCurrent = () => {
    const name = newSetName.trim();
    if (!name) return;
    setSavedSets((current) => [{ id: `daily-filter-${Date.now()}`, name, conditions, dateFrom, dateTo, ticker, maxEventsPerDay: maxEventsPerDay.trim() ? Number(maxEventsPerDay) : null }, ...current]);
    setNewSetName('');
  };
  const loadSavedSet = (set: SavedDailyFilterSet) => {
    setConditions(set.conditions);
    setDateFrom(set.dateFrom);
    setDateTo(set.dateTo);
    setTicker(set.ticker);
    setMaxEventsPerDay(String(set.maxEventsPerDay ?? ''));
    setEditingCondition(set.conditions.length > 0 ? { condition: set.conditions[0], index: 0 } : null);
    setSavedPopoverOpen(false);
  };
  const rangeLabel = dateFrom || dateTo ? `${dateFrom || '…'} → ${dateTo || '…'}` : 'All time';

  return (
    <div className="border-b border-[rgba(255,255,255,0.08)] bg-[#080A0F] px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-4 2xl:flex-nowrap">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-4">
          <div className="flex items-center gap-2.5">
            <Popover open={savedPopoverOpen} onOpenChange={setSavedPopoverOpen}>
              <PopoverTrigger asChild>
                <Button variant="outline" className="rounded-full border-[rgba(220,38,38,0.30)] px-3.5 py-2 text-[13px] font-medium tracking-tight text-[#DC2626] hover:border-[rgba(220,38,38,0.48)] hover:bg-[rgba(220,38,38,0.08)]">
                  <span className="inline-flex items-center gap-1.5"><Bookmark className="h-3.5 w-3.5" /> Saved Filters</span>
                  <span className="inline-flex items-center gap-1.5"><Badge className="border border-[rgba(220,38,38,0.22)] bg-[rgba(220,38,38,0.12)] px-1.5 py-0 font-mono text-[10px] text-[#DC2626]">{savedSets.length}</Badge><ChevronDown className="h-3.5 w-3.5 opacity-60" /></span>
                </Button>
              </PopoverTrigger>
              <PopoverContent align="start" sideOffset={10} className="w-[420px] border border-[rgba(255,255,255,0.08)] bg-gradient-to-br from-[#151B23] via-[#131821] to-[#0F141B] p-0 text-[#E1E7EF] shadow-2xl">
                <div className="border-b border-[rgba(255,255,255,0.08)] bg-[rgba(255,255,255,0.02)] px-4 py-3 text-[14px] font-semibold tracking-tight">Saved filters</div>
                <div className="space-y-4 p-4">
                  <div className="space-y-2"><div className="text-[11px] font-semibold uppercase tracking-wide text-[#718096]">Save current</div><div className="flex items-center gap-2"><Input value={newSetName} onChange={(event) => setNewSetName(event.target.value)} placeholder="Name this filter set" className="h-10 border-[rgba(255,255,255,0.08)] bg-[#0D1117] text-[13px] text-[#E1E7EF]" /><Button type="button" onClick={saveCurrent} disabled={!newSetName.trim()} className="h-10 shrink-0 bg-gradient-to-r from-[#166534] to-[#15803D] text-white"><Check className="mr-1.5 h-3.5 w-3.5" /> Save</Button></div></div>
                  <div className="space-y-2"><div className="text-[11px] font-semibold uppercase tracking-wide text-[#718096]">Load saved</div>
                    {savedSets.length === 0 ? <div className="rounded-xl border border-dashed border-[rgba(255,255,255,0.08)] bg-[#0D1117] px-4 py-5 text-center"><div className="text-[12px] font-medium text-[#A7B1C2]">No saved filter sets yet</div><div className="mt-1 text-[11px] text-[#586174]">Save the current filters to create a fast reusable setup.</div></div>
                      : <div className="max-h-[280px] space-y-2 overflow-y-auto pr-1">{savedSets.map((set) => <div key={set.id} className="group flex items-start gap-2 rounded-xl border border-[rgba(255,255,255,0.08)] bg-[#0D1117] p-3 transition-colors hover:border-[rgba(22,101,52,0.28)] hover:bg-[rgba(22,101,52,0.06)]"><button type="button" onClick={() => loadSavedSet(set)} className="min-w-0 flex-1 text-left"><div className="truncate text-[13px] font-semibold text-[#E1E7EF]">{set.name}</div><div className="mt-1 truncate text-[11px] text-[#8F9BB0]">{set.dateFrom || '…'} → {set.dateTo || '…'}{set.ticker ? ` · ${set.ticker}` : ''}{set.maxEventsPerDay ? ` · Max ${set.maxEventsPerDay}/day` : ''}</div><div className="mt-1 truncate text-[10px] text-[#586174]">{set.conditions.length ? set.conditions.slice(0, 2).map((condition) => conditionLabel(condition)).join(' · ') : 'No filters'}{set.conditions.length > 2 ? ` · +${set.conditions.length - 2} more` : ''}</div></button><button type="button" onClick={() => setSavedSets((current) => current.filter((item) => item.id !== set.id))} aria-label={`Delete ${set.name}`} className="rounded-lg border border-[rgba(239,68,68,0.18)] bg-[rgba(239,68,68,0.06)] p-2 text-[#FCA5A5] opacity-70 transition-all hover:bg-[rgba(239,68,68,0.12)] hover:opacity-100"><Trash2 className="h-3.5 w-3.5" /></button></div>)}</div>}
                  </div>
                </div>
              </PopoverContent>
            </Popover>
            <DailyFilterComposerDialog dataRoot={dataRoot} triggerClassName="rounded-full px-3.5 py-2 text-[13px] font-medium tracking-tight" onAdd={(condition) => setConditions((current) => [...current, condition])} />
          </div>

          {conditions.length === 0 ? <span className="text-[13px] font-medium text-[#4A5568]">No filters applied</span> : <>
            {conditions.map((condition, index) => <div key={`${condition.field}-${index}`} className="group flex items-center gap-2 rounded-full border border-[rgba(21,128,61,0.55)] bg-[rgba(22,101,52,0.22)] px-3.5 py-2 text-[13px] font-medium tracking-tight transition-all duration-200 hover:border-[rgba(34,197,94,0.75)] hover:bg-[rgba(22,101,52,0.32)]"><button type="button" onClick={() => setEditingCondition({ condition, index })} aria-label={`Edit ${conditionLabel(condition)}`} title="Edit filter" className="cursor-pointer text-left text-green-600 outline-none focus-visible:underline">{conditionLabel(condition)}</button><button type="button" onClick={() => setConditions((current) => current.filter((_, currentIndex) => currentIndex !== index))} aria-label={`Remove ${conditionLabel(condition)}`} className="text-[#A0AEC0] transition-colors hover:text-[#EF4444]"><X className="h-3.5 w-3.5" /></button></div>)}
            <button type="button" onClick={() => setConditions([])} className="rounded-full border border-[rgba(239,68,68,0.3)] px-3.5 py-2 text-[13px] font-medium tracking-tight text-[#EF4444] transition-all duration-200 hover:border-[rgba(239,68,68,0.5)] hover:bg-[rgba(239,68,68,0.08)] hover:text-[#F87171]">Clear All</button>
          </>}
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <Popover open={datePopoverOpen} onOpenChange={setDatePopoverOpen}>
            <PopoverTrigger asChild><button className={`flex items-center gap-2 rounded-lg border px-3.5 py-2 text-[13px] font-medium transition-all duration-200 ${dateFrom || dateTo ? 'border-[rgba(220,38,38,0.3)] bg-[rgba(220,38,38,0.1)] text-[#DC2626] hover:border-[rgba(220,38,38,0.5)]' : 'border-[rgba(255,255,255,0.08)] bg-[#151B23] text-[#A0AEC0] hover:border-[rgba(255,255,255,0.15)]'}`}><Calendar className="h-4 w-4" /><span className="font-mono">{rangeLabel}</span><ChevronDown className="h-3.5 w-3.5 opacity-60" /></button></PopoverTrigger>
            <PopoverContent align="end" className="w-64 rounded-xl border border-[rgba(255,255,255,0.12)] bg-[#151B23] p-3 shadow-2xl">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-[#718096]">Observation period</p>
              <div className="space-y-2"><label className="block text-[11px] text-[#718096]">From<input type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} className="mt-1 w-full rounded-lg border border-[rgba(255,255,255,0.08)] bg-[#0D1117] px-2.5 py-1.5 font-mono text-[12px] text-[#E1E7EF] [color-scheme:dark]" /></label><label className="block text-[11px] text-[#718096]">To<input type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} className="mt-1 w-full rounded-lg border border-[rgba(255,255,255,0.08)] bg-[#0D1117] px-2.5 py-1.5 font-mono text-[12px] text-[#E1E7EF] [color-scheme:dark]" /></label><button type="button" onClick={() => { setDateFrom(''); setDateTo(''); setDatePopoverOpen(false); }} className="text-[11px] font-semibold text-[#A0AEC0] hover:text-white">Clear date range</button></div>
            </PopoverContent>
          </Popover>
          <label className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide ${ticker ? 'border-[rgba(6,182,212,0.38)] bg-[rgba(6,182,212,0.08)] text-[#67D4FF]' : 'border-[rgba(255,255,255,0.08)] bg-[#151B23] text-[#8F9BB0]'}`}>Ticker<input type="text" value={ticker} onChange={(event) => setTicker(event.target.value.toUpperCase())} placeholder="Any" aria-label="Analyze one ticker" className="w-20 bg-transparent text-right font-mono text-[12px] uppercase text-[#E1E7EF] outline-none placeholder:text-[#718096]" /></label>
          <label className={`flex items-center gap-2 rounded-lg border px-3 py-1.5 text-[10px] font-bold uppercase tracking-wide ${maxEventsPerDay ? 'border-[rgba(6,182,212,0.38)] bg-[rgba(6,182,212,0.08)] text-[#67D4FF]' : 'border-[rgba(255,255,255,0.08)] bg-[#151B23] text-[#8F9BB0]'}`}>Max/day<input type="number" min={1} max={65_535} step={1} value={maxEventsPerDay} onChange={(event) => setMaxEventsPerDay(event.target.value)} placeholder="Any" aria-label="Maximum events per day, ranked by market cap" className="w-[58px] bg-transparent text-right font-mono text-[12px] text-[#E1E7EF] outline-none placeholder:text-[#718096]" /></label>
          <button type="button" onClick={() => void runAnalysis()} disabled={dailySearch.isLoading} className="flex items-center gap-2 rounded-lg border border-transparent bg-gradient-to-r from-[#166534] to-[#15803D] px-4 py-2 text-[13px] font-medium tracking-tight text-white transition-all duration-200 hover:shadow-lg hover:shadow-[#15803D]/30 disabled:cursor-wait disabled:opacity-70">{dailySearch.isLoading ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}{dailySearch.isLoading ? 'Searching…' : 'Search'}</button>
        </div>
      </div>
      {editingCondition && <DailyFilterComposerDialog
        dataRoot={dataRoot}
        onAdd={() => undefined}
        onUpdate={(updatedCondition) => {
          setConditions((current) => current.map((condition, index) => index === editingCondition.index ? updatedCondition : condition));
          setEditingCondition(null);
        }}
        initialCondition={editingCondition.condition}
        open
        onOpenChange={(nextOpen) => { if (!nextOpen) setEditingCondition(null); }}
        showTrigger={false}
      />}
    </div>
  );
}
