#!/usr/bin/env python3
"""Download Massive Stocks Day Aggregates to monthly Parquet files.

Source: s3://flatfiles/us_stocks_sip/day_aggs_v1/YYYY/MM/YYYY-MM-DD.csv.gz
Prices are stored on the unadjusted basis published by Massive.
"""

import argparse
import gzip
import os
import re
from collections import defaultdict
from datetime import date
from pathlib import Path

import boto3
import pandas as pd
from botocore.config import Config

BUCKET = "flatfiles"
PREFIX = "us_stocks_sip/day_aggs_v1/"
FILE_RE = re.compile(r"^us_stocks_sip/day_aggs_v1/(\d{4})/(\d{2})/(\d{4}-\d{2}-\d{2})\.csv\.gz$")
COLUMNS = ["date", "ticker", "open", "high", "low", "close", "volume", "vwap", "transactions"]


def client():
    access = os.getenv("MASSIVE_S3_ACCESS_KEY")
    secret = os.getenv("MASSIVE_S3_SECRET_KEY")
    if not access or not secret:
        raise SystemExit("Set MASSIVE_S3_ACCESS_KEY and MASSIVE_S3_SECRET_KEY to the Flat Files credentials.")
    return boto3.client(
        "s3", endpoint_url="https://files.massive.com",
        aws_access_key_id=access, aws_secret_access_key=secret,
        config=Config(signature_version="s3v4", retries={"max_attempts": 8, "mode": "standard"}),
    )


def list_files(s3, start, end):
    groups = defaultdict(list)
    for year in range(start.year, end.year + 1):
        pages = s3.get_paginator("list_objects_v2").paginate(
            Bucket=BUCKET, Prefix=f"{PREFIX}{year}/"
        )
        for page in pages:
            for obj in page.get("Contents", []):
                match = FILE_RE.fullmatch(obj["Key"])
                if not match:
                    continue
                y, m, day = match.groups()
                if y != day[:4] or m != day[5:7]:
                    continue
                if start.isoformat() <= day <= end.isoformat():
                    groups[(int(y), int(m))].append((day, obj["Key"]))
    for group in groups.values():
        group.sort()
    return dict(sorted(groups.items()))


def month_frame(s3, objects):
    frames = []
    for day, key in objects:
        response = s3.get_object(Bucket=BUCKET, Key=key)
        try:
            with gzip.GzipFile(fileobj=response["Body"]) as stream:
                frame = pd.read_csv(stream)
        finally:
            response["Body"].close()
        needed = {"ticker", "open", "high", "low", "close", "volume"}
        missing = needed - set(frame.columns)
        if missing:
            raise ValueError(f"Missing columns in {key}: {sorted(missing)}")
        frame["date"] = pd.Timestamp(day)
        for optional in ("vwap", "transactions"):
            if optional not in frame.columns:
                frame[optional] = float("nan")
        frames.append(frame[COLUMNS])
    result = pd.concat(frames, ignore_index=True)
    if result.duplicated(["date", "ticker"]).any():
        raise ValueError("Duplicate (date, ticker) rows in the monthly input.")
    result.sort_values(["date", "ticker"], inplace=True, ignore_index=True)
    return result


def main():
    parser = argparse.ArgumentParser(description="Convert Massive Day Aggregates to monthly Parquet")
    parser.add_argument("--start", type=date.fromisoformat, default=date(2016, 1, 1))
    parser.add_argument("--end", type=date.fromisoformat, default=date.today())
    parser.add_argument("--out", type=Path, default=Path("data/daily"))
    parser.add_argument("--refresh", action="store_true", help="Regenerate existing months")
    args = parser.parse_args()
    if args.start > args.end:
        parser.error("--start must be on or before --end")
    s3 = client()
    groups = list_files(s3, args.start, args.end)
    if not groups:
        raise SystemExit("No files were found for the requested period.")
    current_month = (args.end.year, args.end.month)
    print(f"Found {sum(map(len, groups.values()))} daily files in {len(groups)} months")
    for (year, month), objects in groups.items():
        target = args.out / f"year={year}" / f"month={month:02d}.parquet"
        # Rebuild the final month because it may contain new or partial data.
        if target.exists() and not args.refresh and (year, month) != current_month:
            print(f"SKIP {year}-{month:02d} (already exists)")
            continue
        print(f"{year}-{month:02d}: {len(objects)} sessions...", flush=True)
        frame = month_frame(s3, objects)
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = target.with_name(target.name + ".tmp")
        try:
            frame.to_parquet(temp, engine="pyarrow", compression="zstd", index=False)
            temp.replace(target)
        finally:
            temp.unlink(missing_ok=True)
        print(f"  {len(frame):,} rows -> {target}")
    print("Complete.")


if __name__ == "__main__":
    main()
