import type { ReactNode } from 'react';

export type MetricKind = 'pct' | 'volume' | 'money' | 'price' | 'text';

export function formatMetric(value: unknown, kind: MetricKind = 'pct') {
  if (typeof value === 'string' && kind === 'text') return value;
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-';
  if (kind === 'volume') return value >= 1e9 ? `${(value / 1e9).toFixed(2)}B` : `${(value / 1e6).toFixed(2)}M`;
  if (kind === 'money') return value >= 1e9 ? `$${(value / 1e9).toFixed(2)}B` : `$${(value / 1e6).toFixed(2)}M`;
  if (kind === 'price') return `$${value.toFixed(2)}`;
  if (kind === 'text') return String(value);
  return `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
}

export function metricTone(value: unknown) {
  return typeof value !== 'number' ? 'text-[#607086]' : value > 0 ? 'text-[#10B981]' : value < 0 ? 'text-[#EF4444]' : 'text-[#E6EDF6]';
}

export function MetricList({ children, columns = 1 }: { children: ReactNode; columns?: 1 | 2 }) {
  return <div className={columns === 2 ? 'grid gap-x-5 sm:grid-cols-2' : ''}>{children}</div>;
}

export function MetricGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-[12px] border border-white/[.055] bg-transparent px-3 py-2">
      <div className="border-b border-green-700/30 pb-1.5 text-[9px] font-bold uppercase tracking-[.16em] text-green-300">
        {title}
      </div>
      <div className="pt-1">{children}</div>
    </div>
  );
}

export function MetricRow({ label, value, kind = 'pct' }: { label: string; value: unknown; kind?: MetricKind }) {
  return (
    <div className="flex min-h-[31px] items-center justify-between gap-3 border-b border-white/[.045] px-1 py-1.5 last:border-0">
      <span className="text-[11px] text-[#A8B4C7]">{label}</span>
      <span className={`shrink-0 font-mono text-[12px] font-semibold tabular-nums ${kind === 'pct' ? metricTone(value) : 'text-[#D8E2EF]'}`}>
        {formatMetric(value, kind)}
      </span>
    </div>
  );
}

export function ProbabilityRow({ label, value }: { label: string; value: unknown }) {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
  const color = probabilityColor(label);

  return (
    <div className="border-b border-white/[.045] px-1 py-2 last:border-0">
      <div className="mb-1 flex items-center justify-between gap-3">
        <span className="text-[11px] text-[#A8B4C7]">{label}</span>
        <span
          className="font-mono text-[12px] font-semibold tabular-nums"
          style={{ color: numeric === null ? '#607086' : color.text }}
        >
          {numeric === null ? '-' : `${numeric.toFixed(1)}%`}
        </span>
      </div>
      <div
        className="h-1 overflow-hidden rounded-full bg-white/[.055]"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={numeric ?? undefined}
      >
        <div
          className="h-full rounded-full transition-[width] duration-300"
          style={{
            width: `${numeric ?? 0}%`,
            background: color.gradient,
            boxShadow: `0 0 10px ${color.glow}`,
          }}
        />
      </div>
    </div>
  );
}

function probabilityColor(label: string): { text: string; gradient: string; glow: string } {
  const key = label.toLowerCase();
  if (key.includes('red')) return color('#EF4444', '#B91C1C', 'rgba(239,68,68,0.30)');
  if (key.includes('m15')) return color('#818CF8', '#4F46E5', 'rgba(129,140,248,0.30)');
  if (key.includes('m30')) return color('#A78BFA', '#7C3AED', 'rgba(167,139,250,0.30)');
  if (key.includes('m60')) return color('#C084FC', '#9333EA', 'rgba(192,132,252,0.30)');
  if (key.includes('m120')) return color('#E879F9', '#C026D3', 'rgba(232,121,249,0.30)');
  if (key.includes('range') || key.includes('position')) return color('#2DD4BF', '#0D9488', 'rgba(45,212,191,0.28)');
  if (key.includes('vwap')) return color('#4ADE80', '#15803D', 'rgba(74,222,128,0.28)');
  if (key.includes('break')) return color('#10B981', '#047857', 'rgba(16,185,129,0.28)');
  if (key.includes('high')) return color('#F87171', '#B91C1C', 'rgba(248,113,113,0.28)');
  if (key.includes('low') || key.includes('below')) return color('#86EFAC', '#166534', 'rgba(134,239,172,0.28)');
  if (key.includes('close')) return color('#A78BFA', '#7C3AED', 'rgba(167,139,250,0.28)');
  return color('#86EFAC', '#15803D', 'rgba(134,239,172,0.25)');
}

function color(light: string, dark: string, glow: string) {
  return { text: light, gradient: `linear-gradient(90deg, ${dark}, ${light})`, glow };
}
