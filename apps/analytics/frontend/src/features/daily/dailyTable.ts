import { queryDailyAnalytics, type DailyAnalyticsFilter, type DailyAnalyticsRow, type DailyFeatureInfo } from './api';

type ColumnType = 'date' | 'ticker' | 'price' | 'money' | 'vol' | 'pct' | 'ret' | 'count' | 'ratio' | 'dir' | 'time';
export type ColumnDef = {
  key: string;
  label: string;
  section: string;
  group: string;
  category: string;
  type: ColumnType;
  sticky?: boolean;
  defaultVisible?: boolean;
};

export function groupKey(section: string, group: string) {
  return `${section}::${group}`;
}

function humanizeFeature(name: string): string {
  const labels: Record<string, string> = {
    ticker: 'Ticker',
    market_cap_estimated: 'Estimated Market Cap',
    dollar_volume_20d: 'Median Dollar Volume (20D)',
    volume_20d: 'Median Volume (20D)',
    relative_volume_20d: 'Relative Volume (20D)',
    gap_pct: 'Gap (%)',
    distance_52w_high_pct: 'Distance from 52-Week High (%)',
    distance_52w_low_pct: 'Rise from 52-Week Low (%)',
    distance_ath_high_pct: 'Distance from All-Time High (%)',
    distance_atl_low_pct: 'Distance from All-Time Low at Open (%)',
    atr_14d: 'ATR (14D, $)',
    atr_14d_pct: 'ATR (14D, % of Close)',
    price_prev_close: 'Previous Close',
    prev_day_return_pct: 'Previous Day RTH Return (Open-to-Close, %)',
    consecutive_green_bars: 'Consecutive Green Candles',
    consecutive_red_bars: 'Consecutive Red Candles',
    rth_return_pct: 'RTH Return (%)',
    momentum_3d: 'Momentum (3D, %)',
    momentum_1w: 'Momentum (1W, %)',
    momentum_1m: 'Momentum (1M, %)',
    momentum_3m: 'Momentum (3M, %)',
    momentum_6m: 'Momentum (6M, %)',
    open: 'Open',
    high: 'High',
    low: 'Low',
    close: 'Close',
    volume: 'Volume',
    trades: 'Trades',
    momentum_1d: 'Momentum (1D, Close-to-Close, %)',
    rank_1d: 'Momentum Rank (1D)',
    rank_3d: 'Momentum Rank (3D)',
    rank_1w: 'Momentum Rank (1W)',
    rank_1m: 'Momentum Rank (1M)',
    rank_3m: 'Momentum Rank (3M)',
    rank_6m: 'Momentum Rank (6M)',
    high_52w_price: '52-Week High Price',
    ath_high_price: 'All-Time High Price',
    bars_52w_available: 'Available 52-Week Bars',
  };
  return labels[name] ?? name.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function inferDailyColumnType(name: string): ColumnType {
  if (name === 'date') return 'date';
  if (name === 'ticker') return 'ticker';
  if (name === 'close_direction') return 'dir';
  if (name.endsWith('_time_ny')) return 'time';
  if (name === 'market_cap_estimated' || name.includes('dollar_volume') || name.endsWith('_dollar_vol')) return 'money';
  if (name === 'relative_volume_20d') return 'ratio';
  if (name === 'consecutive_green_bars' || name === 'consecutive_red_bars') return 'count';
  if (name.startsWith('rank_')) return 'count';
  if (['open', 'high', 'low', 'close', 'price_prev_close', 'atr_14d'].includes(name) || name.endsWith('_price') || name.startsWith('vwap_')) return 'price';
  if (name === 'volume' || name === 'volume_20d' || name.endsWith('_vol')) return 'vol';
  if (name.startsWith('momentum_') || name.includes('return') || name.includes('fade')) return 'ret';
  return 'pct';
}

function groupDailyColumn(name: string): { section: string; group: string } {
  if (name === 'date' || name === 'ticker') return { section: 'GENERAL', group: 'Identity' };
  if (name === 'market_cap_estimated' || name.includes('volume')) return { section: 'SIZE & LIQUIDITY', group: 'Liquidity' };
  if (['open', 'high', 'low', 'close', 'price_prev_close'].includes(name) || name.endsWith('_price') || name.startsWith('vwap_') || name.includes('gap')) return { section: 'PRICE & GAP', group: 'Price & Gap' };
  if (name.startsWith('momentum_') || name.startsWith('consecutive_')) return { section: 'MOMENTUM', group: 'Momentum' };
  if (name.startsWith('rank_')) return { section: 'MOMENTUM', group: 'Ranks' };
  if (name.includes('52w') || name.includes('ath') || name.includes('atl') || name === 'adr_20d' || name.startsWith('atr_')) return { section: 'VOLATILITY', group: 'Volatility & Price Extremes' };
  if (name.includes('return') || name.includes('fade')) return { section: 'RETURNS', group: 'Returns' };
  if (name.includes('range') || name.includes('volatility') || name.includes('spike') || name.includes('adr')) return { section: 'VOLATILITY', group: 'Volatility' };
  if (name.endsWith('_time_ny')) return { section: 'OTHER', group: 'Timing' };
  return { section: 'OTHER', group: 'Other Features' };
}

export function buildTableColumns(catalog: DailyFeatureInfo[]): ColumnDef[] {
  const available = new Set(catalog.filter((feature) => feature.filterable && !feature.name.startsWith('pct_rank_') && feature.name !== 'ema_50').map((feature) => feature.name));
  for (const field of ['open', 'close', 'rth_return_pct']) available.add(field);
  const names = ['date', 'ticker', ...Array.from(available).filter((name) => name !== 'date' && name !== 'ticker')];
  const preferredOrder = ['market_cap_estimated', 'dollar_volume_20d', 'volume_20d', 'relative_volume_20d', 'gap_pct', 'momentum_1d', 'rank_1d', 'momentum_3d', 'rank_3d', 'momentum_1w', 'rank_1w', 'rth_return_pct', 'open', 'close'];
  const rank = new Map(preferredOrder.map((name, index) => [name, index]));
  names.splice(2, names.length, ...names.slice(2).sort((left, right) => {
    const leftRank = rank.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = rank.get(right) ?? Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || left.localeCompare(right);
  }));

  return names.map((name, index) => {
    const { section, group } = groupDailyColumn(name);
    return {
      key: name,
      label: humanizeFeature(name),
      section,
      group,
      category: groupKey(section, group),
      type: inferDailyColumnType(name),
      sticky: index < 2,
      defaultVisible: index < 2 || ['market_cap_estimated', 'dollar_volume_20d', 'volume_20d', 'gap_pct', 'momentum_3d', 'momentum_1w', 'rth_return_pct', 'open', 'close'].includes(name),
    };
  });
}

export function normalizeTicker(value: unknown): string {
  return String(value ?? '').trim().replace(/^"(.+)"$/, '$1').replace(/^'(.+)'$/, '$1').trim();
}

export function normalizeDailyRow(row: DailyAnalyticsRow): Record<string, string | number | null> {
  const result: Record<string, string | number | null> = {
    ...row.features,
    date: row.date,
    ticker: normalizeTicker(row.ticker),
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume,
    rth_return_pct: row.features.rth_return_pct ?? row.returnPct,
    day_return_pct: row.returnPct,
  };
  if (result.close_direction == null && result.rth_return_pct != null) {
    const value = Number(result.rth_return_pct);
    result.close_direction = Number.isFinite(value) ? (value > 0 ? '1' : value < 0 ? '-1' : '0') : null;
  }
  return result;
}

export function withExplorerSearch(filter: DailyAnalyticsFilter, search: string): DailyAnalyticsFilter {
  const trimmedSearch = search.trim();
  return trimmedSearch ? { ...filter, search: trimmedSearch } : filter;
}

function csvCell(value: string | number | null | undefined): string {
  if (value == null) return '';
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export async function downloadDailyCsv(
  dataRoot: string,
  filter: DailyAnalyticsFilter,
  sortCol: string,
  sortDesc: boolean,
  columns: ColumnDef[],
): Promise<number> {
  const pageSize = 5_000;
  const firstPage = await queryDailyAnalytics(dataRoot, filter, 1, pageSize, sortCol, sortDesc);
  const parts = ['\uFEFF' + columns.map((column) => csvCell(column.label)).join(',')];
  let rowCount = 0;

  const appendRows = (rows: DailyAnalyticsRow[]) => {
    for (const row of rows) {
      const values = normalizeDailyRow(row);
      // The backend can default its top-level values to zero while the feature is NULL.
      for (const key of ['open', 'close', 'rth_return_pct']) {
        if (row.features[key] === null) values[key] = null;
      }
      parts.push('\r\n' + columns.map((column) => csvCell(values[column.key])).join(','));
    }
    rowCount += rows.length;
  };

  appendRows(firstPage.rows);
  const pageCount = Math.ceil(firstPage.totalRows / firstPage.pageSize);
  for (let page = 2; page <= pageCount; page += 1) {
    const result = await queryDailyAnalytics(dataRoot, filter, page, firstPage.pageSize, sortCol, sortDesc);
    if (result.totalRows !== firstPage.totalRows) throw new Error('Query results changed during export. Run Search and try again.');
    appendRows(result.rows);
  }
  if (rowCount !== firstPage.totalRows) throw new Error('The backend returned an incomplete export.');

  const url = URL.createObjectURL(new Blob(parts, { type: 'text/csv;charset=utf-8' }));
  Object.assign(document.createElement('a'), { href: url, download: `ticker_days_${new Date().toISOString().slice(0, 10)}.csv` }).click();
  URL.revokeObjectURL(url);
  return rowCount;
}
