#!/usr/bin/env python3
"""Filter monthly Massive Parquet files to CS and ADRC using historical listings.

Cache daily REST snapshots to resume without repeating requests.
Els valors sense tipus / ticker no localitzat queden a l'auditoria, no al resultat.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import csv
import json
import os
import random
import time
from pathlib import Path
from urllib.parse import urlsplit

import pandas as pd
import requests

BASE = 'https://api.massive.com/v3/reference/tickers'
ALLOWED = {'CS', 'ADRC'}


def get_json(session, url, params=None):
    for attempt in range(9):
        try:
            r = session.get(url, params=params, timeout=60)
            if r.status_code == 429 or r.status_code >= 500:
                raise requests.HTTPError(f'HTTP {r.status_code}', response=r)
            r.raise_for_status()
            payload = r.json()
            if payload.get('status') == 'ERROR':
                raise ValueError(str(payload))
            return payload
        except (requests.RequestException, ValueError) as exc:
            if attempt == 8:
                raise RuntimeError(f'Error descarregant {url}: {exc}') from exc
            wait = min(60, 2**attempt) + random.random()
            retry_after = getattr(getattr(exc, 'response', None), 'headers', {}).get('Retry-After')
            if retry_after and retry_after.isdigit():
                wait = max(wait, min(120, int(retry_after)))
            time.sleep(wait)
    raise AssertionError('Unreachable')


def ticker_types(session, day, cache_dir):
    target = cache_dir / f'{day[:4]}' / f'{day}.json'
    if target.exists():
        obj = json.loads(target.read_text('utf-8'))
        if obj.get('date') != day or not isinstance(obj.get('types'), dict):
            raise ValueError(f'Invalid cache: {target}')
        return obj['types']

    # Request all types because historical records can omit the type.
    # Active status refers to the requested date, including stocks delisted later.
    params = {'market': 'stocks', 'date': day, 'active': 'true', 'limit': 1000, 'sort': 'ticker'}
    url = BASE
    seen_pages = set()
    found = {}
    while url:
        if url in seen_pages:
            raise RuntimeError(f'Pagination loop: {day}')
        seen_pages.add(url)
        data = get_json(session, url, params=params if url == BASE else None)
        for item in data.get('results') or []:
            ticker = item.get('ticker')
            if not ticker:
                continue
            typ = item.get('type') or ''
            if ticker in found and found[ticker] != typ:
                raise ValueError(f'Tipus contradictori {ticker}, {day}')
            found[ticker] = typ
        url = data.get('next_url')
        if url and urlsplit(url).hostname not in {'api.massive.com', 'api.polygon.io'}:
            raise ValueError(f'Unexpected pagination host: {url}')
        params = None
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_suffix('.json.tmp')
    try:
        temp.write_text(json.dumps({'date': day, 'types': found}, ensure_ascii=False), encoding='utf-8')
        temp.replace(target)
    finally:
        temp.unlink(missing_ok=True)
    return found


def write_atomic_parquet(frame, target):
    target.parent.mkdir(parents=True, exist_ok=True)
    temp = target.with_name(target.name + '.tmp')
    try:
        frame.to_parquet(temp, index=False, engine='pyarrow', compression='zstd')
        temp.replace(target)
    finally:
        temp.unlink(missing_ok=True)


def process_month(session, source, target, cache, audit_path, unknown_path, refresh, workers):
    if target.exists() and not refresh:
        print(f'SKIP {target} (ja existeix; usa --refresh per recalcular)', flush=True)
        return
    frame = pd.read_parquet(source)
    needed = {'date', 'ticker'}
    if not needed.issubset(frame.columns):
        raise ValueError(f'{source}: missing columns {needed - set(frame.columns)}')
    if frame.duplicated(['date','ticker']).any():
        raise ValueError(f'{source}: hi ha (date,ticker) duplicats')
    dates = pd.to_datetime(frame['date'], utc=True, errors='raise').dt.strftime('%Y-%m-%d')
    if dates.isna().any():
        raise ValueError(f'{source}: dates nul·les')
    # Classify each ticker using the listing data for its session.
    kinds = pd.Series(index=frame.index, dtype='object')
    days = sorted(dates.unique())
    def load_day(day):
        # Give each worker its own HTTP session.
        with requests.Session() as worker_session:
            worker_session.headers.update(session.headers)
            return day, ticker_types(worker_session, day, cache)

    with ThreadPoolExecutor(max_workers=workers) as executor:
        futures = {executor.submit(load_day, day): day for day in days}
        types_by_day = {}
        for future in as_completed(futures):
            day, types = future.result()
            types_by_day[day] = types
            print(f'  Metadades {day} ({len(types):,} tickers)', flush=True)
    for day in days:
        mask = dates == day
        kinds.loc[mask] = frame.loc[mask, 'ticker'].map(types_by_day[day]).fillna('')
    keep = kinds.isin(ALLOWED)
    unknown = kinds.eq('')
    kept = frame.loc[keep].copy()
    if len(kept) + int((~keep).sum()) != len(frame):
        raise AssertionError('Error de recompte')
    # Write diagnostics before publishing the partition. Use --refresh to retry a failed write.
    audit_path.parent.mkdir(parents=True, exist_ok=True)
    unknown_path.parent.mkdir(parents=True, exist_ok=True)
    unknown_rows = frame.loc[unknown, ['date','ticker']].copy()
    unknown_rows['motiu'] = 'missing type or absent from historical listings'
    write_atomic_parquet(unknown_rows, unknown_path)
    write_atomic_parquet(kept, target)
    stats = {'file': str(source), 'rows_input': len(frame), 'rows_cs': int((kinds == 'CS').sum()),
             'rows_adrc': int((kinds == 'ADRC').sum()), 'rows_other': int((~keep & ~unknown).sum()),
             'rows_unknown': int(unknown.sum()), 'rows_output': len(kept)}
    with audit_path.open('a', newline='', encoding='utf-8') as f:
        writer = csv.DictWriter(f, fieldnames=list(stats))
        if f.tell() == 0:
            writer.writeheader()
        writer.writerow(stats)
    print(f"{source.name}: {len(frame):,} -> {len(kept):,} CS/ADRC; unknown={int(unknown.sum()):,}", flush=True)


def main():
    p = argparse.ArgumentParser(description='Filter Massive daily Parquet using historical CS and ADRC listings')
    p.add_argument('--input', type=Path, default=Path('data/daily'))
    p.add_argument('--output', type=Path, default=Path('data/daily_cs_adrc'))
    p.add_argument('--metadata', type=Path, default=Path('data/metadata/massive_tickers_daily'))
    p.add_argument('--refresh', action='store_true')
    p.add_argument('--workers', type=int, default=8, help='Concurrent sessions (default: 8)')
    p.add_argument('--year', type=int, help='Process one year')
    p.add_argument('--month', type=int, choices=range(1,13), metavar='1..12', help='Process one month together with --year')
    args = p.parse_args()
    if not (1 <= args.workers <= 16):
        p.error('--workers must be between 1 and 16')
    if args.month and not args.year:
        p.error('--month requires --year')
    if args.input.resolve() == args.output.resolve():
        p.error('Input and output paths must differ')
    key = os.environ.get('MASSIVE_API_KEY')
    if not key:
        p.error('Set MASSIVE_API_KEY to your REST API key')
    sources = sorted(args.input.glob('year=*/month=*.parquet'))
    if args.year:
        sources = [s for s in sources if s.parent.name == f'year={args.year}']
    if args.month:
        sources = [s for s in sources if s.name == f'month={args.month:02d}.parquet']
    if not sources:
        p.error('No monthly Parquet files were found in the input directory')
    session = requests.Session()
    session.headers.update({'Authorization': f'Bearer {key}', 'User-Agent': 'massive-cs-adrc-filter/1.0'})
    audit = args.output / 'audit.csv'
    for src in sources:
        dst = args.output / src.parent.name / src.name
        unknown = args.output / 'unknown' / src.parent.name / src.name
        process_month(session, src, dst, args.metadata, audit, unknown, args.refresh, args.workers)
    print('Complete. Source files were preserved.')


if __name__ == '__main__':
    main()

