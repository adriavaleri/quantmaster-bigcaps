import { useFilters } from '../filters/FilterContext';
import type { SessionQueryResult } from '../filters/sessionFilterTypes';
import type { StatisticType } from '../filters/FilterContext';

export type SummarySectionKey = 'returns';

interface MetricRowConfig {
  label: string;
  column: string;
  suffix?: string;
  showSign?: boolean;
  divisor?: number;
  kind?: 'stat' | 'probability' | 'time';
}

const SECTION_CONFIG: Record<SummarySectionKey, {
  title: string;
  code: string;
  tone: 'setup' | 'returns' | 'volume' | 'probability';
  rows: MetricRowConfig[];
}> = {
  returns: {
    title: 'Returns',
    code: 'RET',
    tone: 'returns',
    rows: [
      { label: 'M15 Return', column: 'm15_return_pct', suffix: '%' },
      { label: 'M30 Return', column: 'm30_return_pct', suffix: '%' },
      { label: 'M60 Return', column: 'm60_return_pct', suffix: '%' },
      { label: 'M90 Return', column: 'm90_return_pct', suffix: '%' },
      { label: 'M120 Return', column: 'm120_return_pct', suffix: '%' },
    ],
  },
};

function getStat(
  result: SessionQueryResult | null,
  statType: StatisticType,
  col: string,
): number | string | null {
  if (!result) return null;
  const map =
    statType === 'average' ? result.avg :
      statType === '25th' ? result.p25 :
        statType === 'median' ? result.median :
          result.p75;
  const v = map[col];
  return v === undefined || v === null ? null : v;
}

function formatValue(value: number | string | null, row: MetricRowConfig) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;

  const divisor = row.divisor ?? 1;
  const v = value / divisor;

  if (row.kind === 'probability') return `${v.toFixed(1)}%`;
  if (row.kind === 'time') return Number.isFinite(v) ? String(v) : null;

  const sign = row.showSign !== false && v >= 0 ? '+' : '';
  return `${sign}${v.toFixed(2)}${row.suffix ?? ''}`;
}

function MetricRow({
  row,
  value,
}: {
  row: MetricRowConfig;
  value: number | string | null;
}) {
  const display = formatValue(value, row);
  const numericValue = typeof value === 'number' ? value / (row.divisor ?? 1) : null;
  const valueTone =
    row.kind === 'time' || row.showSign === false || numericValue === null
      ? 'text-[#B8C4D9]'
      : numericValue > 0
        ? 'text-[#10B981]'
        : numericValue < 0
          ? 'text-[#EF4444]'
          : 'text-[#D9E2EE]';

  return (
    <div className="group flex min-h-[26px] items-center justify-between gap-3 border-b border-[rgba(255,255,255,0.045)] px-2 py-1 last:border-0">
      <span className="min-w-0 truncate text-[12px] font-medium text-[#A8B4C7]">{row.label}</span>
      {display === null ? (
        <span className="font-mono text-[12px] text-[#475366]">-</span>
      ) : (
        <span className={`shrink-0 font-mono text-[13px] font-semibold tabular-nums ${valueTone}`}>
          {display}
        </span>
      )}
    </div>
  );
}

function SkeletonRows({ count }: { count: number }) {
  return (
    <div className="space-y-2 px-2 py-1">
      {Array.from({ length: count }).map((_, index) => (
        <div key={index} className="h-[22px] rounded bg-[rgba(255,255,255,0.055)] animate-pulse" />
      ))}
    </div>
  );
}

export function SummarySection({ section }: { section: SummarySectionKey }) {
  const { queryResult, isLoading, queryError, selectedStatistic } = useFilters();
  const config = SECTION_CONFIG[section];
  const getRowValue = (row: MetricRowConfig) => getStat(queryResult, selectedStatistic, row.column);

  return (
    <section className="qm-overview-card">
      <div className="qm-overview-header">
        <div className="qm-overview-header-copy">
          <h3 className="qm-overview-header-title">{config.title}</h3>
          <p className="qm-overview-header-subtitle">Selected statistic summary for the current filtered universe</p>
        </div>
        <span className="qm-overview-header-code">{config.code}</span>
      </div>

      {queryError ? (
        <p className="px-3 py-2 font-mono text-[10px] text-[#EF4444]">{queryError.slice(0, 140)}</p>
      ) : null}

      <div className="flex-1 px-3 py-2">
        {isLoading ? (
          <SkeletonRows count={config.rows.length} />
        ) : (
          config.rows.map((row) => (
            <MetricRow
              key={row.column}
              row={row}
              value={getRowValue(row)}
            />
          ))
        )}
      </div>
    </section>
  );
}

export default function SummaryPanel() {
  return null;
}
