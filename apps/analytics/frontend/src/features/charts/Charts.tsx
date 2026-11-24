import { invoke } from '@tauri-apps/api/core';
import { format, parseISO, subMonths } from 'date-fns';
import { RefreshCw } from 'lucide-react';
import { memo, useEffect, useMemo, useState } from 'react';
import { useOutletContext } from 'react-router';
import {
  Line, LineChart, ReferenceLine,
  ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { errorMessage } from '../../shared/errorMessage';

interface BreadthPoint {
  date: string;
  adLine: number | null;
  adn: number | null;
  rasi: number | null;
  rasiPercentile252d: number | null;
  aboveSma40: number | null;
  ratio10d: number | null;
}

type Guide = { value: number; role: 'lower' | 'midpoint' | 'upper' | 'start' };

type Indicator = {
  key: Exclude<keyof BreadthPoint, 'date'>;
  label: string;
  unit?: '%' | '×';
  guides?: Guide[];
  limits?: [number, number];
};

const PARTICIPATION_THRESHOLD = 50;
const RATIO_THRESHOLD = 1;

const NYSE_INDICATORS: Indicator[] = [
  { key: 'adLine', label: 'Advance / Decline Line' },
  { key: 'adn', label: 'ADn', limits: [0, 100], guides: [
    { value: 20, role: 'lower' }, { value: 50, role: 'midpoint' }, { value: 80, role: 'upper' },
  ] },
  { key: 'rasi', label: 'RASI', guides: [
    { value: -500, role: 'lower' }, { value: 0, role: 'midpoint' }, { value: 500, role: 'upper' },
  ] },
  { key: 'rasiPercentile252d', label: 'RASI Percentile · 252D', unit: '%', limits: [0, 100], guides: [
    { value: 25, role: 'lower' }, { value: 50, role: 'midpoint' }, { value: 75, role: 'upper' },
  ] },
];

const COMBINED_INDICATORS: Indicator[] = [
  { key: 'aboveSma40', label: 'Stocks Above SMA40', unit: '%', guides: [{ value: PARTICIPATION_THRESHOLD, role: 'midpoint' }], limits: [0, 100] },
  { key: 'ratio10d', label: 'Ratio10D', unit: '×', guides: [{ value: RATIO_THRESHOLD, role: 'midpoint' }] },
];

const RANGES = [
  { label: '3M', months: 3 },
  { label: '6M', months: 6 },
  { label: '1Y', months: 12 },
  { label: '3Y', months: 36 },
  { label: 'All', months: 0 },
] as const;

const valueFormat = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });
const compactFormat = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });
const dateLabel = (date: string) => format(parseISO(date), 'MMM d, yyyy');

const INDICATOR_GROUPS = [
  { title: 'NYSE', indicators: NYSE_INDICATORS },
  { title: 'NYSE + Nasdaq', indicators: COMBINED_INDICATORS },
];

const CHANGE_SESSIONS = 20;

const REGIMES = {
  broad: { label: 'Broad participation', color: '#608D79' },
  mixed: { label: 'Mixed breadth', color: '#887958' },
  narrow: { label: 'Narrow participation', color: '#915F68' },
  unavailable: { label: 'Insufficient data', color: '#242B34' },
} as const;

type Regime = keyof typeof REGIMES;

function breadthRegime(point: BreadthPoint): Regime {
  const { aboveSma40, ratio10d } = point;
  if (aboveSma40 == null || ratio10d == null) return 'unavailable';
  if (aboveSma40 > PARTICIPATION_THRESHOLD && ratio10d > RATIO_THRESHOLD) return 'broad';
  if (aboveSma40 < PARTICIPATION_THRESHOLD && ratio10d < RATIO_THRESHOLD) return 'narrow';
  return 'mixed';
}

function formatValue(value: number | null | undefined, unit = '') {
  return value == null ? '—' : valueFormat.format(value) + unit;
}

const SERIES_STROKE = '#BACDDD';
const AD_LINE_STROKE = '#7DB8E0';
const GUIDE_STYLE: Record<Guide['role'], { stroke: string; label: string }> = {
  lower: { stroke: '#AF6673', label: '#D99AA5' },
  midpoint: { stroke: '#768394', label: '#A4AFBE' },
  upper: { stroke: '#61977F', label: '#98C7AF' },
  start: { stroke: '#63768C', label: '#A4AFBE' },
};

function indicatorDomain([min, max]: [number, number], guides: Guide[], limits?: [number, number]): [number, number] {
  if (limits) return limits;

  const levels = guides.map(({ value }) => value);
  const low = Math.min(min, ...levels);
  const high = Math.max(max, ...levels);
  const padding = low === high ? Math.max(0.1, Math.abs(low) * 0.05) : (high - low) * 0.07;
  return [low - padding, high + padding];
}

function calendarTicks(points: BreadthPoint[], months: number): string[] {
  const step = months === 0 ? 12 : months > 12 ? 3 : 1;
  const firstByPeriod = new Map<string, string>();

  for (const { date } of points) {
    const month = Number(date.slice(5, 7));
    const period = `${date.slice(0, 4)}-${Math.floor((month - 1) / step)}`;
    if (!firstByPeriod.has(period)) firstByPeriod.set(period, date);
  }

  return Array.from(firstByPeriod.values());
}

function RegimeSummary({ point, inspecting }: { point: BreadthPoint; inspecting: boolean }) {
  const regime = REGIMES[breadthRegime(point)];
  return (
    <header className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2 border-b border-white/[.08] px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <strong className="flex items-center gap-2 text-sm font-semibold text-[#E2E8EF]">
          <span className="size-2 rounded-full ring-1 ring-white/15" style={{ background: regime.color }} aria-hidden="true" />{regime.label}
        </strong>
        <span className="font-mono text-[11px] text-[#A8B7C9]">{inspecting ? 'Viewing' : 'Latest close'} · {dateLabel(point.date)}</span>
      </div>
      <div
        className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-[#A8B7C9]"
        title="Broad when both indicators are above the thresholds, narrow when both are below, mixed otherwise."
      >
        <span>Above SMA40 <strong className="font-mono text-[#E7ECF3]">{formatValue(point.aboveSma40, '%')}</strong> / {PARTICIPATION_THRESHOLD}%</span>
        <span>Ratio10D <strong className="font-mono text-[#E7ECF3]">{formatValue(point.ratio10d, '×')}</strong> / {RATIO_THRESHOLD}×</span>
      </div>
    </header>
  );
}

const RegimeHistory = memo(function RegimeHistory({ points }: { points: BreadthPoint[] }) {
  const segments = useMemo(() => {
    const runs: Array<{ regime: Regime; first: string; last: string; count: number }> = [];
    for (const point of points) {
      const regime = breadthRegime(point);
      const last = runs[runs.length - 1];
      if (last?.regime === regime) {
        last.last = point.date;
        last.count += 1;
      } else {
        runs.push({ regime, first: point.date, last: point.date, count: 1 });
      }
    }
    return runs;
  }, [points]);

  return (
    <section className="border-b border-white/[.08] px-4 py-2.5" aria-label="Breadth regime history">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-medium text-[#D5DFEC]">Regime history</h3>
        <ul className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-[#A8B7C9]">
          {(Object.entries(REGIMES) as Array<[Regime, typeof REGIMES[Regime]]>)
            .filter(([key]) => key !== 'unavailable' || segments.some((segment) => segment.regime === key))
            .map(([key, regime]) => (
              <li key={key} className="flex items-center gap-1.5">
                <span className="size-1.5 rounded-full" aria-hidden="true" style={{ background: regime.color }} />{regime.label}
              </li>
            ))}
        </ul>
      </div>
      <div className="flex h-1.5 overflow-hidden rounded-sm bg-[#242B34]">
        {segments.map(({ regime, first, last, count }) => (
          <span
            key={first}
            className="hover:brightness-125"
            style={{ flex: `${count} 1 0`, background: REGIMES[regime].color }}
            title={`${REGIMES[regime].label} · ${dateLabel(first)}${first === last ? '' : ` – ${dateLabel(last)}`}`}
          />
        ))}
      </div>
    </section>
  );
});

const IndicatorPlot = memo(function IndicatorPlot({ indicator, points, showDates, dateTicks, dateFormat, onInspect }: {
  indicator: Indicator;
  points: BreadthPoint[];
  showDates: boolean;
  dateTicks: string[];
  dateFormat: string;
  onInspect: (date: string) => void;
}) {
  const { key, unit = '', limits } = indicator;
  const first = points.find((point) => point[key] != null)?.[key];
  const isAdvanceDecline = key === 'adLine';
  const seriesStroke = isAdvanceDecline ? AD_LINE_STROKE : SERIES_STROKE;
  const guides: Guide[] = isAdvanceDecline && first != null
    ? [{ value: first, role: 'start' }]
    : indicator.guides ?? [];

  function guideLabel({ value, role }: Guide) {
    return role === 'start'
      ? `Start ${compactFormat.format(value)}`
      : formatValue(value, unit);
  }

  const plotHeight = isAdvanceDecline
    ? 'h-[168px] lg:h-[clamp(178px,17vh,235px)]'
    : showDates ? 'h-[112px] lg:h-[clamp(112px,10vh,145px)]' : 'h-[88px] lg:h-[clamp(88px,8vh,121px)]';

  return (
    <div className={`min-w-0 px-3 ${plotHeight}`}>
      {first != null ? (
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            syncId="market-breadth"
            syncMethod="value"
            data={points}
            margin={{ top: 8, right: 10, left: 4, bottom: 5 }}
            onMouseMove={(state) => {
              if (state?.isTooltipActive && typeof state.activeLabel === 'string') onInspect(state.activeLabel);
            }}
          >
            {dateTicks.map((date) => (
              <ReferenceLine key={date} x={date} stroke="rgba(148,163,184,.08)" />
            ))}
            <XAxis
              dataKey="date"
              hide={!showDates}
              height={20}
              ticks={dateTicks}
              tickFormatter={(date: string) => format(parseISO(date), dateFormat)}
              tick={{ fill: '#A8B7C9', fontSize: 10 }}
              axisLine={false}
              tickLine={false}
              interval="preserveStartEnd"
              minTickGap={45}
            />
            <YAxis
              orientation="right"
              domain={(range: [number, number]) => indicatorDomain(range, guides, limits)}
              tick={false}
              axisLine={false}
              tickLine={false}
              width={88}
            />
            {guides.map((guide) => (
              <ReferenceLine
                key={guide.value}
                y={guide.value}
                stroke={GUIDE_STYLE[guide.role].stroke}
                strokeWidth={1}
                strokeOpacity={guide.role === 'start' ? 0.68 : 0.9}
                strokeDasharray={guide.role === 'midpoint' ? undefined : '5 4'}
                label={{
                  value: guideLabel(guide),
                  position: 'right',
                  offset: 9,
                  fill: GUIDE_STYLE[guide.role].label,
                  fontSize: 11,
                  fontWeight: guide.role === 'start' ? 400 : 600,
                }}
              />
            ))}
            <Tooltip cursor={{ stroke: '#9DB9D1', strokeDasharray: '3 3' }} content={() => null} isAnimationActive={false} />
            <Line dataKey={key} stroke={seriesStroke} strokeWidth={isAdvanceDecline ? 2 : 1.65} dot={false} activeDot={{ r: 3, fill: seriesStroke, stroke: '#10151C' }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <div className="grid h-full place-items-center text-xs text-[#9AAABE]">No data in this range</div>
      )}
    </div>
  );
});

function IndicatorBand({ indicator, points, current, previous, showDates, dateTicks, dateFormat, onInspect }: {
  indicator: Indicator;
  points: BreadthPoint[];
  current: BreadthPoint;
  previous?: BreadthPoint;
  showDates: boolean;
  dateTicks: string[];
  dateFormat: string;
  onInspect: (date: string) => void;
}) {
  const { key, label, unit = '' } = indicator;
  const value = current[key];
  const previousValue = previous?.[key];
  const change = value == null || previousValue == null ? null : value - previousValue;
  const changeLabel = change == null ? '—' : `${change > 0 ? '+' : ''}${formatValue(change, unit === '%' ? ' pp' : unit)}`;

  return (
    <section className="min-w-0 border-b border-white/[.07] last:border-b-0" aria-label={label}>
      <header className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 pt-2.5">
        <h3 className="text-xs font-semibold text-[#DCE4ED]">{label}</h3>
        <div className="flex items-baseline gap-3 font-mono tabular-nums">
          <strong className="text-sm font-semibold text-[#EDF2F7]">{formatValue(value, unit)}</strong>
          <span className="border-l border-white/10 pl-3 text-[10px] text-[#A4AFBE]" title="Change over 20 trading sessions">
            {changeLabel}<span className="ml-1.5 font-sans">/ 20S</span>
          </span>
        </div>
      </header>
      <IndicatorPlot indicator={indicator} points={points} showDates={showDates} dateTicks={dateTicks} dateFormat={dateFormat} onInspect={onInspect} />
    </section>
  );
}

export default function Charts() {
  const { dataRoot } = useOutletContext<{ dataRoot: string }>();
  const [months, setMonths] = useState<number>(12);
  const [inspectDate, setInspectDate] = useState<string | null>(null);
  const [history, setHistory] = useState<BreadthPoint[]>([]);
  const [request, setRequest] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void invoke<BreadthPoint[]>('market_breadth_history', { dataRoot })
      .then((points) => { if (active) setHistory(points); })
      .catch((reason: unknown) => { if (active) setError(errorMessage(reason)); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [dataRoot, request]);

  const points = useMemo(() => {
    const last = history[history.length - 1];
    if (!last || months === 0) return history;
    const start = format(subMonths(parseISO(last.date), months), 'yyyy-MM-dd');
    return history.filter(({ date }) => date >= start);
  }, [history, months]);
  const first = points[0];
  const latest = points[points.length - 1];
  const dateIndex = useMemo(() => new Map(history.map(({ date }, index) => [date, index] as const)), [history]);
  const focusIndex = inspectDate !== null && first && latest && inspectDate >= first.date && inspectDate <= latest.date
    ? dateIndex.get(inspectDate)
    : undefined;
  const currentIndex = focusIndex ?? history.length - 1;
  const current = history[currentIndex];
  const previous = history[currentIndex - CHANGE_SESSIONS];
  const dateTicks = useMemo(() => calendarTicks(points, months), [points, months]);
  const dateFormat = months === 0 ? 'yyyy' : 'MMM yy';

  return (
    <div className="qm-overview-surface min-h-full space-y-4 p-3 sm:p-4">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-3">
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-[.15em] text-[#A8B7C9]">Market Breadth</p>
          <h1 className="text-xl font-semibold text-[#E7ECF3]">Market Regime</h1>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {first && latest && !loading && !error && (
            <span className="font-mono text-[11px] text-[#A8B7C9]">{dateLabel(first.date)} – {dateLabel(latest.date)}</span>
          )}
          <div role="group" aria-label="Date range" className="flex rounded-lg border border-white/10 bg-[#0D1117] p-0.5">
            {RANGES.map((range) => (
              <button
                key={range.label}
                type="button"
                aria-pressed={range.months === months}
                onClick={() => { setInspectDate(null); setMonths(range.months); }}
                className={`rounded-md px-3 py-1.5 text-xs font-semibold ${range.months === months ? 'bg-[#26313E] text-[#E9F0F6]' : 'text-[#9AAABE] hover:text-white'}`}
              >
                {range.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            aria-label="Refresh market breadth"
            title="Refresh market breadth"
            disabled={loading}
            onClick={() => setRequest((value) => value + 1)}
            className="rounded-md border border-white/10 p-2 text-[#A8B7C9] hover:text-white disabled:opacity-40"
          >
            <RefreshCw size={14} />
          </button>
        </div>
      </header>

      {loading ? (
        <p role="status" className="text-sm text-[#A8B7C9]">Loading market breadth…</p>
      ) : error ? (
        <p role="alert" className="text-sm text-rose-300">{error}</p>
      ) : !current ? (
        <p className="text-sm text-[#A8B7C9]">No market breadth data in the selected dataset.</p>
      ) : (
        <section className="overflow-hidden rounded-xl border border-[#27313D] bg-[#10151C]" aria-label="Market breadth dashboard" onMouseLeave={() => setInspectDate(null)}>
          <RegimeSummary point={current} inspecting={focusIndex !== undefined} />
          <RegimeHistory points={points} />
          {INDICATOR_GROUPS.map(({ title, indicators }, groupIndex) => (
            <section key={title} aria-label={title}>
              <h2 className="border-b border-white/[.07] bg-[#171E27] px-4 py-1.5 text-[10px] font-semibold uppercase tracking-[.14em] text-[#A4AFBE]">{title}</h2>
              {indicators.map((indicator, index) => (
                <IndicatorBand
                  key={indicator.key}
                  indicator={indicator}
                  points={points}
                  current={current}
                  previous={previous}
                  showDates={indicator.key === 'adLine' || (groupIndex === INDICATOR_GROUPS.length - 1 && index === indicators.length - 1)}
                  dateTicks={dateTicks}
                  dateFormat={dateFormat}
                  onInspect={setInspectDate}
                />
              ))}
            </section>
          ))}
        </section>
      )}
    </div>
  );
}
