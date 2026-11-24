import { useState } from 'react';
import { useFilters } from '../filters/FilterContext';
import type { DistributionBucket, DistributionsResult } from '../filters/sessionFilterTypes';

export type DistType =
  | 'highSpike' | 'lowSpike' | 'hodTime' | 'lodTime' | 'fullHodTime' | 'fullLodTime' | 'returns'
  | 'sessionHighSpike' | 'sessionLowSpike' | 'sessionReturns'
  | 'ahPrevHighSpike' | 'ahPrevLowSpike' | 'ahPrevReturn' | 'ahPrevHodTime' | 'ahPrevLodTime'
  | 'overnightVol' | 'overnightDollarVol' | 'overnightReturn' | 'overnightHodTime' | 'overnightLodTime'
  | 'pmHighSpike' | 'pmLowSpike' | 'pmReturn' | 'pmHodTime' | 'pmLodTime'
  | 'ahHighSpike' | 'ahLowSpike' | 'ahReturn' | 'ahHodTime' | 'ahLodTime';

const MODULE_CODE: Record<DistType, string> = {
  highSpike: 'HSD', lowSpike: 'LSD', hodTime: 'HOD', lodTime: 'LOD', fullHodTime: 'FHD', fullLodTime: 'FLD', returns: 'RET',
  sessionHighSpike: 'GHS', sessionLowSpike: 'GLS', sessionReturns: 'GRT',
  ahPrevHighSpike: 'APH', ahPrevLowSpike: 'APL', ahPrevReturn: 'APR', ahPrevHodTime: 'AHT', ahPrevLodTime: 'ALT',
  overnightVol: 'ONV', overnightDollarVol: 'OND', overnightReturn: 'ONR', overnightHodTime: 'OHT', overnightLodTime: 'OLT',
  pmHighSpike: 'PMH', pmLowSpike: 'PML', pmReturn: 'PMR', pmHodTime: 'PHT', pmLodTime: 'PLT',
  ahHighSpike: 'AHH', ahLowSpike: 'AHL', ahReturn: 'AHR', ahHodTime: 'HTA', ahLodTime: 'LTA',
};

const TIME_ORDERS: Record<string, string[]> = {
  rth: Array.from({ length: 26 }, (_, index) => {
    const total = 9 * 60 + 30 + index * 15;
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }),
  full: Array.from({ length: 64 }, (_, index) => {
    const total = 4 * 60 + 15 + index * 15;
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }),
  ah: Array.from({ length: 16 }, (_, index) => {
    const total = 16 * 60 + 15 + index * 15;
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }),
  ahPrev: Array.from({ length: 16 }, (_, index) => {
    const total = 16 * 60 + 15 + index * 15;
    return `Prev ${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }),
  pm: Array.from({ length: 21 }, (_, index) => {
    const total = 4 * 60 + 15 + index * 15;
    return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }),
  overnight: [
    ...Array.from({ length: 16 }, (_, index) => {
      const total = 16 * 60 + 15 + index * 15;
      return `Prev ${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    }),
    ...Array.from({ length: 21 }, (_, index) => {
      const total = 4 * 60 + 15 + index * 15;
      return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
    }),
  ],
};

const DISTRIBUTION_CONFIG: Record<DistType, {
  code: keyof DistributionsResult;
  avg: keyof DistributionsResult;
  timeOrder?: keyof typeof TIME_ORDERS;
  numericKind?: 'pct' | 'money' | 'volume';
}> = {
  highSpike: { code: 'high_spike', avg: 'high_spike_avg' },
  lowSpike: { code: 'low_spike', avg: 'low_spike_avg' },
  hodTime: { code: 'hod_time', avg: 'hod_time_avg', timeOrder: 'rth' },
  lodTime: { code: 'lod_time', avg: 'lod_time_avg', timeOrder: 'rth' },
  fullHodTime: { code: 'full_hod_time', avg: 'full_hod_time_avg', timeOrder: 'full' },
  fullLodTime: { code: 'full_lod_time', avg: 'full_lod_time_avg', timeOrder: 'full' },
  returns: { code: 'day_return', avg: 'day_return_avg' },
  sessionHighSpike: { code: 'session_high_spike', avg: 'session_high_spike_avg' },
  sessionLowSpike: { code: 'session_low_spike', avg: 'session_low_spike_avg' },
  sessionReturns: { code: 'session_return', avg: 'session_return_avg' },
  ahPrevHighSpike: { code: 'ah_prev_high_spike', avg: 'ah_prev_high_spike_avg' },
  ahPrevLowSpike: { code: 'ah_prev_low_spike', avg: 'ah_prev_low_spike_avg' },
  ahPrevReturn: { code: 'ah_prev_return', avg: 'ah_prev_return_avg' },
  ahPrevHodTime: { code: 'ah_prev_hod_time', avg: 'ah_prev_hod_time_avg', timeOrder: 'ahPrev' },
  ahPrevLodTime: { code: 'ah_prev_lod_time', avg: 'ah_prev_lod_time_avg', timeOrder: 'ahPrev' },
  overnightVol: { code: 'overnight_vol', avg: 'overnight_vol_avg', numericKind: 'volume' },
  overnightDollarVol: { code: 'overnight_dollar_vol', avg: 'overnight_dollar_vol_avg', numericKind: 'money' },
  overnightReturn: { code: 'overnight_return', avg: 'overnight_return_avg' },
  overnightHodTime: { code: 'overnight_hod_time', avg: 'overnight_hod_time_avg', timeOrder: 'overnight' },
  overnightLodTime: { code: 'overnight_lod_time', avg: 'overnight_lod_time_avg', timeOrder: 'overnight' },
  pmHighSpike: { code: 'pm_high_spike', avg: 'pm_high_spike_avg' },
  pmLowSpike: { code: 'pm_low_spike', avg: 'pm_low_spike_avg' },
  pmReturn: { code: 'pm_return', avg: 'pm_return_avg' },
  pmHodTime: { code: 'pm_hod_time', avg: 'pm_hod_time_avg', timeOrder: 'pm' },
  pmLodTime: { code: 'pm_lod_time', avg: 'pm_lod_time_avg', timeOrder: 'pm' },
  ahHighSpike: { code: 'ah_high_spike', avg: 'ah_high_spike_avg' },
  ahLowSpike: { code: 'ah_low_spike', avg: 'ah_low_spike_avg' },
  ahReturn: { code: 'ah_return', avg: 'ah_return_avg' },
  ahHodTime: { code: 'ah_hod_time', avg: 'ah_hod_time_avg', timeOrder: 'ah' },
  ahLodTime: { code: 'ah_lod_time', avg: 'ah_lod_time_avg', timeOrder: 'ah' },
};

function sortBuckets(buckets: DistributionBucket[], type: DistType): DistributionBucket[] {
  const config = DISTRIBUTION_CONFIG[type];
  if (config.timeOrder) {
    return TIME_ORDERS[config.timeOrder].map((label) => buckets.find((bucket) => bucket.label === label) ?? { label, count: 0 });
  }
  return [...buckets].sort((a, b) => {
    const aValue = Number(a.label.match(/-?\d+(?:\.\d+)?/)?.[0] ?? Number.NaN);
    const bValue = Number(b.label.match(/-?\d+(?:\.\d+)?/)?.[0] ?? Number.NaN);
    if (Number.isFinite(aValue) && Number.isFinite(bValue)) return aValue - bValue;
    return a.label.localeCompare(b.label);
  });
}

function formatSummary(value: string | number | null | undefined, type: DistType) {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'string') return value;
  if (DISTRIBUTION_CONFIG[type].timeOrder) {
    const minute = Math.round(value);
    return `${String(Math.floor(minute / 60) % 24).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
  }
  const kind = DISTRIBUTION_CONFIG[type].numericKind;
  if (kind === 'volume') return value >= 1e9 ? `${(value / 1e9).toFixed(2)}B` : `${(value / 1e6).toFixed(2)}M`;
  if (kind === 'money') return value >= 1e9 ? `$${(value / 1e9).toFixed(2)}B` : `$${(value / 1e6).toFixed(2)}M`;
  return `${value.toFixed(2)}%`;
}

function SkeletonRow() {
  return <div className="flex h-[168px] items-end gap-[2px]">{Array.from({ length: 7 }).map((_, index) => <div key={index} className="flex min-w-0 flex-1 flex-col justify-end gap-2"><div className="w-full animate-pulse rounded-t-[3px] bg-[rgba(255,255,255,0.06)]" style={{ height: `${28 + (index % 4) * 24}px` }} /><div className="mx-auto h-3 w-10 rounded bg-[rgba(255,255,255,0.06)] animate-pulse" /></div>)}</div>;
}

export default function DistributionPanel({ title, type }: { title: string; type: DistType }) {
  const { distributions, isLoadingDist } = useFilters();
  const [hover, setHover] = useState<DistributionBucket | null>(null);
  const config = DISTRIBUTION_CONFIG[type];
  const raw = distributions?.[config.code] as DistributionBucket[] | undefined;
  const data = raw ? sortBuckets(raw, type) : [];
  const maxCount = Math.max(...data.map((item) => item.count), 1);
  const totalCount = data.reduce((sum, item) => sum + item.count, 0);
  const summary = distributions?.[config.avg] as string | number | null | undefined;
  const isTime = Boolean(config.timeOrder);
  const labelStep = isTime ? Math.max(1, Math.ceil(data.length / 14)) : Math.max(1, Math.ceil(data.length / 16));

  return (
    <div className="qm-overview-card min-h-[240px]">
      <div className="qm-overview-header">
        <div className="qm-overview-header-copy">
          <h3 className="qm-overview-header-title">{title}</h3>
          <p className="qm-overview-header-subtitle">Shape and concentration of the filtered sample</p>
        </div>
        <span className="qm-overview-header-code">{MODULE_CODE[type]}</span>
      </div>
      <div className="px-4 pt-3"><div className="font-mono text-[30px] font-semibold leading-none text-[#E1E7EF]">{formatSummary(summary, type)}</div></div>
      {!distributions && !isLoadingDist && <p className="flex flex-1 items-center justify-center px-4 py-3 text-center text-[10px] font-medium text-[#4A5568]">Apply filters to view distribution</p>}
      {isLoadingDist && <div className="flex flex-1 items-end px-4 pb-4"><SkeletonRow /></div>}
      {distributions && !isLoadingDist && (
        <div className="flex flex-1 flex-col px-4 pb-4 pt-3">
          {data.length === 0 ? (
            <p className="flex flex-1 items-center justify-center py-3 text-center text-[10px] text-[#4A5568]">No data</p>
          ) : (
            <>
              <div className="relative h-[220px] overflow-hidden rounded-lg border border-[rgba(255,255,255,0.04)] bg-[linear-gradient(180deg,rgba(255,255,255,0.01),rgba(255,255,255,0.00))] px-3 pb-6 pt-2">
                <div className="pointer-events-none absolute inset-x-3 top-7 bottom-8">
                  {[0, 1, 2, 3].map((line) => (
                    <div
                      key={line}
                      className="absolute inset-x-0 border-t border-dashed border-[rgba(255,255,255,0.05)]"
                      style={{ bottom: `${line * 25}%` }}
                    />
                  ))}
                </div>
                {data.map((item) => {
                  const height = item.count === 0 ? 0 : Math.max((Math.sqrt(item.count) / Math.sqrt(maxCount)) * 100, 5);
                  const slotWidth = 100 / Math.max(data.length, 1);
                  const showLabel = data.length <= 18 || data.indexOf(item) % labelStep === 0 || data.indexOf(item) === data.length - 1;
                  return (
                    <div
                      key={item.label}
                      className="group absolute top-2 bottom-4"
                      style={{ left: `${data.indexOf(item) * slotWidth}%`, width: `${slotWidth}%` }}
                      onMouseEnter={() => setHover(item)}
                      onMouseLeave={() => setHover(null)}
                    >
                      <div className="absolute inset-x-[8%] top-0 h-3 text-center font-mono text-[8px] text-[#8F9BB0]">{showLabel && item.count > 0 ? item.count : ''}</div>
                      <div className="absolute inset-x-[8%] top-6 bottom-5 flex items-end justify-center">
                        <div
                          className={`w-full rounded-t-[3px] transition-[height] duration-300 ${item.count === maxCount ? 'bg-gradient-to-t from-[#DC2626] via-[#EF4444] to-[#FCA5A5] shadow-[0_0_12px_rgba(220,38,38,0.28)]' : 'bg-gradient-to-t from-[#166534] via-[#16A34A] to-[#86EFAC] shadow-[0_0_8px_rgba(22,163,74,0.18)]'}`}
                          style={{ height: `${height}%` }}
                        />
                      </div>
                      <div className="absolute inset-x-0 bottom-0 truncate text-center font-mono text-[9px] text-[#718096]">{showLabel ? (isTime ? compactTimeLabel(item.label) : compactLabel(item.label)) : ''}</div>
                    </div>
                  );
                })}
              </div>
              {hover && <div className="pt-2 font-mono text-[10px] text-[#8F9BB0]">{hover.label} · {hover.count} sessions · {totalCount > 0 ? `${((hover.count / totalCount) * 100).toFixed(1)}%` : '0.0%'}</div>}
            </>
          )}
        </div>
      )}
    </div>
  );
}

function compactLabel(label: string) {
  if (label.startsWith('<') || label.startsWith('>')) return label;
  const value = label.match(/-?\d+(?:\.\d+)?/)?.[0];
  return value ? `${Number(value).toFixed(Number.isInteger(Number(value)) ? 0 : 1)}%` : label;
}

function compactTimeLabel(label: string) {
  return label.startsWith('Prev ') ? `P${label.slice(5)}` : label;
}
