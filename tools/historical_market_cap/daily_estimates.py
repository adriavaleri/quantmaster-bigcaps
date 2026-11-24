"""Calculate daily market cap from dated share snapshots and unadjusted closes."""

from __future__ import annotations
import json
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
import duckdb
import numpy as np
import pandas as pd
import requests

ROOT = Path(__file__).resolve().parent

DAILY_GLOB = ROOT / "data" / "daily" / "year=*" / "month=*.parquet"

BASE_URL = "https://api.massive.com/v3/reference/tickers"

_HTTP_LOCAL = threading.local()

def http_session() -> requests.Session:
    """Reuse one keep-alive connection pool per worker thread."""
    session = getattr(_HTTP_LOCAL, "session", None)
    if session is None:
        session = requests.Session()
        adapter = requests.adapters.HTTPAdapter(pool_connections=1, pool_maxsize=1)
        session.mount("https://", adapter)
        _HTTP_LOCAL.session = session
    return session

def api_request(item: dict[str, Any], key: str) -> dict[str, Any]:
    ticker = str(item["ticker"])
    snapshot_date = str(item["snapshot_date"])
    last_status: int | None = None
    last_error: str | None = None
    body: dict[str, Any] | None = None
    for attempt in range(5):
        try:
            response = http_session().get(
                f"{BASE_URL}/{requests.utils.quote(ticker, safe='')}",
                params={"date": snapshot_date},
                headers={"Authorization": f"Bearer {key}"},
                timeout=45,
            )
            last_status = int(response.status_code)
            last_error = None
            if response.ok:
                try:
                    parsed = response.json()
                    body = parsed if isinstance(parsed, dict) else None
                    if body is None:
                        last_error = "invalid_json_object"
                except ValueError:
                    last_error = "invalid_json"
                if body is not None or last_error:
                    break
            else:
                last_error = f"http_{response.status_code}"
            if last_status not in (429, 500, 502, 503, 504) or attempt == 4:
                break
        except requests.RequestException as exc:
            last_status = None
            last_error = type(exc).__name__
            if attempt == 4:
                break
        time.sleep(min(2 ** attempt, 16))
    return {
        "ticker": ticker,
        "snapshot_date": snapshot_date,
        "status_code": last_status,
        "error": last_error,
        "body": body,
        "fetched_at_utc": datetime.now(timezone.utc).isoformat(),
    }

def numeric_or_none(value: Any) -> float | None:
    try:
        result = float(value)
    except (ValueError, TypeError):
        return None
    return result if np.isfinite(result) else None

def nonempty(value: Any) -> str | None:
    if value is None or pd.isna(value) or str(value).strip() == "":
        return None
    return str(value).strip()

def make_daily_estimates(
    con: duckdb.DuckDBPyConnection,
    selection: pd.DataFrame,
    snapshots: pd.DataFrame,
    splits: pd.DataFrame,
    *,
    daily_src: str | None = None,
) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    selected = selection.drop_duplicates("ticker")
    con.register("daily_mc_pilot_tickers", selected)
    start = "WHERE CAST(d.date AS DATE) >= p.warmup_date::DATE" if "warmup_date" in selected else ""
    daily = con.execute(
        f"""SELECT CAST(d.date AS DATE) AS date, d.ticker, d.open, d.high, d.low,
                   d.close AS close_no_adjusted, d.volume, d.vwap, d.transactions
            FROM read_parquet('{daily_src or DAILY_GLOB.as_posix()}') d
            INNER JOIN daily_mc_pilot_tickers p USING (ticker)
            {start}
            ORDER BY d.ticker, date"""
    ).fetchdf()
    con.unregister("daily_mc_pilot_tickers")
    daily["date"] = pd.to_datetime(daily["date"]).dt.date
    snapshots = snapshots.copy()
    snapshots["snapshot_date"] = pd.to_datetime(snapshots["snapshot_date"]).dt.date
    snap_by_ticker: dict[str, dict[Any, dict[str, Any]]] = {}
    for _, row in snapshots.iterrows():
        snap_by_ticker.setdefault(str(row["ticker"]), {})[row["snapshot_date"]] = row.to_dict()

    split_frame = splits.copy()
    split_frame["ticker"] = split_frame["ticker"].astype(str)
    split_frame["execution_date"] = pd.to_datetime(split_frame["execution_date"], errors="coerce").dt.date
    split_by_ticker: dict[str, list[dict[str, Any]]] = {}
    for _, row in split_frame.dropna(subset=["execution_date"]).iterrows():
        split_by_ticker.setdefault(row["ticker"], []).append({
            "date": row["execution_date"], "id": row.get("id"),
            "split_from": row.get("split_from"), "split_to": row.get("split_to"),
            "adjustment_type": row.get("adjustment_type"),
        })
    for ticker in split_by_ticker:
        split_by_ticker[ticker].sort(key=lambda x: x["date"])

    daily_rows: list[dict[str, Any]] = []
    identity_events: list[dict[str, Any]] = []
    split_events: list[dict[str, Any]] = []
    for ticker, group in daily.groupby("ticker", sort=False):
        ticker = str(ticker)
        snaps = snap_by_ticker.get(ticker, {})
        events = split_by_ticker.get(ticker, [])
        event_pos = 0
        current_shares: float | None = None
        current_share_snapshot_date = None
        current_identity: dict[str, str] = {}
        current_identity_valid = False
        last_processed_split = None
        snapshot_status = None
        snapshot_for_day: dict[str, Any] | None = None
        for _, drow in group.sort_values("date").iterrows():
            day = drow["date"]
            # A split invalidates carried shares immediately; they resume only
            # after a later dated Massive snapshot supplies post-split shares.
            while event_pos < len(events) and events[event_pos]["date"] <= day:
                event = events[event_pos]
                if last_processed_split is None or event["date"] > last_processed_split:
                    current_shares = None
                    current_share_snapshot_date = None
                    last_processed_split = event["date"]
                    split_events.append({
                        "ticker": ticker, "split_date": event["date"].isoformat(),
                        "split_id": event["id"], "split_from": event["split_from"],
                        "split_to": event["split_to"], "adjustment_type": event["adjustment_type"],
                        "blocked_from_date": event["date"].isoformat(),
                    })
                event_pos += 1

            snapshot_for_day = snaps.get(day)
            if snapshot_for_day is not None:
                snapshot_status = snapshot_for_day.get("http_status")
                if snapshot_status == 200:
                    identities = {
                        field: value for field in ("cik", "composite_figi", "share_class_figi")
                        if (value := nonempty(snapshot_for_day.get(field))) is not None
                    }
                    previous_identity = current_identity.copy()
                    conflicts = {
                        field: (current_identity[field], identities[field])
                        for field in set(current_identity).intersection(identities)
                        if current_identity[field] != identities[field]
                    }
                    shared_identity_fields = set(current_identity).intersection(identities)
                    continuous_identity = bool(shared_identity_fields) and not conflicts
                    if not identities:
                        current_shares = None
                        current_share_snapshot_date = None
                        current_identity = {}
                        current_identity_valid = False
                    else:
                        if previous_identity and not continuous_identity:
                            # Never carry old-identity shares forward. The
                            # dated current snapshot can establish the new
                            # identity and its own shares without an arbitrary
                            # second-observation wait.
                            current_shares = None
                            current_share_snapshot_date = None
                            identity_events.append({
                                "ticker": ticker, "snapshot_date": day.isoformat(),
                                "previous_identity": json.dumps(previous_identity, sort_keys=True),
                                "new_identity": json.dumps(identities, sort_keys=True),
                                "conflicting_fields": json.dumps(conflicts, sort_keys=True),
                                "shared_identity_fields": json.dumps(sorted(shared_identity_fields)),
                                "action": "reset_old_shares_then_use_current_dated_snapshot",
                            })
                        current_identity = identities
                        current_identity_valid = True
                    shares = numeric_or_none(snapshot_for_day.get("weighted_shares_outstanding"))
                    if not snapshot_for_day.get("response_has_result") or shares is None or shares <= 0:
                        current_shares = None
                        current_share_snapshot_date = None
                    elif not current_identity_valid:
                        current_shares = None
                        current_share_snapshot_date = None
                    elif last_processed_split is not None and day <= last_processed_split:
                        # Same-day split timing cannot be verified from monthly snapshots.
                        current_shares = None
                        current_share_snapshot_date = None
                    else:
                        current_shares = shares
                        current_share_snapshot_date = day
                elif snapshot_status == 404:
                    # An explicit no-ticker historical response is treated as
                    # missing shares rather than carrying an older observation.
                    current_shares = None
                    current_share_snapshot_date = None
                    current_identity = {}
                    current_identity_valid = False

            close = numeric_or_none(drow["close_no_adjusted"])
            estimated = close * current_shares if close is not None and current_shares is not None else None
            direct = None
            direct_snapshot_date = None
            direct_wso = None
            if snapshot_for_day is not None and snapshot_for_day.get("http_status") == 200:
                direct = numeric_or_none(snapshot_for_day.get("market_cap"))
                direct_snapshot_date = day.isoformat() if direct is not None else None
                direct_wso = numeric_or_none(snapshot_for_day.get("weighted_shares_outstanding"))
            identity_description = json.dumps(current_identity, sort_keys=True) if current_identity else None
            age = (day - current_share_snapshot_date).days if current_share_snapshot_date else None
            daily_rows.append({
                "date": day.isoformat(), "ticker": ticker,
                "close_no_adjusted": close,
                "market_cap_direct": direct,
                "market_cap_direct_source": "massive_ticker_overview",
                "market_cap_direct_snapshot_date": direct_snapshot_date,
                "market_cap_direct_pit": False,
                "market_cap_estimated": estimated,
                "market_cap_estimated_source": "massive_daily_close_x_massive_weighted_shares_outstanding",
                "market_cap_estimated_snapshot_date": current_share_snapshot_date.isoformat() if current_share_snapshot_date else None,
                "weighted_shares_outstanding_used": current_shares,
                "weighted_shares_snapshot_age_days": age,
                "identity_cik": current_identity.get("cik"),
                "identity_composite_figi": current_identity.get("composite_figi"),
                "identity_share_class_figi": current_identity.get("share_class_figi"),
                "identity_valid": bool(current_identity_valid and current_shares is not None),
                "snapshot_http_status_at_session": snapshot_status if snapshot_for_day is not None else None,
                "snapshot_direct_market_cap_value": direct,
                "snapshot_weighted_shares_value": direct_wso,
                "split_blocked": bool(last_processed_split is not None and (current_share_snapshot_date is None or current_share_snapshot_date <= last_processed_split)),
                "market_cap_estimated_pit": False,
            })
    return pd.DataFrame(daily_rows), pd.DataFrame(identity_events), pd.DataFrame(split_events)

def write_parquet_atomic(df: pd.DataFrame, path: Path) -> None:
    temp = path.with_suffix(path.suffix + ".tmp")
    df.to_parquet(temp, index=False, compression="zstd")
    temp.replace(path)
