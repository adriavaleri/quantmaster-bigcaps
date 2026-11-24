#!/usr/bin/env python3
"""Refresh momentum_3d and forward RTH outcomes in daily features.

For a feature row dated D, momentum_3d uses the previous market session's close
versus the close from three session intervals before it. This keeps the feature
available before the current session is complete, matching existing momentum
columns. The forward RTH outcomes use D's open as their shared entry price:
next_day_rth_return_pct measures through the next session's close, and
the other forward return fields measure through their respective session closes. Prices are adjusted for splits between D and
the exit session.
"""

from __future__ import annotations

import argparse
import os
import shutil
import tempfile
from pathlib import Path

import numpy as np
import pandas as pd
import pyarrow.parquet as pq

from tools.daily_features_pipeline.build_features import (
    load_splits,
    split_adjusted_forward_return,
    split_log_factors_for_rows,
)


FORWARD_SESSIONS = (*range(1, 11), *range(15, 41, 5))


def adjacent_partition(path: Path, offset: int) -> Path | None:
    year = int(path.parent.name.removeprefix("year="))
    month = int(path.stem.removeprefix("month=")) + offset
    if month < 1:
        year -= 1
        month = 12
    elif month > 12:
        year += 1
        month = 1
    adjacent = path.parents[1] / f"year={year}" / f"month={month:02d}.parquet"
    return adjacent if adjacent.is_file() else None


def compute_partition(path: Path, staging_root: Path, splits) -> tuple[Path, int, int, int, int]:
    features = pd.read_parquet(path)
    required = {"date", "ticker", "close", "rth_return_pct", "price_prev_close"}
    missing = required.difference(features.columns)
    if missing:
        raise ValueError(f"{path} is missing required columns: {', '.join(sorted(missing))}")

    current_prices = features[["date", "ticker", "close"]].copy()
    prior_path = adjacent_partition(path, -1)
    if prior_path is None:
        prior_prices = current_prices.iloc[0:0].copy()
    else:
        prior_prices = pd.read_parquet(prior_path, columns=["date", "ticker", "close"])
    future_prices = []
    future_dates = set()
    for next_path in sorted(path.parents[1].glob("year=*/month=*.parquet")):
        if next_path <= path:
            continue
        future = pd.read_parquet(next_path, columns=["date", "ticker", "close"])
        future_prices.append(future)
        future_dates.update(future["date"].dropna().unique())
        if len(future_dates) >= FORWARD_SESSIONS[-1]:
            break

    prices = pd.concat([prior_prices, current_prices, *future_prices], ignore_index=True)
    prices["_session_date"] = pd.to_datetime(prices["date"]).dt.strftime("%Y-%m-%d")
    if prices.duplicated(["_session_date", "ticker"]).any():
        raise ValueError(f"Duplicate date+ticker rows found across adjacent partitions for {path}")

    market_dates = sorted(prices["_session_date"].dropna().unique())
    session_offsets = pd.DataFrame({"_session_date": market_dates})
    session_offsets["_previous_session"] = session_offsets["_session_date"].shift(1)
    session_offsets["_three_sessions_back"] = session_offsets["_session_date"].shift(4)
    for days in FORWARD_SESSIONS:
        session_offsets[f"_forward_session_{days}"] = session_offsets["_session_date"].shift(-days)
    session_offsets = session_offsets.set_index("_session_date")

    features["_session_date"] = pd.to_datetime(features["date"]).dt.strftime("%Y-%m-%d")
    previous_dates = features["_session_date"].map(session_offsets["_previous_session"])
    base_dates = features["_session_date"].map(session_offsets["_three_sessions_back"])
    forward_dates = {
        days: features["_session_date"].map(session_offsets[f"_forward_session_{days}"])
        for days in FORWARD_SESSIONS
    }

    values_by_session = prices.set_index(["_session_date", "ticker"])
    tickers = features["ticker"].to_numpy()
    previous_keys = pd.MultiIndex.from_arrays([previous_dates.to_numpy(), tickers])
    base_keys = pd.MultiIndex.from_arrays([base_dates.to_numpy(), tickers])
    previous_close = pd.to_numeric(values_by_session["close"].reindex(previous_keys), errors="coerce").to_numpy(dtype=np.float64)
    base_close = pd.to_numeric(values_by_session["close"].reindex(base_keys), errors="coerce").to_numpy(dtype=np.float64)

    # A split effective between the base close and the previous close changes
    # their share basis. Convert both prices to a common basis before taking
    # the ratio; this uses only splits effective by the previous market session.
    previous_ns = pd.to_datetime(previous_dates, errors="coerce").to_numpy(dtype="datetime64[ns]")
    base_ns = pd.to_datetime(base_dates, errors="coerce").to_numpy(dtype="datetime64[ns]")
    previous_log_factor = split_log_factors_for_rows(tickers, previous_ns, splits).reshape(-1)
    base_log_factor = split_log_factors_for_rows(tickers, base_ns, splits).reshape(-1)
    with np.errstate(over="ignore", under="ignore", invalid="ignore"):
        split_adjustment = np.exp(previous_log_factor - base_log_factor)

    valid_momentum = (
        np.isfinite(previous_close)
        & np.isfinite(base_close)
        & np.isfinite(split_adjustment)
        & (previous_close > 0)
        & (base_close > 0)
        & (split_adjustment > 0)
    )
    momentum = np.full(len(features), np.nan, dtype=np.float64)
    momentum[valid_momentum] = (
        previous_close[valid_momentum] * split_adjustment[valid_momentum] / base_close[valid_momentum] - 1.0
    ) * 100.0
    entry_open = (
        pd.to_numeric(features["open"], errors="coerce").to_numpy(dtype=np.float64)
        if "open" in features.columns
        else np.full(len(features), np.nan, dtype=np.float64)
    )
    entry_dates = pd.to_datetime(features["_session_date"], errors="coerce").to_numpy(dtype="datetime64[ns]")
    entry_log_factors = split_log_factors_for_rows(tickers, entry_dates, splits).reshape(-1)
    forward_date_matrix = np.column_stack([
        pd.to_datetime(forward_dates[days], errors="coerce").to_numpy(dtype="datetime64[ns]")
        for days in FORWARD_SESSIONS
    ])
    forward_log_factors = split_log_factors_for_rows(tickers, forward_date_matrix, splits)

    next_day_return = np.full(len(features), np.nan, dtype=np.float64)
    forward_returns = {}
    for column_index, days in enumerate(FORWARD_SESSIONS):
        keys = pd.MultiIndex.from_arrays([forward_dates[days].to_numpy(), tickers])
        exit_close = pd.to_numeric(
            values_by_session["close"].reindex(keys), errors="coerce"
        ).to_numpy(dtype=np.float64)
        exit_log_factors = forward_log_factors[:, column_index]
        valid = (
            np.isfinite(entry_open)
            & np.isfinite(exit_close)
            & np.isfinite(entry_log_factors)
            & np.isfinite(exit_log_factors)
            & (entry_open > 0)
            & (exit_close > 0)
        )
        returns = np.full(len(features), np.nan, dtype=np.float64)
        returns[valid] = 100.0 * split_adjusted_forward_return(
            entry_open[valid],
            exit_close[valid],
            entry_log_factors[valid],
            exit_log_factors[valid],
        )
        if days == 1:
            next_day_return = returns
        else:
            forward_returns[days] = returns
    recalculated = ["momentum_3d", "rank_3d", "next_day_rth_return_pct"]
    recalculated.extend(f"forward_rth_return_{days}d_pct" for days in forward_returns)
    features.drop(columns=recalculated, errors="ignore", inplace=True)
    stale_percentiles = [name for name in features.columns if name.startswith("pct_rank_")]
    if stale_percentiles:
        features.drop(columns=stale_percentiles, inplace=True)
    insert_at = features.columns.get_loc("momentum_1w") if "momentum_1w" in features.columns else len(features.columns)
    features.insert(insert_at, "momentum_3d", momentum)
    rank_eligible = pd.to_numeric(features["price_prev_close"], errors="coerce") >= 1.0
    rank_valid = rank_eligible & np.isfinite(features["momentum_3d"].to_numpy(dtype=np.float64))
    features["rank_3d"] = np.nan
    ranks_3d = features.loc[rank_valid].groupby("date")["momentum_3d"].rank(
        ascending=False, method="min"
    )
    features.loc[ranks_3d.index, "rank_3d"] = ranks_3d
    features["next_day_rth_return_pct"] = next_day_return
    for days, values in forward_returns.items():
        features[f"forward_rth_return_{days}d_pct"] = values
    features.drop(columns=["_session_date"], inplace=True)

    relative_path = path.relative_to(path.parents[1])
    staged_path = staging_root / relative_path
    staged_path.parent.mkdir(parents=True, exist_ok=True)
    features.to_parquet(staged_path, index=False, compression="zstd")
    forward_count = sum(int(np.isfinite(values).sum()) for values in forward_returns.values())
    return staged_path, len(features), int(valid_momentum.sum()), int(np.isfinite(next_day_return).sum()), forward_count


def main() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--data-root",
        type=Path,
        default=repo_root / "data",
        help="Dataset root containing research/daily_features (default: repository data/)",
    )
    parser.add_argument("--from-month", help="First month of forward returns to regenerate")
    args = parser.parse_args()

    data_root = args.data_root.resolve()
    features_root = (data_root / "research" / "daily_features").resolve()
    if not features_root.is_dir():
        raise SystemExit(f"Daily feature directory does not exist: {features_root}")
    splits_path = data_root / "metadata" / "splits.parquet"
    if not splits_path.is_file():
        raise SystemExit(f"Split history does not exist: {splits_path}")
    splits = load_splits(splits_path)
    partitions = sorted(features_root.glob("year=*/month=*.parquet"))
    if args.from_month:
        partitions = [
            path for path in partitions
            if path.parent.name[5:] + "-" + path.stem[6:] >= args.from_month
        ]
    if not partitions:
        raise SystemExit(f"No monthly feature Parquets found under {features_root}")

    staging_root = Path(tempfile.mkdtemp(prefix=".momentum_3d_staging_", dir=features_root))
    try:
        staged: list[tuple[Path, Path, int, int, int, int]] = []
        for path in partitions:
            staged_path, rows, valid_rows, next_day_rows, forward_rows = compute_partition(
                path, staging_root, splits
            )
            output_schema = pq.ParquetFile(staged_path).schema_arrow
            if "momentum_3d" not in output_schema.names:
                raise RuntimeError(f"Staged Parquet is missing momentum_3d: {staged_path}")
            if "rank_3d" not in output_schema.names:
                raise RuntimeError(f"Staged Parquet is missing rank_3d: {staged_path}")
            if any(name.startswith("pct_rank_") for name in output_schema.names):
                raise RuntimeError(f"Staged Parquet still contains percentile ranking fields: {staged_path}")
            if "next_day_rth_return_pct" not in output_schema.names:
                raise RuntimeError(f"Staged Parquet is missing next_day_rth_return_pct: {staged_path}")
            missing_forward = [
                f"forward_rth_return_{days}d_pct"
                for days in FORWARD_SESSIONS[1:]
                if f"forward_rth_return_{days}d_pct" not in output_schema.names
            ]
            if missing_forward:
                raise RuntimeError(f"Staged Parquet is missing forward return columns {missing_forward}: {staged_path}")
            if pq.ParquetFile(staged_path).metadata.num_rows != rows:
                raise RuntimeError(f"Row count changed while writing {staged_path}")
            staged.append((path, staged_path, rows, valid_rows, next_day_rows, forward_rows))

        for original, staged_path, _, _, _, _ in staged:
            os.replace(staged_path, original)

        total_rows = sum(rows for _, _, rows, _, _, _ in staged)
        total_valid = sum(valid_rows for _, _, _, valid_rows, _, _ in staged)
        total_next_day = sum(next_day_rows for _, _, _, _, next_day_rows, _ in staged)
        total_forward = sum(forward_rows for _, _, _, _, _, forward_rows in staged)
        print(
            f"Updated {len(staged)} Parquet partitions; "
            f"{total_rows:,} rows, {total_valid:,} non-null momentum_3d values, "
            f"{total_next_day:,} non-null D0-open-to-D+1-close returns, "
            f"{total_forward:,} non-null D0-open-to-close returns for selected sessions through +40."
        )
    finally:
        resolved_features_root = features_root.resolve()
        resolved_staging_root = staging_root.resolve()
        if resolved_staging_root.parent != resolved_features_root:
            raise RuntimeError(f"Refusing to remove staging outside {resolved_features_root}: {resolved_staging_root}")
        shutil.rmtree(staging_root, ignore_errors=True)


if __name__ == "__main__":
    main()
