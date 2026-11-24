const FILTER_GROUPS = {
  'Market Cap & Liquidity': {
    market_cap_estimated: 'Estimated Market Cap',
    dollar_volume_20d: 'Median Dollar Volume (20D)',
    volume_20d: 'Median Share Volume (20D)',
    relative_volume_20d: 'Relative Volume (20D)',
  },
  'Price & Session': {
    gap_pct: 'Gap (%)',
    price_prev_close: 'Previous Close',
    open: 'Open Price',
    close: 'Close Price',
    prev_day_return_pct: 'Previous Day Return (O/C)',
    consecutive_green_bars: 'Consecutive Green Days',
    consecutive_red_bars: 'Consecutive Red Days',
  },
  'Momentum': {
    momentum_1d: 'Momentum (1D)',
    momentum_3d: 'Momentum (3D)',
    momentum_1w: 'Momentum (1W)',
    momentum_1m: 'Momentum (1M)',
    momentum_3m: 'Momentum (3M)',
    momentum_6m: 'Momentum (6M)',
  },
  'Momentum Rankings': {
    rank_1d: 'Momentum Rank (1D)',
    rank_3d: 'Momentum Rank (3D)',
    rank_1w: 'Momentum Rank (1W)',
    rank_1m: 'Momentum Rank (1M)',
    rank_3m: 'Momentum Rank (3M)',
    rank_6m: 'Momentum Rank (6M)',
  },
  'Trend & Moving Averages': {
    ema_10: 'EMA (10D)',
    ema_20: 'EMA (20D)',
    sma_50: 'SMA (50D)',
    sma_200: 'SMA (200D)',
  },
  'Volatility': {
    adr_20d: 'Average Daily Range (20D)',
    atr_14d: 'ATR (14D, $)',
    atr_14d_pct: 'ATR (14D, %)',
  },
  'Price Extremes': {
    distance_52w_high_pct: 'Distance to 52W High (%)',
    distance_52w_low_pct: 'Distance from 52W Low (%)',
    distance_ath_high_pct: 'Distance to All-Time High (%)',
    distance_atl_low_pct: 'Open vs. All-Time Low (%)',
  },
  'Market Breadth': {
    breadth_ad_line: 'Advance/Decline Line (AD Line)',
    breadth_adn: 'ADn',
    breadth_rasi: 'RASI',
    breadth_rasi_percentile_252d: 'RASI Percentile (252D)',
    breadth_above_sma40: 'Stocks Above SMA 40 (%)',
    breadth_ratio10d: 'Ratio10D',
  },
};

const OTHER_GROUP = 'Other Features';

export const BIGCAPS_GROUP_ORDER = [...Object.keys(FILTER_GROUPS), OTHER_GROUP];

const fieldDefinitions = Object.entries(FILTER_GROUPS).flatMap(([group, fields]) =>
  Object.entries(fields).map(([name, label]) => ({ name, group, label })),
);
const fieldsByName = new Map(
  fieldDefinitions.map((field, index) => [field.name, { ...field, index }]),
);

export function featureGroup(name: string): string {
  return fieldsByName.get(name)?.group ?? OTHER_GROUP;
}

export function fieldLabel(name: string): string {
  return fieldsByName.get(name)?.label
    ?? name.replaceAll('_', ' ').replace(/\b\w/g, (letter) => letter.toUpperCase());
}

export function compareFilterFields(left: { name: string }, right: { name: string }): number {
  return (fieldsByName.get(left.name)?.index ?? fieldDefinitions.length)
    - (fieldsByName.get(right.name)?.index ?? fieldDefinitions.length);
}
