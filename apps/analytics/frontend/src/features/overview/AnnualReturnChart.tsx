import { format, parseISO } from 'date-fns';
import { useId, useMemo, useState } from 'react';
import {
  Area,
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { DailyCumulativeReturnPoint } from '../daily/api';
import { useFilters } from '../filters/FilterContext';

type Granularity = 'year' | 'month' | 'week' | 'day';

const PERIOD_CHART_HEIGHT = 'h-[277px]';
export type ForwardBasis = 'open' | 'close';
export const FORWARD_HORIZONS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 20, 25, 30, 35, 40] as const;
export type ForwardHorizon = typeof FORWARD_HORIZONS[number];

export function formatHorizon(day: number) {
  return day === 0 ? 'D0' : `D+${day}`;
}
export type ChartMode = 'cumulative' | 'forward' | 'events';
type OverviewChartPoint = {
  bucket: string;
  count: number;
  cumulativeReturn?: number | null;
  drawdown?: number;
  returnPct?: number | null;
};

function dateBucket(date: string, resolution: Granularity): string {
  switch (resolution) {
    case 'year': return date.slice(0, 4);
    case 'month': return date.slice(0, 7);
    case 'week': return format(parseISO(date), "RRRR-'W'II");
    case 'day': return date;
  }
}

function formatPercent(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)}%` : '-';
}

function formatCumulativePoints(value: number | null | undefined) {
  return typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(2)} pp` : '-';
}

function returnAxisDomain([dataMin, dataMax]: [number, number]): [number, number] {
  const min = Math.min(0, dataMin);
  const max = Math.max(0, dataMax);
  if (min === max) return [0, 1];

  const padding = (max - min) * 0.06;
  return [min < 0 ? min - padding : 0, max > 0 ? max + padding : 0];
}

function countAxisMax(max: number): number {
  return Math.max(1, max + Math.floor(max * 0.06));
}

function ResolutionSelector({ label, value, onChange }: {
  label: string;
  value: Granularity;
  onChange: (resolution: Granularity) => void;
}) {
  return (
    <label className="flex items-center gap-2 whitespace-nowrap text-[10px] uppercase tracking-[.12em] text-[#718096]">
      Resolution
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value as Granularity)}
        className="rounded border border-white/[.08] bg-[#151B24] px-2 py-1 text-[10px] normal-case tracking-normal text-[#C8D5E7] outline-none"
      >
        <option value="year">Year</option>
        <option value="month">Month</option>
        <option value="week">Week</option>
        <option value="day">Day</option>
      </select>
    </label>
  );
}

function PeriodReturnsCard({ dailyReturns, emptyMessage }: {
  dailyReturns?: DailyCumulativeReturnPoint[];
  emptyMessage?: string;
}) {
  const [granularity, setGranularity] = useState<Granularity>('day');
  const points = useMemo(() => {
    const totals = new Map<string, number>();
    for (const point of dailyReturns ?? []) {
      const bucket = dateBucket(point.date, granularity);
      totals.set(bucket, (totals.get(bucket) ?? 0) + point.dailyReturnSumPct);
    }
    return Array.from(totals, ([bucket, periodReturn]) => ({ bucket, periodReturn }));
  }, [dailyReturns, granularity]);
  return (
    <article className={`qm-overview-card flex min-w-0 flex-col overflow-hidden ${PERIOD_CHART_HEIGHT}`}>
      <header className="qm-overview-header">
        <h3 className="qm-overview-header-title">Returns by Period</h3>
        <ResolutionSelector label="Period returns resolution" value={granularity} onChange={setGranularity} />
      </header>
      <div className="relative min-h-0 flex-1 px-3 py-2">
        {emptyMessage ? (
          <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-[11px] text-[#718096]">{emptyMessage}</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={points} margin={{ top: 12, right: 16, left: 8, bottom: 4 }}>
              <CartesianGrid stroke="rgba(148,163,184,.08)" strokeDasharray="3 3" />
              <XAxis dataKey="bucket" tick={{ fill: '#718096', fontSize: 10 }} tickLine={false} axisLine={{ stroke: 'rgba(148,163,184,.12)' }} interval="preserveStartEnd" />
              <YAxis domain={returnAxisDomain} tickFormatter={(value: number) => `${value.toFixed(0)} pp`} tick={{ fill: '#718096', fontSize: 10 }} tickLine={false} axisLine={false} width={56} />
              <ReferenceLine y={0} stroke="rgba(148,163,184,.28)" strokeDasharray="4 4" />
              <Tooltip contentStyle={{ background: '#111820', border: '1px solid rgba(148,163,184,.16)', borderRadius: 8, fontSize: 11 }} labelStyle={{ color: '#C8D5E7' }} itemStyle={{ color: '#E2E8F0' }} formatter={(value: number) => [formatCumulativePoints(value), 'Period return']} />
              <Bar dataKey="periodReturn" maxBarSize={36} isAnimationActive={false}>
                {points.map(({ bucket, periodReturn }) => (
                  <Cell key={bucket} fill={periodReturn < 0 ? '#FB7185' : '#34D399'} />
                ))}
              </Bar>
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>
    </article>
  );
}

export type ReturnChartControls = {
  forwardBasis: ForwardBasis;
  forwardHorizon: ForwardHorizon;
};

export default function AnnualReturnChart({
  chartMode,
  forwardBasis,
  forwardHorizon,
}: ReturnChartControls & { chartMode: ChartMode }) {
  const { dailySearch, selectedStatistic } = useFilters();
  const [granularity, setGranularity] = useState<Granularity>('day');
  const forwardReturns = forwardBasis === 'close'
    ? dailySearch.forwardFromCloseReturns
    : dailySearch.forwardRthReturns;
  const cumulativeReturns = forwardReturns?.find((point) => point.marketSessionsAfter === forwardHorizon)?.cumulativeReturns;
  const isCumulative = chartMode === 'cumulative';
  const syncId = useId();
  const cumulativePoints = useMemo(() => {
    if (!isCumulative) return [];

    const periods = new Map<string, OverviewChartPoint>();
    let peak = 0;
    for (const point of cumulativeReturns ?? []) {
      const bucket = dateBucket(point.date, granularity);
      const period = periods.get(bucket);
      peak = Math.max(peak, point.cumulativeReturnPct);
      periods.set(bucket, {
        bucket,
        count: (period?.count ?? 0) + point.observations,
        cumulativeReturn: point.cumulativeReturnPct,
        drawdown: Math.min(period?.drawdown ?? 0, point.cumulativeReturnPct - peak),
      });
    }
    return Array.from(periods.values());
  }, [cumulativeReturns, granularity, isCumulative]);
  const forwardPoints = useMemo(
    () => (forwardReturns ?? []).map((point) => ({
      bucket: formatHorizon(point.marketSessionsAfter),
      count: point.observations,
      returnPct: selectedStatistic === 'average'
        ? point.averageReturnPct
        : selectedStatistic === '25th'
          ? point.p25ReturnPct
          : selectedStatistic === 'median'
            ? point.medianReturnPct
            : point.p75ReturnPct,
    })),
    [forwardReturns, selectedStatistic],
  );
  const isForward = chartMode === 'forward';
  const isEvents = chartMode === 'events';
  const eventPoints = useMemo(() => {
    const totals = new Map<string, number>();
    for (const { date, count } of dailySearch.eventsPerDay ?? []) {
      const bucket = dateBucket(date, granularity);
      totals.set(bucket, (totals.get(bucket) ?? 0) + count);
    }
    return Array.from(totals, ([bucket, count]) => ({ bucket, count }));
  }, [dailySearch.eventsPerDay, granularity]);
  const chartPoints: OverviewChartPoint[] = isCumulative
    ? cumulativePoints
    : isForward
      ? [{ bucket: 'Start', count: 0, returnPct: 0 }, ...forwardPoints]
      : eventPoints;
  const hasForwardData = forwardPoints.some((point) => point.returnPct !== null);
  const observations = useMemo(
    () => isForward ? (forwardPoints[0]?.count ?? 0) : chartPoints.reduce((total, point) => total + point.count, 0),
    [chartPoints, forwardPoints, isForward],
  );
  const hasChartSearch = dailySearch.resultCount !== null || dailySearch.isLoading || dailySearch.error !== null;
  const { error: chartError, isLoading: isLoadingChart } = dailySearch;
  const chartValueKey = isCumulative ? 'cumulativeReturn' : 'returnPct';
  const forwardStatisticLabel = selectedStatistic === 'average'
    ? 'Average'
    : selectedStatistic === 'median'
      ? 'Median'
      : selectedStatistic === '25th'
        ? '25th percentile'
        : '75th percentile';

  return (
    <>
      <article className={`qm-overview-card flex min-w-0 flex-col overflow-hidden ${isCumulative ? 'xl:[contain:size]' : isEvents ? PERIOD_CHART_HEIGHT : 'h-[292px]'}`}>
        <header className="qm-overview-header">
          <div className="qm-overview-header-copy">
            <h3 className="qm-overview-header-title">{isEvents ? (granularity === 'day' ? 'Events per Day' : `Events per ${granularity[0].toUpperCase()}${granularity.slice(1)}`) : isCumulative ? 'Cumulative Return' : 'Next 40 Sessions'} <span className="qm-overview-header-code ml-1">{isEvents ? 'COUNT' : isCumulative ? 'SUM' : 'D0–D+40'}</span></h3>
          </div>
          <div className="flex shrink-0 items-center gap-2 sm:gap-3">
            {!isForward && (
              <ResolutionSelector
                label={isEvents ? 'Events resolution' : 'Cumulative return resolution'}
                value={granularity}
                onChange={setGranularity}
              />
            )}
            <span className="qm-overview-header-code">{observations.toLocaleString()} {isEvents ? 'EVENTS' : 'OBS'}</span>
          </div>
        </header>

        <div className={`relative flex-1 ${isCumulative ? 'min-h-[242px] xl:min-h-0' : 'min-h-0'}`}>
          {!hasChartSearch && <div className="absolute inset-0 flex items-center justify-center text-[11px] text-[#536176]">{isEvents ? 'Run the daily filter to count events' : isForward ? 'Run the daily filter to calculate forward returns' : 'Run the daily filter to calculate cumulative returns'}</div>}
          {hasChartSearch && isLoadingChart && <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-[#10161F]/75 text-[11px] text-[#8F9BB0]"><span className="h-4 w-4 animate-spin rounded-full border-2 border-green-700/40 border-t-green-300" />Calculating {isEvents ? 'daily event counts...' : isCumulative ? 'cumulative return...' : 'forward RTH returns...'}</div>}
          {hasChartSearch && !isLoadingChart && chartError && <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-[11px] text-red-300">{chartError}</div>}
          {hasChartSearch && !isLoadingChart && !chartError && (chartPoints.length === 0 || (isForward && !hasForwardData)) && <div className="absolute inset-0 flex items-center justify-center text-[11px] text-[#536176]">No observations for this selection</div>}
          {hasChartSearch && !chartError && !isLoadingChart && chartPoints.length > 0 && (!isForward || hasForwardData) && (
            <div className="absolute inset-x-3 inset-y-2">
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart syncId={isCumulative ? syncId : undefined} data={chartPoints} margin={{ top: 12, right: 16, left: 8, bottom: 4 }}>
                  <CartesianGrid stroke="rgba(148,163,184,.08)" strokeDasharray="3 3" />
                  <XAxis
                    dataKey="bucket"
                    tick={{ fill: '#718096', fontSize: 10 }} tickLine={false} axisLine={{ stroke: 'rgba(148,163,184,.12)' }} interval="preserveStartEnd" />
                  <YAxis domain={isEvents ? [0, countAxisMax] : returnAxisDomain} allowDecimals={!isEvents} tickFormatter={(value: number) => isEvents ? value.toLocaleString() : isCumulative ? `${value.toFixed(0)} pp` : `${value.toFixed(2)}%`} tick={{ fill: '#718096', fontSize: 10 }} tickLine={false} axisLine={false} width={56} />
                  <ReferenceLine y={0} stroke="rgba(148,163,184,.28)" strokeDasharray="4 4" />
                  <Tooltip contentStyle={{ background: '#111820', border: '1px solid rgba(148,163,184,.16)', borderRadius: 8, fontSize: 11 }} labelStyle={{ color: '#C8D5E7' }} formatter={(value: number | string) => [isEvents ? Number(value).toLocaleString() : isCumulative ? formatCumulativePoints(Number(value)) : formatPercent(Number(value)), isEvents ? 'Events' : isCumulative ? 'Cumulative sum' : `${forwardStatisticLabel} return`]} labelFormatter={(bucket) => {
                    if (isEvents) return String(bucket);
                    if (isForward) {
                      const point = forwardPoints.find((point) => point.bucket === bucket);
                      return point ? `${point.bucket} · ${point.count.toLocaleString()} observations` : String(bucket);
                    }
                    return `${String(bucket)} - Cumulative return`;
                  }} />
                  {isEvents ? (
                    <Bar dataKey="count" fill="#22D3EE" maxBarSize={36} isAnimationActive={false} />
                  ) : (
                    <Line type="monotone" dataKey={chartValueKey} stroke={isCumulative ? '#22D3EE' : isForward ? '#34D399' : '#FACC15'} strokeWidth={2.5} dot={isCumulative ? false : { r: 3, fill: isForward ? '#34D399' : '#FACC15', strokeWidth: 0 }} activeDot={{ r: 5 }} connectNulls />
                  )}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
        {isCumulative && (
          <section className="border-t border-white/[.08] px-3 pb-2 pt-1.5" aria-label="Drawdown">
            <h4 className="px-1 text-[11px] font-semibold uppercase tracking-wide text-[#C8D5E7]">Drawdown</h4>
            {hasChartSearch && !chartError && !isLoadingChart && chartPoints.length > 0 && (
              <ResponsiveContainer width="100%" height={132}>
                <ComposedChart syncId={syncId} data={chartPoints} margin={{ top: 12, right: 16, left: 8, bottom: 4 }}>
                  <CartesianGrid stroke="rgba(148,163,184,.08)" strokeDasharray="3 3" />
                  <XAxis dataKey="bucket" tick={{ fill: '#718096', fontSize: 10 }} tickLine={false} axisLine={{ stroke: 'rgba(148,163,184,.12)' }} interval="preserveStartEnd" />
                  <YAxis domain={[(min: number) => Math.min(-1, min), 0]} tickFormatter={(value: number) => `${value.toFixed(0)} pp`} tick={{ fill: '#718096', fontSize: 10 }} tickLine={false} axisLine={false} width={56} />
                  <ReferenceLine y={0} stroke="rgba(148,163,184,.28)" strokeDasharray="4 4" />
                  <Tooltip contentStyle={{ background: '#111820', border: '1px solid rgba(148,163,184,.16)', borderRadius: 8, fontSize: 11 }} labelStyle={{ color: '#C8D5E7' }} formatter={(value: number) => [formatCumulativePoints(value), 'Drawdown']} />
                  <Area type="linear" dataKey="drawdown" baseValue={0} stroke="#FB7185" fill="#FB7185" fillOpacity={0.18} strokeWidth={2} isAnimationActive={false} />
                </ComposedChart>
              </ResponsiveContainer>
            )}
          </section>
        )}
      </article>
      {isCumulative && (
        <PeriodReturnsCard
          dailyReturns={cumulativeReturns}
          emptyMessage={chartError || (isLoadingChart
            ? 'Calculating period returns…'
            : !hasChartSearch
              ? 'Run the daily filter to calculate period returns'
              : !cumulativeReturns?.length ? 'No observations for this selection' : undefined)}
        />
      )}
    </>
  );
}
