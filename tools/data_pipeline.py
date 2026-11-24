"""Build or update the BigCaps daily dataset from Massive."""
from __future__ import annotations

import argparse
from collections import Counter
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import date, datetime, timedelta
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
from tempfile import TemporaryDirectory
from zoneinfo import ZoneInfo

import duckdb
import pandas as pd
import requests

from tools.massive_pipeline import download_flat_daily as flat
from tools.massive_pipeline.filter_daily_types import process_month, write_atomic_parquet
from tools.daily_features_pipeline.add_forward_features import FORWARD_SESSIONS

ROOT = Path(__file__).resolve().parents[1]
LOCAL_STATE = ROOT.with_name(f"{ROOT.name}.local")


def command(module, *args):
    subprocess.run([sys.executable, "-m", module, *map(str, args)], cwd=ROOT, check=True)


def partitions(folder):
    return sorted(folder.glob("year=*/month=*.parquet"))


def save_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(value, indent=2), encoding="utf8")
    tmp.replace(path)


def append_partition(incoming, destination):
    new = pd.read_parquet(incoming)
    if destination.exists():
        old = pd.read_parquet(destination)
        # On a retry, replace just the sessions already written by this batch.
        new_dates = pd.to_datetime(new.date)
        new = pd.concat([old[~pd.to_datetime(old.date).isin(new_dates)], new], ignore_index=True)
    if new.duplicated(["date", "ticker"]).any():
        raise ValueError(f"Duplicate ticker/session in {destination}")
    write_atomic_parquet(new.sort_values(["date", "ticker"]), destination)


def update_daily(data, work, start, end, workers):
    daily = data / "daily"
    with requests.Session() as session:
        session.headers["Authorization"] = "Bearer " + os.environ["MASSIVE_API_KEY"]
        with closing(flat.client()) as s3, ThreadPoolExecutor(max_workers=workers) as pool:
            for (year, month), objects in flat.list_files(s3, start, end).items():
                relative = Path(f"year={year}") / f"month={month:02d}.parquet"
                target = daily / relative
                unknown = daily / "unknown" / relative
                marker = work / "sessions" / relative.with_suffix(".json")
                complete = set()
                if target.exists():
                    complete.update(pd.to_datetime(pd.read_parquet(target, columns=["date"]).date).dt.strftime("%Y-%m-%d"))
                    if marker.exists():
                        complete.update(json.loads(marker.read_text()))
                pending = [(day, key) for day, key in objects if day not in complete]
                if not pending:
                    continue
                with TemporaryDirectory(dir=work) as scratch:
                    temporary = Path(scratch)
                    raw = pd.concat(pool.map(lambda item: flat.month_frame(s3, [item]), pending), ignore_index=True)
                    source = temporary / relative.name
                    write_atomic_parquet(raw, source)
                    kept, rejected = temporary / "daily.parquet", temporary / "unknown.parquet"
                    process_month(session, source, kept, data / "metadata/massive_tickers_daily",
                                  temporary / "audit.csv", rejected, False, workers)
                    append_partition(rejected, unknown)
                    append_partition(kept, target)
                    save_json(marker, sorted(complete | {day for day, _ in pending}))


def update_splits(data, work, end, start):
    target = data / "metadata/splits.parquet"
    marker = work / "splits.json"
    if target.exists():
        latest = pd.read_parquet(target, columns=["execution_date"]).execution_date.max()
        if pd.notna(latest):
            end = max(end, pd.Timestamp(latest).date())
    if target.exists() and marker.exists() and json.loads(marker.read_text()) == [str(start), str(end)]:
        return
    with TemporaryDirectory(dir=work) as scratch:
        path = Path(scratch) / "splits.parquet"
        command("tools.massive_pipeline.download_splits", "--start", start, "--end", end, "--output", path)
        if not target.exists() or not pd.read_parquet(target).equals(pd.read_parquet(path)):
            target.parent.mkdir(parents=True, exist_ok=True)
            write_atomic_parquet(pd.read_parquet(path), target)
            shutil.copyfile(path.with_suffix(".audit.json"), target.with_suffix(".audit.json"))
        save_json(marker, [str(start), str(end)])


def build_features(data, work):
    files = partitions(data / "daily")
    splits = data / "metadata/splits.parquet"
    if not files or not splits.is_file():
        raise ValueError("Daily Parquet and metadata/splits.parquet are required")
    scripts = sorted((ROOT / "tools/daily_features_pipeline").glob("*.py"))
    feature_code = hashlib.sha256(b"".join(path.read_text(encoding="utf-8").encode() for path in scripts)).hexdigest()
    # English diagnostics and the removal of a standalone repair utility preserve feature values.
    if feature_code == "96557df22dd334dc7d635a7087cf830b57acbcfdc81617f96b7b9b9e0aab8065":
        feature_code = "426731104cafa7479dd8392d9e4d9441663b9c517a6475701e30587d49c534b4"
    split_columns = ["execution_date", "ticker", "split_from", "split_to"]
    events = pd.read_parquet(splits, columns=split_columns)
    events["execution_date"] = pd.to_datetime(events.execution_date).dt.strftime("%Y-%m-%d")
    split_events = sorted(events.itertuples(index=False, name=None))
    signature = {
        "code": feature_code,
        "splits": split_events,
        "daily": {p.relative_to(data / "daily").as_posix(): [p.stat().st_size, p.stat().st_mtime_ns] for p in files},
    }
    marker = work / "features.json"
    output = data / "research/daily_features"
    expected = {p.relative_to(data / "daily") for p in files}
    previous = json.loads(marker.read_text()) if marker.exists() else None
    options = []
    if (isinstance(previous, dict) and previous["code"] == signature["code"]
            and previous["daily"].keys() <= signature["daily"].keys()):
        old_splits = Counter(map(tuple, previous["splits"]))
        new_splits = Counter(split_events)
        changed_splits = (old_splits - new_splits) + (new_splits - old_splits)
        first_split_month = min((event[0][:7] for event in changed_splits), default=None)
        months = [path.parent.name[5:] + "-" + path.stem[6:] for path in files]
        changed = [
            i for i, path in enumerate(files)
            if previous["daily"].get(path.relative_to(data / "daily").as_posix())
            != signature["daily"][path.relative_to(data / "daily").as_posix()]
            or not (output / path.relative_to(data / "daily")).is_file()
            or (first_split_month is not None and months[i] >= first_split_month)
        ]
        if not changed:
            print("Daily features already up to date.", flush=True)
            return
        first = forward_first = changed[0]
        preceding_sessions = set()
        while forward_first > 0 and len(preceding_sessions) < FORWARD_SESSIONS[-1]:
            forward_first -= 1
            preceding_sessions.update(pd.read_parquet(files[forward_first], columns=["date"]).date.unique())
        core_month = months[first]
        forward_month = months[forward_first]
        print(f"Refreshing core features from {core_month} and forward returns from {forward_month}.", flush=True)
        options = ["--from-month", core_month, "--forward-from-month", forward_month]
    command("tools.daily_features_pipeline.run", "--data-root", data, "--overwrite", *options)
    actual = {p.relative_to(output) for p in partitions(output)}
    if actual != expected:
        raise RuntimeError("Daily and daily_features month partitions differ")
    save_json(marker, signature)


def publish_market_cap(data, staging, start, end):
    manifest = staging / "manifest.json"
    if not manifest.is_file() or (staging / "pending.json").exists():
        raise RuntimeError("Market Cap staging is incomplete")
    features_root = data / "research/daily_features"
    total = 0
    with TemporaryDirectory(dir=staging) as scratch, closing(duckdb.connect()) as con:
        source = (staging / "corrected/part-*.parquet").as_posix()
        output = Path(scratch).as_posix().replace("'", "''")
        source = source.replace("'", "''")
        con.execute(f"""
            CREATE TEMP VIEW corrected AS
            SELECT ticker, CAST(date AS DATE) AS day, market_cap_estimated_corrected AS cap,
                   market_cap_estimated_pit AS pit
            FROM read_parquet('{source}')
        """)
        con.execute("""
            CREATE TEMP TABLE candidates AS
            SELECT ticker, day, cap, year(day) AS y, month(day) AS m
            FROM corrected WHERE day BETWEEN ? AND ? AND cap IS NOT NULL AND pit = false
        """, [start, end])
        rows, unique_keys = con.sql("SELECT count(*), count(DISTINCT (day,ticker)) FROM candidates").fetchone()
        if rows != unique_keys:
            raise RuntimeError("Duplicate Market Cap candidates")
        if not rows:
            return
        con.execute(f"COPY candidates TO '{output}' (FORMAT PARQUET, PARTITION_BY (y,m))")
        for path in Path(scratch).glob("y=*/m=*"):
            year, month = int(path.parent.name[2:]), int(path.name[2:])
            target = features_root / f"year={year}" / f"month={month:02d}.parquet"
            frame = pd.read_parquet(target)
            cap = pd.read_parquet(path, columns=["day", "ticker", "cap"])
            cap.index = pd.MultiIndex.from_arrays([pd.to_datetime(cap.day), cap.ticker])
            keys = pd.MultiIndex.from_arrays([pd.to_datetime(frame.date).dt.normalize(), frame.ticker])
            values = cap.cap.reindex(keys).to_numpy()
            fill = frame.market_cap_estimated.isna() & pd.notna(values)
            if fill.any():
                frame.loc[fill, "market_cap_estimated"] = values[fill.to_numpy()]
                write_atomic_parquet(frame, target)
                total += int(fill.sum())
    print(f"Market Cap: {total:,} pipeline estimates added to daily_features.", flush=True)


def update_market_breadth(data, start, end, workers):
    project = data / "market-breath"
    script = project / "tools" / "market_breadth.py"
    if not script.is_file():
        return
    args = [sys.executable, str(script), "update", "--workers", str(workers)]
    if start is not None and end is not None:
        args.extend(["--start", start.isoformat(), "--end", end.isoformat()])
    subprocess.run(args, cwd=project, check=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["build", "update"])
    parser.add_argument("--data", type=Path, default=ROOT / "data")
    parser.add_argument("--work", type=Path, default=LOCAL_STATE / "data_pipeline_work")
    parser.add_argument("--start", type=date.fromisoformat)
    parser.add_argument("--end", type=date.fromisoformat)
    parser.add_argument("--workers", type=int, default=8)
    parser.add_argument("--offline", action="store_true", help="Build features using local Daily and splits")
    parser.add_argument("--market-cap", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--skip-market-cap", action="store_true", help="Skip the historical Market Cap stage")
    parser.add_argument("--snapshot-archive", type=Path, help="Reuse a Massive snapshot SQLite cache for Market Cap")
    args = parser.parse_args()
    data, work = args.data.resolve(), args.work.resolve()
    if work == ROOT or work.is_relative_to(data) or args.work.resolve() == data:
        parser.error("--work must be a separate folder outside the data root")
    if args.workers < 1:
        parser.error("--workers must be positive")
    history_start = args.start or date(2016, 1, 1)
    end = args.end or datetime.now(ZoneInfo("America/New_York")).date()
    if history_start > end:
        parser.error("--start must be on or before --end")
    if not args.offline:
        credentials = ["MASSIVE_S3_ACCESS_KEY", "MASSIVE_S3_SECRET_KEY", "MASSIVE_API_KEY"]
        if missing := [name for name in credentials if not os.environ.get(name)]:
            parser.error("Missing environment variables: " + ", ".join(missing))
    include_cap = not (args.offline or args.skip_market_cap)
    if args.snapshot_archive and not include_cap:
        parser.error("--snapshot-archive requires the Market Cap stage")

    work.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(work / "run-lock.sqlite", timeout=0)) as lock:
        lock.execute("BEGIN EXCLUSIVE")
        scope = work / "data-root.json"
        if scope.exists() and json.loads(scope.read_text()) != str(data):
            parser.error("--work is already assigned to another data root")
        if not scope.exists():
            save_json(scope, str(data))
        start = history_start
        pending = work / "market-cap-pending.json"
        if not args.offline:
            existing = partitions(data / "daily")
            if args.mode == "update" and args.start is None and existing:
                for last in reversed(existing):
                    latest = pd.read_parquet(last, columns=["date"]).date.max()
                    if pd.notna(latest):
                        start = pd.Timestamp(latest).date() + timedelta(days=1)
                        break
            if include_cap and pending.exists():
                start = min(start, date.fromisoformat(json.loads(pending.read_text())))
            if include_cap and start <= end:
                save_json(pending, start.isoformat())
            if start <= end:
                update_daily(data, work, start, end, args.workers)
            # Fetch the entire split register so corrections to older events are included.
            update_splits(data, work, end, min(date(2016, 1, 1), history_start))
        build_features(data, work)
        if include_cap and start <= end:
            staging = work / "market_cap"
            mode = "update" if (staging / "scope.json").is_file() else "rebuild"
            cap = [sys.executable, str(ROOT / "tools/historical_market_cap/pipeline.py"),
                   mode, "--data", str(data), "--work", str(staging), "--workers", str(args.workers)]
            if args.snapshot_archive:
                cap.extend(["--snapshot-archive", str(args.snapshot_archive.resolve(strict=True))])
            subprocess.run(cap, cwd=ROOT, check=True)
            publish_market_cap(data, staging, start, end)
            pending.unlink(missing_ok=True)
        if not args.offline:
            update_market_breadth(data, args.start, args.end, args.workers)


if __name__ == "__main__":
    main()

