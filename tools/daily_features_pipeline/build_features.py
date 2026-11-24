#!/usr/bin/env python3
"""Build all point-in-time daily features from daily OHLCV and split history.

Requires: numpy, pandas and pyarrow.

Features for date D generally use OHLCV no later than the previous market
session. `distance_atl_low_pct` is an at-open value: it uses D's open and the
split-adjusted running low through prior sessions. The current-session gap and
RTH return are outcome fields; they are not inputs to the pre-market momentum
rankings. Source OHLCV and split files are never changed.
"""
import argparse
import json
import os
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq

HORIZONS = (5, 21, 63, 126)
MOMENTUM_PERIODS = ('1w', '1m', '3m', '6m')
RANKING_PERIODS = ('1d', '1w', '1m', '3m', '6m')
FIELDS = ('date', 'ticker', 'open', 'high', 'low', 'close', 'volume')


def save(frame: pd.DataFrame, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_name(path.name + '.tmp')
    try:
        frame.to_parquet(temp, index=False, engine='pyarrow', compression='zstd')
        os.replace(temp, path)
    finally:
        temp.unlink(missing_ok=True)


def load_splits(path: Path, end_date: pd.Timestamp | str | None = None) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    columns = ['ticker', 'execution_date', 'split_from', 'split_to']
    read_options = {'columns': columns}
    if end_date is not None:
        # The analysis can bound split metadata at the end of its sample and
        # avoid using later corporate actions when constructing historical returns.
        read_options['filters'] = [('execution_date', '<=', pd.Timestamp(end_date).normalize())]
    df = pd.read_parquet(path, **read_options)
    cols = {'ticker', 'execution_date', 'split_from', 'split_to'}
    if not cols.issubset(df):
        raise ValueError(f'Missing split columns: {cols - set(df)}')
    df['execution_date'] = pd.to_datetime(df.execution_date, errors='raise').dt.normalize()
    for c in ('split_from', 'split_to'):
        df[c] = pd.to_numeric(df[c], errors='raise')
    factors = df[['split_from', 'split_to']].to_numpy(dtype=float)
    if (df[list(cols)].isna().any().any() or not np.isfinite(factors).all()
            or (df[['split_from', 'split_to']] <= 0).any().any()):
        raise ValueError('Split fields are missing or factors are non-positive')
    df = df.sort_values(['ticker', 'execution_date'])
    out = {}
    for ticker, g in df.groupby('ticker', sort=False):
        # Log ratios preserve numerical range across repeated reverse splits.
        dates = g.execution_date.to_numpy(dtype='datetime64[ns]')
        log_factors = np.log(g.split_to.to_numpy(float)) - np.log(g.split_from.to_numpy(float))
        if not np.isfinite(log_factors).all():
            raise ValueError(f'Invalid split factors for ticker {ticker}')
        out[ticker] = (dates, np.cumsum(log_factors))
    return out


def cumulative_split_log_factors(ticker: str, dates: np.ndarray, splits) -> np.ndarray:
    """Cumulative log share factors effective on each date for one ticker."""
    dates = np.asarray(dates, dtype='datetime64[ns]')
    shape = dates.shape
    flat_dates = dates.reshape(-1)
    split_dates, cumulative_logs = splits.get(
        ticker, (np.array([], dtype='datetime64[ns]'), np.array([], dtype=float)))
    positions = np.searchsorted(split_dates, flat_dates, side='right') - 1
    logs = np.zeros(len(flat_dates), dtype=float)
    valid = (positions >= 0) & ~np.isnat(flat_dates)
    logs[valid] = cumulative_logs[positions[valid]]
    return logs.reshape(shape)


def relative_split_adjustments(log_factors, reference_log_factor=0.0) -> np.ndarray:
    """Convert cumulative split logs to multiplicative adjustments on a common basis."""
    log_factors, reference_log_factor = np.broadcast_arrays(
        np.asarray(log_factors, dtype=float), np.asarray(reference_log_factor, dtype=float))
    with np.errstate(over='ignore', under='ignore', invalid='ignore'):
        adjustments = np.exp(log_factors - reference_log_factor)
    if not np.isfinite(adjustments).all() or (adjustments == 0).any():
        raise ValueError('Factor relatiu de split no finit')
    return adjustments


def split_log_factors_for_rows(tickers, dates: np.ndarray, splits) -> np.ndarray:
    """Vectorized ticker/date wrapper around the shared split-factor lookup."""
    ticker_values = np.asarray(tickers, dtype=object)
    date_values = np.asarray(dates, dtype='datetime64[ns]')
    if date_values.ndim == 1:
        date_values = date_values[:, None]
    if date_values.ndim != 2 or len(ticker_values) != len(date_values):
        raise ValueError('tickers i dates han de tenir el mateix nombre de files')
    logs = np.zeros(date_values.shape, dtype=float)
    row_numbers = pd.Series(np.arange(len(ticker_values)))
    for ticker, rows in row_numbers.groupby(pd.Series(ticker_values), sort=False).indices.items():
        logs[rows] = cumulative_split_log_factors(ticker, date_values[rows], splits)
    return logs


def split_adjusted_forward_return(open_price, close_price,
                                  entry_log_factor, exit_log_factor) -> np.ndarray:
    """Return from an entry open to an exit close, adjusted for intervening splits."""
    open_price, close_price, entry_log_factor, exit_log_factor = np.broadcast_arrays(
        np.asarray(open_price, dtype=float), np.asarray(close_price, dtype=float),
        np.asarray(entry_log_factor, dtype=float), np.asarray(exit_log_factor, dtype=float))
    if (not np.isfinite(open_price).all() or not np.isfinite(close_price).all()
            or not np.isfinite(entry_log_factor).all() or not np.isfinite(exit_log_factor).all()
            or (open_price <= 0).any() or (close_price <= 0).any()):
        raise ValueError('Prices and split factors must be finite, with strictly positive prices')
    split_adjustment = relative_split_adjustments(exit_log_factor, entry_log_factor)
    with np.errstate(over='ignore', under='ignore', invalid='ignore', divide='ignore'):
        result = close_price * split_adjustment / open_price - 1.0
    if not np.isfinite(split_adjustment).all() or not np.isfinite(result).all():
        raise ValueError('Ajustament de split no finit en el retorn forward')
    return result


def rolling_mean(values: np.ndarray, n: int) -> np.ndarray:
    return pd.Series(values).rolling(n, min_periods=n).mean().to_numpy()


def rolling_median(values: np.ndarray, n: int) -> np.ndarray:
    return pd.Series(values).rolling(n, min_periods=n).median().to_numpy()


def wilder_rma(values: np.ndarray, n: int) -> np.ndarray:
    """Wilder's RMA, seeded by the mean of the first n consecutive values."""
    if n < 1:
        raise ValueError('The RMA period must be positive')
    values = np.asarray(values, dtype=float)
    result = np.full(values.shape, np.nan, dtype=float)
    seed_count = 0
    seed_sum = 0.0
    previous = np.nan
    for index, value in enumerate(values):
        if not np.isfinite(value):
            seed_count = 0
            seed_sum = 0.0
            previous = np.nan
            continue
        if not np.isfinite(previous):
            seed_count += 1
            seed_sum += value
            if seed_count == n:
                previous = seed_sum / n
                result[index] = previous
            continue
        previous = ((n - 1) * previous + value) / n
        result[index] = previous
    return result


def split_adjusted_running_extremes(
    highs: np.ndarray,
    lows: np.ndarray,
    split_logs: np.ndarray,
) -> tuple[np.ndarray, np.ndarray]:
    """Return point-in-time ATH/ATL in each date's own share-price basis."""
    highs = np.asarray(highs, dtype=float)
    lows = np.asarray(lows, dtype=float)
    split_logs = np.asarray(split_logs, dtype=float)
    if highs.ndim != 1 or lows.shape != highs.shape or split_logs.shape != highs.shape:
        raise ValueError('highs, lows i split_logs han de ser vectors de la mateixa mida')
    if not len(highs):
        return np.empty(0, dtype=float), np.empty(0, dtype=float)
    if not np.isfinite(highs).all() or not np.isfinite(lows).all() or not np.isfinite(split_logs).all():
        raise ValueError('OHLC i factors de split han de ser finits')
    if (highs <= 0).any() or (lows <= 0).any() or (highs < lows).any():
        raise ValueError('Invalid OHLC extrema')

    prior_price_scales = relative_split_adjustments(split_logs[:-1], split_logs[1:])
    all_time_high = np.empty(len(highs), dtype=float)
    all_time_low = np.empty(len(lows), dtype=float)
    running_high = highs[0]
    running_low = lows[0]
    all_time_high[0] = running_high
    all_time_low[0] = running_low
    for index in range(1, len(highs)):
        price_scale = prior_price_scales[index - 1]
        running_high *= price_scale
        running_low *= price_scale
        high = highs[index]
        low = lows[index]
        running_high = max(running_high, high)
        running_low = min(running_low, low)
        all_time_high[index] = running_high
        all_time_low[index] = running_low
    return all_time_high, all_time_low


def split_adjusted_running_low_at_open(
    opens: np.ndarray,
    lows: np.ndarray,
    split_logs: np.ndarray,
) -> np.ndarray:
    """Return the ATL at each open, including that open but excluding that day's low."""
    opens = np.asarray(opens, dtype=float)
    lows = np.asarray(lows, dtype=float)
    split_logs = np.asarray(split_logs, dtype=float)
    if opens.ndim != 1 or lows.shape != opens.shape or split_logs.shape != opens.shape:
        raise ValueError('opens, lows i split_logs han de ser vectors de la mateixa mida')
    if not len(opens):
        return np.empty(0, dtype=float)
    if (not np.isfinite(opens).all() or not np.isfinite(lows).all()
            or not np.isfinite(split_logs).all()):
        raise ValueError('OHLC i split_logs han de ser finits')
    if (opens <= 0).any() or (lows <= 0).any():
        raise ValueError('Opens i lows han de ser positius')

    prior_price_scales = relative_split_adjustments(split_logs[:-1], split_logs[1:])
    atl_at_open = np.empty(len(opens), dtype=float)
    running_low = np.nan
    for index in range(len(opens)):
        if index:
            running_low *= prior_price_scales[index - 1]
            atl_at_open[index] = min(running_low, opens[index])
            running_low = min(running_low, lows[index])
        else:
            # With no earlier observations, today's open establishes the available ATL.
            atl_at_open[index] = opens[index]
            running_low = lows[index]
    return atl_at_open


def ema_sma_seed(values: np.ndarray, n: int) -> np.ndarray:
    """Calculate an EMA with alpha = 2/(n+1) and an SMA seed."""
    result = np.full(len(values), np.nan)
    if len(values) < n:
        return result
    initial = values[:n]
    if not np.isfinite(initial).all():
        return result
    result[n-1] = float(np.mean(initial))
    a = 2.0 / (n + 1)
    for i in range(n, len(values)):
        if not np.isfinite(values[i]):
            return result
        result[i] = result[i-1] + a * (values[i] - result[i-1])
    return result


def split_adjusted_ema_values(prices: np.ndarray, adjustments: np.ndarray,
                             periods=(10, 20)) -> dict[str, np.ndarray]:
    """Shared EMA calculation and re-expression in the observed price basis."""
    prices = np.asarray(prices, dtype=float)
    adjustments = np.asarray(adjustments, dtype=float)
    if len(prices) != len(adjustments) or (adjustments <= 0).any() or not np.isfinite(adjustments).all():
        raise ValueError('Invalid prices or split adjustments for EMA')
    return {f'ema_{period}': ema_sma_seed(prices, period) / adjustments
            for period in periods}


def ema_features_ticker(g: pd.DataFrame, splits, session_index: dict,
                        periods=(10, 20)) -> pd.DataFrame:
    """Calculate pre-open EMA features for one ticker using shared split/EMA logic."""
    g = g.sort_values('date', kind='stable').reset_index(drop=True)
    dates = pd.to_datetime(g.date).to_numpy(dtype='datetime64[ns]')
    idx = np.array([session_index[d] for d in dates], dtype=np.int32)
    if np.any(np.diff(idx) <= 0):
        raise ValueError(f'Duplicate or unordered dates: {g.ticker.iloc[0]}')
    ticker = g.ticker.iloc[0]
    raw_close = g.close.to_numpy(dtype=float)
    if not np.isfinite(raw_close).all() or (raw_close <= 0).any():
        raise ValueError(f'Invalid close for ticker {ticker}')
    logs = cumulative_split_log_factors(ticker, dates, splits)
    result = g[['date', 'ticker']].copy()
    for period in periods:
        result[f'ema_{period}'] = np.nan
    boundaries = np.r_[0, np.flatnonzero(np.diff(idx) != 1) + 1, len(g)]
    for start, end in zip(boundaries[:-1], boundaries[1:]):
        if end - start < 2:
            continue
        adjustment = relative_split_adjustments(logs[start:end], logs[end - 1])
        with np.errstate(over='ignore', under='ignore', invalid='ignore'):
            split_adjusted_close = raw_close[start:end] * adjustment
        if not np.isfinite(split_adjusted_close).all() or (split_adjusted_close <= 0).any():
            raise ValueError(f'Numerically extreme split ratios for {ticker}. Check its split history.')
        emas = split_adjusted_ema_values(split_adjusted_close, adjustment, periods)
        for name, values in emas.items():
            if end - start > 1:
                # These prior-session EMA values are written on the next
                # session's feature row. Re-express them in that row's price
                # basis, including a split effective on the feature date.
                next_session_scale = adjustment[:-1] / adjustment[1:]
                result.loc[start + 1:end - 1, name] = values[:-1] * next_session_scale
    return result


def features_ticker(g: pd.DataFrame, splits, session_index: dict, first_month=None) -> pd.DataFrame:
    g = g.sort_values('date', kind='stable').reset_index(drop=True)
    dates = pd.to_datetime(g.date).to_numpy(dtype='datetime64[ns]')
    idx = np.array([session_index[d] for d in dates], dtype=np.int32)
    if np.any(np.diff(idx) <= 0):
        raise ValueError(f'Duplicate or unordered dates: {g.ticker.iloc[0]}')
    ticker = g.ticker.iloc[0]
    logs = cumulative_split_log_factors(ticker, dates, splits)
    raw_o = g.open.to_numpy(float)
    raw_h = g.high.to_numpy(float)
    raw_l = g.low.to_numpy(float)
    raw_c = g.close.to_numpy(float)
    raw_v = g.volume.to_numpy(float)
    if (raw_l <= 0).any() or (raw_h < raw_l).any() or (raw_c <= 0).any() or (raw_o <= 0).any() or (raw_v < 0).any():
        raise ValueError(f'Invalid OHLCV for ticker {ticker}')
    all_time_high, _ = split_adjusted_running_extremes(raw_h, raw_l, logs)
    all_time_low_at_open = split_adjusted_running_low_at_open(raw_o, raw_l, logs)
    result = g[['date', 'ticker']].copy()
    # Start a new window after each missing market session.
    # EMA state carries across month boundaries.
    boundaries = np.r_[0, np.flatnonzero(np.diff(idx) != 1) + 1, len(g)]
    cols = [f'momentum_{period}' for period in MOMENTUM_PERIODS] + [
        'momentum_1d', 'prev_day_return_pct',
        'consecutive_green_bars', 'consecutive_red_bars',
        'dollar_volume_20d', 'volume_20d', 'adr_20d', 'ema_10', 'ema_20',
        'sma_50', 'sma_200', 'distance_52w_high_pct', 'distance_52w_low_pct',
        'distance_ath_high_pct', 'atr_14d', 'atr_14d_pct',
        'relative_volume_20d',
    ]
    for c in cols:
        result[c] = np.nan
    gap = np.full(len(g), np.nan)
    with np.errstate(divide='ignore', invalid='ignore'):
        rth_return = 100.0 * (raw_c / raw_o - 1.0)
    rth_return[~np.isfinite(rth_return)] = np.nan
    for start, end in zip(boundaries[:-1], boundaries[1:]):
        if end-start < 2 or (first_month is not None and dates[end-1] < first_month):
            continue
        # Anchor prices to the block's final session to limit numerical extremes.
        # Express moving averages on the feature date share basis.
        rel = logs[start:end] - logs[end-1]
        adjustment = relative_split_adjustments(logs[start:end], logs[end-1])
        with np.errstate(over='ignore', under='ignore', invalid='ignore'):
            p = raw_c[start:end] * adjustment
            h = raw_h[start:end] * adjustment
            l = raw_l[start:end] * adjustment
            v = raw_v[start:end] / adjustment
            op = raw_o[start:end] * adjustment
        if not np.isfinite(p).all() or not np.isfinite(h).all() or not np.isfinite(l).all() or not np.isfinite(v).all() or (p <= 0).any() or (adjustment == 0).any():
            raise ValueError(f'Numerically extreme split ratios for {ticker}. Check its split history.')
        z = end-start
        d = {}
        for period, n in zip(MOMENTUM_PERIODS, HORIZONS):
            name = f'momentum_{period}'
            x = np.full(z, np.nan)
            if z > n:
                x[n:] = 100.0 * (p[n:]/p[:-n]-1)
            d[name] = x
        daily_close_return = np.full(z, np.nan)
        if z > 1:
            daily_close_return[1:] = 100.0 * (p[1:] / p[:-1] - 1.0)
        d['momentum_1d'] = daily_close_return
        d['prev_day_return_pct'] = rth_return[start:end]
        green_streak = np.zeros(z, dtype=float)
        red_streak = np.zeros(z, dtype=float)
        for i in range(z):
            if p[i] > op[i]:
                green_streak[i] = green_streak[i - 1] + 1 if i else 1
            elif p[i] < op[i]:
                red_streak[i] = red_streak[i - 1] + 1 if i else 1
        d['consecutive_green_bars'] = green_streak
        d['consecutive_red_bars'] = red_streak
        # The dollar-volume feature is the median daily dollar turnover over 20 sessions.
        # Price times raw shares is invariant to stock splits.
        d['dollar_volume_20d'] = rolling_median(raw_c[start:end]*raw_v[start:end], 20)
        # Median daily share volume, expressed on each feature date's split basis.
        # The values are shifted below so a date only uses completed sessions.
        d['volume_20d'] = rolling_median(v, 20)
        d['adr_20d'] = 100.0 * (rolling_mean(raw_h[start:end]/raw_l[start:end], 20)-1)
        d.update(split_adjusted_ema_values(p, adjustment, periods=(10, 20)))
        d['sma_50'] = rolling_mean(p, 50)/adjustment
        d['sma_200'] = rolling_mean(p, 200)/adjustment
        high_52 = pd.Series(h).rolling(252, min_periods=252).max().to_numpy()
        low_52 = pd.Series(l).rolling(252, min_periods=252).min().to_numpy()
        d['distance_52w_high_pct'] = 100.0*(p/high_52 - 1)
        d['distance_52w_low_pct'] = 100.0*(p/low_52 - 1)
        d['distance_ath_high_pct'] = 100.0*(raw_c[start:end]/all_time_high[start:end] - 1)
        # A block starts after a missing market session, so its first true range
        # has no valid prior close and cannot seed the 14 complete TR values.
        true_range = np.full(z, np.nan)
        if z > 1:
            true_range[1:] = np.maximum.reduce((
                h[1:] - l[1:],
                np.abs(h[1:] - p[:-1]),
                np.abs(l[1:] - p[:-1]),
            ))
        d['atr_14d'] = wilder_rma(true_range, 14)
        # Compare current volume with the previous 20 sessions.
        ref_vol = np.r_[np.nan, rolling_mean(v, 20)[:-1]]
        d['relative_volume_20d'] = np.divide(v, ref_vol, out=np.full(z, np.nan), where=ref_vol>0)
        if z > 1:
            gap[start+1:end] = 100.0*(op[1:]/p[:-1]-1)
        # Write features calculated at t on the t+1 row.
        # Within a continuous block, t+1 is the next market session.
        for name, values in d.items():
            if z > 1:
                values_for_next_session = values[:-1]
                if name.startswith(('ema_', 'sma_')):
                    # The moving average is based on the close at t, but stored
                    # on row t+1. Convert it to t+1's share basis so an ex-date
                    # split does not leave the MA ten times too large/small.
                    next_session_scale = adjustment[:-1] / adjustment[1:]
                    values_for_next_session = values_for_next_session * next_session_scale
                elif name == 'volume_20d':
                    # v is anchored to the block's last split basis. Convert each
                    # trailing median to the next feature row's share basis.
                    values_for_next_session = values_for_next_session * adjustment[1:]
                elif name == 'atr_14d':
                    # True range is anchored to the block's last price basis.
                    values_for_next_session = values[:-1] / adjustment[1:]
                result.loc[start+1:end-1, name] = values_for_next_session
    # Unlike the other price-extreme features, ATL distance is measured at the
    # current session's open. The open becomes the ATL if it breaks all prior lows.
    result['distance_atl_low_pct'] = 100.0 * (
        raw_o / all_time_low_at_open - 1.0
    )
    previous_close = np.full(len(g), np.nan)
    if len(g) > 1:
        # Re-express the prior close in the current session's share basis.
        # This includes a split effective on the current date (e.g. pre-split
        # close 882.65 -> 88.265 for CSGP on 2021-06-28).
        with np.errstate(over='ignore', under='ignore', invalid='ignore'):
            prior_to_current_adjustment = np.exp(logs[:-1] - logs[1:])
        if not np.isfinite(prior_to_current_adjustment).all() or (prior_to_current_adjustment <= 0).any():
            raise ValueError(f'Invalid split factor for price_prev_close: {ticker}')
        previous_close[1:] = raw_c[:-1] * prior_to_current_adjustment
        # If sessions are missing, do not treat an older close as D-1.
        broken = np.flatnonzero(np.diff(idx) != 1) + 1
        previous_close[broken] = np.nan
    result['price_prev_close'] = previous_close
    atr_values = result['atr_14d'].to_numpy(dtype=float)
    result['atr_14d_pct'] = np.divide(
        100.0 * atr_values,
        previous_close,
        out=np.full(len(result), np.nan, dtype=float),
        where=np.isfinite(atr_values) & np.isfinite(previous_close) & (previous_close > 0),
    )
    for name in ('consecutive_green_bars', 'consecutive_red_bars'):
        result[name] = result[name].astype('Int32')
    result['open'] = raw_o
    result['close'] = raw_c
    result['gap_pct'] = gap
    result['rth_return_pct'] = rth_return
    return result


def add_momentum_rankings(data: pd.DataFrame, periods=RANKING_PERIODS,
                          eligible_mask: pd.Series | np.ndarray | None = None) -> pd.DataFrame:
    """Rank momentum across tickers for each session, strongest first."""
    stale_percentiles = [name for name in data.columns if name.startswith('pct_rank_')]
    if stale_percentiles:
        data.drop(columns=stale_percentiles, inplace=True)
    eligible = data.price_prev_close >= 1.0
    if eligible_mask is not None:
        extra = np.asarray(eligible_mask, dtype=bool)
        if len(extra) != len(data):
            raise ValueError('eligible_mask and data must have the same length')
        eligible &= pd.Series(extra, index=data.index)
    for period in periods:
        name = f'momentum_{period}'
        if name not in data:
            raise ValueError(f'Missing feature {name}')
        valid = eligible & data[name].notna()
        ranks = data.loc[valid].groupby('date')[name].rank(ascending=False, method='min')
        rank_name = f'rank_{period}'
        data[rank_name] = ranks
    return data


def preserve_existing_market_cap(data: pd.DataFrame, target: Path) -> pd.DataFrame:
    """Carry forward the separately sourced cap values when rebuilding a month.

    No market-cap source is part of the daily OHLCV/split inputs. Keeping the
    existing values by (date, ticker) avoids erasing that auxiliary field when
    the other features are regenerated.
    """
    data = data.copy()
    data["market_cap_estimated"] = np.nan
    if not target.is_file():
        return data
    existing_columns = pq.ParquetFile(target).schema_arrow.names
    if not {"date", "ticker", "market_cap_estimated"}.issubset(existing_columns):
        return data
    existing = pd.read_parquet(
        target, columns=["date", "ticker", "market_cap_estimated"]
    )
    if existing.duplicated(["date", "ticker"]).any():
        raise ValueError(f"Duplicate (date, ticker) keys in existing features {target}")

    existing["_date_key"] = pd.to_datetime(
        existing["date"], utc=True, errors="raise"
    ).dt.tz_localize(None).dt.normalize()
    values = existing.set_index(["_date_key", "ticker"])["market_cap_estimated"]
    date_keys = pd.to_datetime(data["date"], utc=True, errors="raise").dt.tz_localize(None).dt.normalize()
    row_keys = pd.MultiIndex.from_arrays([date_keys, data["ticker"]])
    data["market_cap_estimated"] = pd.to_numeric(
        values.reindex(row_keys), errors="coerce"
    ).to_numpy(dtype=np.float64)
    return data


def main():
    repo_root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description='Build the BigCaps daily_features dataset')
    parser.add_argument('--data-root', type=Path, default=repo_root/'data',
                        help='Root containing daily/ and metadata/splits.parquet')
    parser.add_argument('--input', type=Path, default=None,
                        help='Monthly OHLCV source (default: <data-root>/daily)')
    parser.add_argument('--splits', type=Path, default=None,
                        help='Split history (default: <data-root>/metadata/splits.parquet)')
    parser.add_argument('--output', type=Path, default=None,
                        help='Feature output (default: <data-root>/research/daily_features)')
    parser.add_argument('--buckets', type=int, default=32, help='Temporary ticker buckets (16-128)')
    parser.add_argument('--overwrite', action='store_true', help='Allow replacing existing feature Parquet files')
    parser.add_argument('--from-month', type=pd.Timestamp, help='First month to regenerate')
    args = parser.parse_args()
    data_root = args.data_root.resolve()
    input_root = (args.input or data_root/'daily').resolve()
    splits_path = (args.splits or data_root/'metadata'/'splits.parquet').resolve()
    output_root = (args.output or data_root/'research'/'daily_features').resolve()
    if not (16 <= args.buckets <= 128):
        parser.error('--buckets must be between 16 and 128')
    sources = sorted(input_root.glob('year=*/month=*.parquet'))
    first_month = args.from_month.to_datetime64() if args.from_month is not None else None
    if not sources or not splits_path.is_file():
        parser.error(f'Missing monthly Parquet files at {input_root} or split history at {splits_path}')
    if output_root.exists() and any(output_root.rglob('*.parquet')) and not args.overwrite:
        parser.error(f'Output already contains Parquet files at {output_root}. Use --overwrite to rebuild.')
    print(f'Loading splits for {len(sources)} monthly files...', flush=True)
    splits = load_splits(splits_path)
    with tempfile.TemporaryDirectory(prefix='massive_features_') as tmp:
        work = Path(tmp)
        buckets_dir = work/'buckets'
        calendars = set()
        counts = 0
        active_tickers = None
        if first_month is not None:
            active_tickers = set()
            for source in sources:
                month = source.parent.name[5:] + "-" + source.stem[6:]
                if month >= args.from_month.strftime('%Y-%m'):
                    active_tickers.update(pd.read_parquet(source, columns=['ticker']).ticker)
        # Assign every observation for a ticker to the same bucket.
        print('Stage 1/3: grouping OHLCV by ticker...', flush=True)
        for i, source in enumerate(sources, 1):
            frame = pd.read_parquet(source, columns=list(FIELDS))
            if frame[list(FIELDS)].isna().any().any():
                raise ValueError(f'Missing required values in {source}')
            if frame.duplicated(['date','ticker']).any():
                raise ValueError(f'Duplicate (date, ticker) keys in {source}')
            frame['date'] = pd.to_datetime(frame.date, utc=True).dt.tz_localize(None).dt.normalize()
            calendars.update(frame.date.unique())
            if active_tickers is not None:
                frame = frame[frame.ticker.isin(active_tickers)]
            counts += len(frame) if first_month is None else int((frame.date >= first_month).sum())
            bucket_codes = (pd.util.hash_pandas_object(frame.ticker, index=False).to_numpy(dtype=np.uint64) % args.buckets).astype(np.int16)
            for b in np.unique(bucket_codes):
                save(frame.iloc[np.flatnonzero(bucket_codes == b)], buckets_dir/f'b{b:03d}'/f'part_{i:04d}.parquet')
            if i % 12 == 0 or i == len(sources):
                print(f'  {i}/{len(sources)} months, {counts:,} rows', flush=True)
        sessions = sorted(calendars)
        session_index = {pd.Timestamp(d).to_datetime64(): i for i, d in enumerate(sessions)}
        print(f'Stage 2/3: calculating features across {len(sessions)} sessions...', flush=True)
        stage = work/'stage'
        for b in range(args.buckets):
            files = sorted((buckets_dir/f'b{b:03d}').glob('*.parquet'))
            if not files:
                continue
            frame = pd.concat((pd.read_parquet(f) for f in files), ignore_index=True)
            frame.sort_values(['ticker','date'], kind='stable', inplace=True)
            if frame.duplicated(['date', 'ticker']).any():
                raise ValueError('Duplicate keys across monthly partitions')
            outputs = []
            for ticker, g in frame.groupby('ticker', sort=False):
                if first_month is None or g.date.iloc[-1] >= first_month:
                    result = features_ticker(g, splits, session_index, first_month)
                    outputs.append(result if first_month is None else result[result.date >= first_month])
            del frame
            if not outputs:
                continue
            computed = pd.concat(outputs, ignore_index=True)
            computed['year'] = computed.date.dt.year
            computed['month'] = computed.date.dt.month
            for (year, month), piece in computed.groupby(['year','month'], sort=False):
                save(piece.drop(columns=['year','month']), stage/f'year={year}'/f'month={month:02d}'/f'b{b:03d}.parquet')
            print(f'  Bucket {b+1}/{args.buckets}', flush=True)
        print('Stage 3/3: ranking each session and exporting...', flush=True)
        expected_count = 0
        generated = []
        for folder in sorted(stage.glob('year=*/month=*')):
            data = pd.concat((pd.read_parquet(f) for f in sorted(folder.glob('*.parquet'))), ignore_index=True)
            expected_count += len(data)
            data = add_momentum_rankings(data)
            year = folder.parent.name
            month = folder.name
            target = output_root/year/f'{month}.parquet'
            data = preserve_existing_market_cap(data, target)
            # Keep persisted daily feature numerics at a maximum of two decimals.
            float_columns = data.select_dtypes(include=['floating']).columns
            data[float_columns] = data[float_columns].round(2)
            data.sort_values(['date','ticker'], inplace=True)
            save(data, target)
            generated.append(target)
            print(f'  {year}/{month}: {len(data):,} rows', flush=True)
        if expected_count != counts:
            raise RuntimeError(f'Row count mismatch: expected {counts}, wrote {expected_count}')
    print(f'OK: {counts:,} rows, {len(generated)} monthly Parquet files in {output_root}', flush=True)
    print('Splits are matched by ticker. Reused symbols require a historical identifier to distinguish issuers.', flush=True)


if __name__ == '__main__':
    main()
