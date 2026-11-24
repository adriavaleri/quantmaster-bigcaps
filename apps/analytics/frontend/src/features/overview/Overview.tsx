import { useState } from 'react';
import FilterBar from '../filters/FilterBar';
import PerformanceProfileChart, { FORWARD_HORIZONS, formatHorizon, type ForwardBasis, type ForwardHorizon, type ReturnChartControls } from './AnnualReturnChart';
import { useFilters, type StatisticType } from '../filters/FilterContext';
import { formatMetric as fmt, metricTone as tone } from './MetricList';

const STAT_OPTIONS: Array<{ value: StatisticType; label: string }> = [
  { value: 'average', label: 'Average' },
  { value: '25th', label: '25th' },
  { value: 'median', label: 'Median' },
  { value: '75th', label: '75th' },
];

function Card({ title, children, code }: { title: string; children: React.ReactNode; code?: string }) {
  return <article className="qm-overview-card h-full overflow-hidden"><header className="qm-overview-header"><div className="qm-overview-header-copy"><h3 className="qm-overview-header-title">{title}</h3></div>{code && <span className="qm-overview-header-code">{code}</span>}</header>{children}</article>;
}

function Universe() {
  const { dailySearch } = useFilters();
  const count = dailySearch.resultCount;
  return <Card title="Filtered Universe" code="N"><div className="px-4 py-2"><div className="flex h-[34px] items-center justify-between"><span className="text-[10px] uppercase text-[#718096]">Total Results</span><strong className="font-mono text-[26px] text-[#4ADE80]">{dailySearch.isLoading ? '...' : dailySearch.error ? 'ERR' : count === null ? '—' : count.toLocaleString()}</strong></div>{dailySearch.error && <p className="mt-1 truncate font-mono text-[9px] text-[#EF4444]" title={dailySearch.error}>{dailySearch.error}</p>}</div></Card>;
}

function StatisticSelector() {
  const { selectedStatistic, setSelectedStatistic } = useFilters();
  return <div className="qm-overview-stat-switcher">{STAT_OPTIONS.map((option, index) => <button key={option.value} type="button" onClick={() => setSelectedStatistic(option.value)} data-active={selectedStatistic === option.value} className={`px-3 py-1 text-[11px] font-semibold transition-colors ${selectedStatistic === option.value ? 'text-[#F2F7FD] shadow-[inset_0_1px_0_rgba(255,255,255,.08)]' : 'text-[#8F9BB0] hover:text-[#D8E2EF]'} ${index > 0 ? 'border-l border-white/[.08]' : ''}`}>{option.label}</button>)}</div>;
}

function getStatMap(queryResult: ReturnType<typeof useFilters>['queryResult'], statistic: StatisticType) {
  if (!queryResult) return undefined;
  if (statistic === '25th') return queryResult.p25;
  if (statistic === 'median') return queryResult.median;
  if (statistic === '75th') return queryResult.p75;
  return queryResult.avg;
}

function useSelectedMetricMap() {
  const { queryResult, selectedStatistic } = useFilters();
  return getStatMap(queryResult, selectedStatistic);
}

function ReturnMetric({ label, value, winRate, loading }: {
  label: string;
  value?: number | null;
  winRate?: number | null;
  loading: boolean;
}) {
  return (
    <div className="flex min-w-0 items-start justify-between gap-3">
      <div className="min-w-0">
        <div className="text-[9px] uppercase tracking-[.12em] text-[#8F9BB0]">{label}</div>
        <div className={`mt-1 font-mono text-[28px] font-bold leading-tight tabular-nums ${tone(value)}`}>{loading ? '…' : fmt(value)}</div>
      </div>
      <div className="shrink-0 text-right" title="Share of observations with a positive return">
        <div className="text-[9px] uppercase tracking-[.12em] text-[#8F9BB0]">Win Rate</div>
        <div className="mt-1 font-mono text-[28px] font-semibold leading-tight tabular-nums text-[#D8E2EF]">
          {loading ? '…' : typeof winRate === 'number' ? `${winRate.toFixed(1)}%` : '—'}
        </div>
      </div>
    </div>
  );
}

function ReturnSnapshot({ dailyReturn, dailyWinRate, horizonReturn, horizonWinRate, horizonLabel, loading }: {
  dailyReturn?: number | null;
  dailyWinRate?: number | null;
  horizonReturn?: number | null;
  horizonWinRate?: number | null;
  horizonLabel: string;
  loading: boolean;
}) {
  const metrics = useSelectedMetricMap();
  const { selectedStatistic } = useFilters();
  const value = dailyReturn === undefined ? metrics?.rth_return_pct : dailyReturn;
  const statisticCode = selectedStatistic === 'average' ? 'AVG' : selectedStatistic === '25th' ? 'P25' : selectedStatistic === 'median' ? 'MED' : 'P75';

  return (
    <Card title="Return Snapshot" code={statisticCode}>
      <div className="@container px-4 py-2">
        <div className="grid gap-4 @min-[460px]:grid-cols-2 @min-[460px]:gap-6">
          <ReturnMetric label="RTH Return" value={value} winRate={dailyWinRate} loading={loading} />
          <div className="min-w-0 border-t border-white/15 pt-4 @min-[460px]:border-t-0 @min-[460px]:border-l @min-[460px]:pt-0 @min-[460px]:pl-6">
            <ReturnMetric label={horizonLabel} value={horizonReturn} winRate={horizonWinRate} loading={loading} />
          </div>
        </div>
      </div>
    </Card>
  );
}

function RTHOverview(controls: ReturnChartControls) {
  const { dailySearch, selectedStatistic } = useFilters();
  const hasDailySummary = dailySearch.resultCount !== null || dailySearch.isLoading || dailySearch.error !== null;
  const dailyReturn = hasDailySummary
    ? selectedStatistic === 'average'
      ? dailySearch.averageRthReturnPct
      : selectedStatistic === '25th'
        ? dailySearch.p25RthReturnPct
        : selectedStatistic === 'median'
          ? dailySearch.medianRthReturnPct
        : dailySearch.p75RthReturnPct
    : undefined;
  const dailyWinRate = dailySearch.forwardRthReturns?.find((point) => point.marketSessionsAfter === 0)?.positiveReturnPct;
  const forwardReturns = controls.forwardBasis === 'close'
    ? dailySearch.forwardFromCloseReturns
    : dailySearch.forwardRthReturns;
  const selectedReturn = forwardReturns?.find((point) => point.marketSessionsAfter === controls.forwardHorizon);
  const horizonReturn = selectedStatistic === 'average'
    ? selectedReturn?.averageReturnPct
    : selectedStatistic === '25th'
      ? selectedReturn?.p25ReturnPct
      : selectedStatistic === 'median'
        ? selectedReturn?.medianReturnPct
        : selectedReturn?.p75ReturnPct;
  const horizonLabel = `${formatHorizon(controls.forwardHorizon)} vs D0 ${controls.forwardBasis === 'close' ? 'Close' : 'Open'}`;
  return (
    <main className="p-2">
      <section className="grid gap-2 xl:grid-cols-[minmax(0,68fr)_minmax(340px,32fr)] xl:grid-rows-[auto_auto]">
        <div className="grid min-w-0 gap-2 xl:row-span-2 xl:grid-rows-subgrid">
          <PerformanceProfileChart chartMode="cumulative" {...controls} />
        </div>
        <div className="grid min-w-0 gap-2 xl:row-span-2 xl:grid-rows-subgrid">
          <div className="grid min-w-0 content-start gap-2">
            <Universe />
            <ReturnSnapshot
              dailyReturn={dailyReturn}
              dailyWinRate={dailyWinRate}
              horizonReturn={horizonReturn}
              horizonWinRate={selectedReturn?.positiveReturnPct}
              horizonLabel={horizonLabel}
              loading={dailySearch.isLoading}
            />
            <PerformanceProfileChart chartMode="forward" {...controls} />
          </div>
          <PerformanceProfileChart chartMode="events" {...controls} />
        </div>
      </section>
    </main>
  );
}

export default function Overview() {
  const [forwardBasis, setForwardBasis] = useState<ForwardBasis>('open');
  const [forwardHorizon, setForwardHorizon] = useState<ForwardHorizon>(1);
  const controls: ReturnChartControls = {
    forwardBasis,
    forwardHorizon,
  };
  return (
    <div className="qm-overview-surface">
      <FilterBar />
      <nav className="qm-overview-topbar">
        <div className="ml-auto flex flex-wrap items-center justify-end gap-3">
          <label className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-[#8A97AA]">
            Reference
            <select
              value={forwardBasis}
              onChange={(event) => setForwardBasis(event.target.value === 'close' ? 'close' : 'open')}
              className="rounded border border-white/[.08] bg-[#151B24] px-2 py-1 text-[10px] normal-case tracking-normal text-[#C8D5E7]"
            >
              <option value="open">D0 Open</option>
              <option value="close">D0 Close</option>
            </select>
          </label>
          <label className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-[#8A97AA]">
            Horizon
            <select
              value={forwardHorizon}
              onChange={(event) => {
                const horizon = FORWARD_HORIZONS.find((day) => String(day) === event.target.value);
                if (horizon !== undefined) setForwardHorizon(horizon);
              }}
              className="rounded border border-white/[.08] bg-[#151B24] px-2 py-1 text-[10px] normal-case tracking-normal text-[#C8D5E7]"
            >
              {FORWARD_HORIZONS.map((day) => <option key={day} value={day}>{formatHorizon(day)}</option>)}
            </select>
          </label>
          <StatisticSelector />
        </div>
      </nav>
      <RTHOverview {...controls} />
    </div>
  );
}
