"""Download the Massive split register without changing OHLCV data.

Dependencies: pip install requests pandas pyarrow
Set the MASSIVE_API_KEY environment variable.
"""

import argparse
import json
import os
import time
from datetime import date
from pathlib import Path

import pandas as pd
import requests

URL = "https://api.massive.com/stocks/v1/splits"
FIELDS = ["id", "ticker", "execution_date", "split_from", "split_to", "adjustment_type", "historical_adjustment_factor"]


def get_page(session: requests.Session, url: str, params: dict | None) -> dict:
    for attempt in range(8):
        try:
            response = session.get(url, params=params, timeout=45)
            if response.status_code == 429 or 500 <= response.status_code < 600:
                if attempt == 7:
                    response.raise_for_status()
                retry_after = response.headers.get("Retry-After", "")
                try:
                    delay = min(60.0, float(retry_after))
                except ValueError:
                    delay = min(30.0, 2 ** attempt)
                time.sleep(max(1.0, delay))
                continue
            response.raise_for_status()
            data = response.json()
            if data.get("status") != "OK" or not isinstance(data.get("results", []), list):
                raise ValueError(f"Unexpected API response: {str(data)[:300]}")
            return data
        except (requests.Timeout, requests.ConnectionError):
            if attempt == 7:
                raise
            time.sleep(min(30, 2 ** attempt))
    raise RuntimeError("Retry limit reached")


def main() -> None:
    p = argparse.ArgumentParser(description="Download and validate historical Massive splits")
    p.add_argument("--start", default="2016-01-01", help="First effective date (YYYY-MM-DD)")
    p.add_argument("--end", default=date.today().isoformat(), help="Last effective date (YYYY-MM-DD)")
    p.add_argument("--output", type=Path, default=Path("data/metadata/splits.parquet"))
    args = p.parse_args()

    if date.fromisoformat(args.start) > date.fromisoformat(args.end):
        p.error("--start must be on or before --end")
    api_key = os.environ.get("MASSIVE_API_KEY", "").strip()
    if not api_key:
        p.error("Set the MASSIVE_API_KEY environment variable")

    rows = []
    pages = 0
    with requests.Session() as session:
        session.headers.update({"Authorization": f"Bearer {api_key}"})
        url, params = URL, {
            "execution_date.gte": args.start,
            "execution_date.lte": args.end,
            "sort": "execution_date.asc",
            "limit": 5000,
        }
        seen_urls = set()
        while url:
            if url in seen_urls:
                raise RuntimeError("Detected a pagination loop")
            seen_urls.add(url)
            data = get_page(session, url, params)
            rows.extend(data.get("results", []))
            pages += 1
            print(f"Page {pages}: {len(rows):,} events so far", flush=True)
            url, params = data.get("next_url"), None

    if not rows:
        raise RuntimeError("The query returned no splits. The existing file was preserved.")
    df = pd.DataFrame(rows).reindex(columns=FIELDS)
    mandatory = ["ticker", "execution_date", "split_from", "split_to", "adjustment_type"]
    if df[mandatory].isna().any().any():
        raise RuntimeError("Split events contain missing required fields")
    df["execution_date"] = pd.to_datetime(df["execution_date"], format="%Y-%m-%d", errors="raise")
    for col in ("split_from", "split_to"):
        df[col] = pd.to_numeric(df[col], errors="raise")
        if not (df[col] > 0).all():
            raise RuntimeError(f"Non-positive ratios in {col}")
    df["historical_adjustment_factor"] = pd.to_numeric(df["historical_adjustment_factor"], errors="coerce")
    if not df["execution_date"].between(pd.Timestamp(args.start), pd.Timestamp(args.end)).all():
        raise RuntimeError("The API returned splits outside the requested interval")
    if (~df["adjustment_type"].isin(["forward_split", "reverse_split", "stock_dividend"])).any():
        raise RuntimeError("Unknown corporate action type")
    if df["id"].notna().all():
        duplicate_count = int(df.duplicated(subset=["id"]).sum())
    else:
        duplicate_count = int(df.duplicated(subset=mandatory).sum())
    if duplicate_count:
        raise RuntimeError(f"{duplicate_count} duplicate events require review")

    df = df.sort_values(["execution_date", "ticker"], kind="stable").reset_index(drop=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    tmp = args.output.with_name(args.output.name + ".tmp")
    try:
        df.to_parquet(tmp, index=False, compression="zstd")
        os.replace(tmp, args.output)
    finally:
        tmp.unlink(missing_ok=True)

    audit = {
        "start": args.start,
        "end": args.end,
        "pages": pages,
        "events": len(df),
        "distinct_tickers": int(df["ticker"].nunique()),
        "by_type": {str(k): int(v) for k, v in df["adjustment_type"].value_counts().items()},
        "missing_historical_adjustment_factor": int(df["historical_adjustment_factor"].isna().sum()),
        "duplicates": duplicate_count,
        "first_execution_date": df["execution_date"].min().date().isoformat(),
        "last_execution_date": df["execution_date"].max().date().isoformat(),
    }
    audit_path = args.output.with_suffix(".audit.json")
    audit_path.write_text(json.dumps(audit, indent=2, ensure_ascii=False), encoding="utf-8")
    print(f"\nSaved: {args.output}\nAudit: {audit_path}\n{json.dumps(audit, indent=2, ensure_ascii=False)}")


if __name__ == "__main__":
    main()
