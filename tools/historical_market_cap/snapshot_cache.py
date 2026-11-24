"""Cache historical Massive ticker snapshots."""

from __future__ import annotations
import json
import sqlite3
import time
from concurrent.futures import FIRST_COMPLETED, ThreadPoolExecutor, wait
from pathlib import Path
from typing import Any
import numpy as np
import pandas as pd
import daily_estimates as pilot

SNAPSHOT_COLUMNS = [
    "ticker", "snapshot_date", "http_status", "api_status", "returned_ticker", "name",
    "market_cap", "weighted_shares_outstanding", "cik", "composite_figi",
    "share_class_figi", "type", "primary_exchange", "active", "last_updated_utc",
    "response_has_result", "fetch_error", "fetched_at_utc",
]

TEXT_COLUMNS = [
    "ticker", "snapshot_date", "api_status", "returned_ticker", "name", "cik",
    "composite_figi", "share_class_figi", "type", "primary_exchange",
    "last_updated_utc", "fetch_error", "fetched_at_utc",
]

DAILY_TEXT_COLUMNS = [
    "date", "ticker", "market_cap_direct_source", "market_cap_direct_snapshot_date",
    "market_cap_estimated_source", "market_cap_estimated_snapshot_date",
    "identity_cik", "identity_composite_figi", "identity_share_class_figi",
]

def clean_text(value: Any) -> str | None:
    if value is None or pd.isna(value) or str(value).strip() == "":
        return None
    return str(value).strip()

def clean_number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if np.isfinite(number) else None

def response_to_row(record: dict[str, Any]) -> tuple[Any, ...]:
    body = record.get("body") if isinstance(record.get("body"), dict) else {}
    result = body.get("results") if isinstance(body.get("results"), dict) else {}
    status = record.get("status_code")
    try:
        status = int(status) if status is not None else None
    except (TypeError, ValueError):
        status = None
    active = result.get("active")
    if active is not None:
        active = int(bool(active))
    return (
        str(record["ticker"]), str(record["snapshot_date"]), status,
        clean_text(body.get("status")), clean_text(result.get("ticker")), clean_text(result.get("name")),
        clean_number(result.get("market_cap")), clean_number(result.get("weighted_shares_outstanding")),
        clean_text(result.get("cik")), clean_text(result.get("composite_figi")),
        clean_text(result.get("share_class_figi")), clean_text(result.get("type")),
        clean_text(result.get("primary_exchange")), active,
        clean_text(result.get("last_updated_utc")), int(bool(result)),
        clean_text(record.get("error")), clean_text(record.get("fetched_at_utc")),
    )

class SnapshotCache:
    def __init__(self, path: Path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(path, timeout=60)
        self.conn.execute("PRAGMA journal_mode=WAL")
        self.conn.execute("PRAGMA synchronous=NORMAL")
        self.conn.execute("PRAGMA temp_store=MEMORY")
        self.conn.execute("""CREATE TABLE IF NOT EXISTS snapshots (
            ticker TEXT NOT NULL, snapshot_date TEXT NOT NULL, http_status INTEGER,
            api_status TEXT, returned_ticker TEXT, name TEXT, market_cap REAL,
            weighted_shares_outstanding REAL, cik TEXT, composite_figi TEXT,
            share_class_figi TEXT, type TEXT, primary_exchange TEXT, active INTEGER,
            last_updated_utc TEXT, response_has_result INTEGER NOT NULL DEFAULT 0,
            fetch_error TEXT, fetched_at_utc TEXT,
            PRIMARY KEY (ticker, snapshot_date)
        )""")
        self.conn.execute("CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT)")
        self.conn.commit()
        self.insert_sql = "INSERT OR REPLACE INTO snapshots VALUES (" + ",".join(["?"] * len(SNAPSHOT_COLUMNS)) + ")"

    def import_jsonl_once(self, path: Path) -> int:
        if self.conn.execute("SELECT 1 FROM metadata WHERE key='stage_600_cache_imported'").fetchone():
            return 0
        imported = 0
        rows: list[tuple[Any, ...]] = []
        if path.exists():
            with path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    try:
                        record = json.loads(line)
                        rows.append(response_to_row(record))
                    except (json.JSONDecodeError, KeyError, TypeError):
                        continue
                    if len(rows) >= 1000:
                        self.conn.executemany(self.insert_sql, rows)
                        self.conn.commit()
                        imported += len(rows)
                        rows.clear()
        if rows:
            self.conn.executemany(self.insert_sql, rows)
            self.conn.commit()
            imported += len(rows)
        self.conn.execute("INSERT OR REPLACE INTO metadata VALUES ('stage_600_cache_imported', ?)", (str(imported),))
        self.conn.commit()
        return imported

    @staticmethod
    def complete(status: Any, error: Any) -> bool:
        return status == 404 or (status == 200 and error is None)

    def records_for_tickers(self, tickers: list[str]) -> dict[tuple[str, str], tuple[Any, Any]]:
        if not tickers:
            return {}
        marks = ",".join(["?"] * len(tickers))
        rows = self.conn.execute(
            f"SELECT ticker,snapshot_date,http_status,fetch_error FROM snapshots WHERE ticker IN ({marks})",
            tickers,
        ).fetchall()
        return {(str(r[0]), str(r[1])): (r[2], r[3]) for r in rows}

    def upsert(self, record: dict[str, Any]) -> None:
        self.conn.execute(self.insert_sql, response_to_row(record))

    def snapshots_for_tickers(self, tickers: list[str]) -> pd.DataFrame:
        marks = ",".join(["?"] * len(tickers))
        frame = pd.read_sql_query(
            f"SELECT {','.join(SNAPSHOT_COLUMNS)} FROM snapshots WHERE ticker IN ({marks}) ORDER BY ticker,snapshot_date",
            self.conn,
            params=tickers,
        )
        if frame.empty:
            return pd.DataFrame(columns=SNAPSHOT_COLUMNS)
        for column in TEXT_COLUMNS:
            frame[column] = frame[column].astype("string")
        for column in ("http_status", "market_cap", "weighted_shares_outstanding"):
            frame[column] = pd.to_numeric(frame[column], errors="coerce").astype("float64")
        frame["response_has_result"] = frame["response_has_result"].fillna(0).astype(bool)
        frame["active"] = frame["active"].astype("boolean")
        return frame

    def status_counts(self) -> dict[str, int]:
        return {str(status): int(n) for status, n in self.conn.execute(
            "SELECT http_status,COUNT(*) FROM snapshots GROUP BY http_status ORDER BY http_status"
        ).fetchall()}

    def error_frame(self) -> pd.DataFrame:
        return pd.read_sql_query(
            """SELECT ticker,snapshot_date,http_status,
                      COALESCE(fetch_error,CASE WHEN http_status=200 THEN 'http_200_without_results' END) AS error
               FROM snapshots WHERE http_status IS NULL OR http_status<>200 OR response_has_result=0
               ORDER BY ticker,snapshot_date""", self.conn
        )

    def close(self) -> None:
        self.conn.commit()
        self.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        self.conn.close()

def write_part(frame: pd.DataFrame, path: Path, daily: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if daily:
        for column in DAILY_TEXT_COLUMNS:
            if column in frame.columns:
                frame[column] = frame[column].astype("string")
        for column in ("market_cap_direct_pit", "market_cap_estimated_pit", "identity_valid", "split_blocked"):
            if column in frame.columns:
                frame[column] = frame[column].astype(bool)
        for column in ("close_no_adjusted", "market_cap_direct", "market_cap_estimated", "weighted_shares_outstanding_used", "weighted_shares_snapshot_age_days", "snapshot_direct_market_cap_value", "snapshot_weighted_shares_value", "snapshot_http_status_at_session"):
            if column in frame.columns:
                frame[column] = pd.to_numeric(frame[column], errors="coerce").astype("float64")
    pilot.write_parquet_atomic(frame, path)

def ensure_plan_cached(plan: pd.DataFrame, tickers: list[str], cache: SnapshotCache, workers: int, api_key: str) -> tuple[int, dict[str, int]]:
    cached = cache.records_for_tickers(tickers)
    pending = [
        row.to_dict() for _, row in plan.iterrows()
        if (str(row["ticker"]), str(row["snapshot_date"])) not in cached
        or not cache.complete(*cached[(str(row["ticker"]), str(row["snapshot_date"]))])
    ]
    if pending and not api_key:
        raise RuntimeError(f"{len(pending)} Massive snapshots are uncached; set MASSIVE_API_KEY to continue.")
    print(f"batch_month_queries={len(plan)} cached={len(plan)-len(pending)} to_fetch={len(pending)}", flush=True)
    if not pending:
        return 0, {}

    started = time.monotonic()
    status_counts: dict[str, int] = {}
    iterator = iter(pending)
    max_inflight = max(workers * 8, workers)
    submitted = 0
    completed = 0
    with ThreadPoolExecutor(max_workers=workers) as pool:
        futures = {}
        def fill() -> None:
            nonlocal submitted
            while len(futures) < max_inflight:
                try:
                    item = next(iterator)
                except StopIteration:
                    break
                futures[pool.submit(pilot.api_request, item, api_key)] = item
                submitted += 1
        fill()
        while futures:
            finished, _ = wait(futures, return_when=FIRST_COMPLETED)
            for future in finished:
                futures.pop(future)
                response = future.result()
                cache.upsert(response)
                status = response.get("status_code")
                status_counts[str(status)] = status_counts.get(str(status), 0) + 1
                completed += 1
                if completed % 500 == 0:
                    cache.conn.commit()
                if completed % 1000 == 0 or completed == len(pending):
                    elapsed = max(time.monotonic() - started, 1e-9)
                    rate = completed / elapsed
                    eta_min = (len(pending) - completed) / max(rate, 1e-9) / 60
                    print(f"batch_fetched={completed}/{len(pending)} rate={rate:.1f}/s ETA={eta_min:.1f}m status={status}", flush=True)
            fill()
    cache.conn.commit()
    return completed, status_counts

def normalize_snapshot_batch(frame: pd.DataFrame, plan: pd.DataFrame) -> pd.DataFrame:
    if frame.empty:
        frame = pd.DataFrame(columns=SNAPSHOT_COLUMNS)
    valid = set((str(r.ticker), str(r.snapshot_date)) for r in plan.itertuples(index=False))
    frame = frame[[ (str(t), str(d)) in valid for t, d in zip(frame["ticker"], frame["snapshot_date"]) ]].copy()
    frame = frame.sort_values(["ticker", "snapshot_date"]).reset_index(drop=True)
    return frame
