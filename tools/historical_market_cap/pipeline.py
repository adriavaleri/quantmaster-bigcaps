"""Canonical BigCaps historical market cap rebuild, incremental update and validation."""
from __future__ import annotations

import argparse
from contextlib import closing, contextmanager
from datetime import datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import sqlite3

import duckdb
import pandas as pd

import sec_evidence as sec
import split_basis as basis
import daily_estimates as pilot
from snapshot_cache import (
    SnapshotCache, ensure_plan_cached, normalize_snapshot_batch, write_part,
)

ROOT = Path(__file__).resolve().parents[2]
LOCAL_STATE = ROOT.with_name(f"{ROOT.name}.local")
STATE = LOCAL_STATE / "market_cap_work"
SHARDS = 32
ISSUANCE_EVIDENCE = Path(__file__).with_name("sec_issuance_evidence.csv")
# This release produced the same raw and corrected rows before signatures were split.
COMBINED_SIGNATURE_VERSION = "7dbab04017b92677896323f8d5381c21e4eb5f5f792bdda2e98642e2039fafc6"


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, default=str).encode()).hexdigest()


def stage_code(version, paths, equivalent):
    hashes = [hashlib.sha256(path.read_text(encoding="utf-8").encode()).hexdigest() for path in paths]
    signature = digest([version, *hashes])
    return equivalent.get(signature, signature)


def quoted(path):
    return str(path).replace("\\", "/").replace("'", "''")


def write_json(path, value):
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(value, default=str, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {}


@contextmanager
def workspace_lock(work):
    with closing(sqlite3.connect(work / "run-lock.sqlite", timeout=0)) as lock:
        try:
            lock.execute("BEGIN EXCLUSIVE")
        except sqlite3.OperationalError as exc:
            raise SystemExit(f"Workspace already in use: {work}") from exc
        yield


def key():
    value = os.environ.get("MASSIVE_API_KEY", "").strip()
    if value:
        return value
    path = LOCAL_STATE / "keys.env"
    if path.exists():
        for line in path.read_text(encoding="utf-8-sig").splitlines():
            if line.startswith("MASSIVE_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""


def daily_fingerprints(con, scope, cutoff=None):
    where = "WHERE session <= ?::DATE" if cutoff else ""
    return con.execute(f"""
        SELECT ticker, count(*) AS sessions, min(session) AS first_day,
               max(session) AS last_day,
               bit_xor(hash(session, close)) AS prices_hash,
               count(DISTINCT session) AS distinct_days
        FROM source {scope} {where} GROUP BY ticker ORDER BY ticker
    """, [cutoff] if cutoff else []).df()


def fingerprint(frame):
    columns = ["ticker", "sessions", "first_day", "last_day", "prices_hash", "distinct_days"]
    return digest(frame[columns].sort_values("ticker").to_dict("records"))


def define_inputs(con, data, selected):
    daily = quoted(data / "daily/year=*/month=*.parquet")
    con.execute(f"CREATE VIEW source AS SELECT date::DATE AS session, ticker, close FROM read_parquet('{daily}')")
    con.register("requested", pd.DataFrame({"ticker": pd.Series(selected, dtype="string")}))
    scope = "JOIN requested USING (ticker)" if selected else ""
    meta = daily_fingerprints(con, scope)
    if meta.empty or (meta.sessions != meta.distinct_days).any():
        raise ValueError("Daily source is empty or contains duplicate ticker-date keys")
    if selected and set(selected) != set(meta.ticker):
        raise ValueError(f"Tickers missing from Daily: {sorted(set(selected) - set(meta.ticker))}")
    con.register("scope", meta[["ticker"]])
    plan = con.sql("""
        SELECT ticker, min(session)::VARCHAR AS snapshot_date
        FROM source JOIN scope USING (ticker)
        GROUP BY ticker, date_trunc('month', session) ORDER BY ticker, snapshot_date
    """).df()
    return daily, meta, plan


def import_archive(cache, path):
    if path is None:
        return
    with path.open("rb") as source:
        checksum = hashlib.file_digest(source, "sha256").hexdigest()
    receipt = cache.conn.execute("SELECT value FROM metadata WHERE key='archive_import'").fetchone()
    if receipt:
        if receipt[0] != checksum:
            raise ValueError("Different original archive. Use a fresh workspace to preserve provenance.")
        return
    if cache.conn.execute("SELECT 1 FROM snapshots LIMIT 1").fetchone():
        raise ValueError("Import original snapshots into an empty workspace")
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as archive:
        rows = archive.execute("SELECT * FROM snapshots WHERE http_status=404 OR (http_status=200 AND fetch_error IS NULL)")
        with cache.conn:
            cache.conn.executemany(cache.insert_sql, rows)
            cache.conn.execute("INSERT INTO metadata VALUES ('archive_import', ?)", (checksum,))
            cache.conn.execute("INSERT INTO metadata VALUES ('archive_path', ?)", (str(path),))
            cache.conn.execute("CREATE TABLE IF NOT EXISTS original_snapshots (ticker TEXT, snapshot_date TEXT)")
            cache.conn.execute("INSERT INTO original_snapshots SELECT ticker, snapshot_date FROM snapshots")
            cache.conn.execute("CREATE UNIQUE INDEX original_snapshot_key ON original_snapshots(ticker,snapshot_date)")


def append_events(path, events, date_column, cutoff):
    try:
        old = pd.read_csv(path, dtype=str)
    except pd.errors.EmptyDataError:
        old = pd.DataFrame()
    new = events if events.empty else events[events[date_column].gt(cutoff)]
    if not old.empty:
        old = old[old[date_column].le(cutoff)]
    return pd.concat([old, new], ignore_index=True)


def build_raw(con, work, meta, plan, splits, daily, args, code, compatible_code, previous):
    raw_dir = work / "raw"
    snap_dir = work / "snapshots"
    raw_dir.mkdir(exist_ok=True)
    snap_dir.mkdir(exist_ok=True)
    meta["shard"] = meta.ticker.map(lambda t: hashlib.sha256(t.encode()).digest()[0] % SHARDS)
    signs, changed, tails = {}, 0, 0
    groups = list(meta.groupby("shard"))
    cutoff = previous.get("last_session") if args.mode == "update" else None
    prefix = daily_fingerprints(con, "JOIN scope USING (ticker)", cutoff) if cutoff else None
    last_session = str(meta.last_day.max().date())
    with closing(SnapshotCache(work / "snapshots.sqlite")) as cache:
        import_archive(cache, args.snapshot_archive)
        cache.conn.execute("CREATE TABLE IF NOT EXISTS original_snapshots (ticker TEXT, snapshot_date TEXT)")
        if args.max_new_snapshots is not None:
            pending = 0
            for _, group in groups:
                names = group.ticker.tolist()
                known = cache.records_for_tickers(names)
                pending += sum(not cache.complete(*known.get((r.ticker, r.snapshot_date), (None, None)))
                               for r in plan[plan.ticker.isin(names)].itertuples(index=False))
            if pending > args.max_new_snapshots:
                raise ValueError(f"{pending} snapshots pending, above --max-new-snapshots={args.max_new_snapshots}")
        for index, group in groups:
            name = f"part-{index:02d}"
            names = group.ticker.tolist()
            actions = splits[splits.ticker.isin(names)]
            shard_plan = plan[plan.ticker.isin(names)]
            actions_hash = digest(actions.to_dict("records"))
            group_hash = fingerprint(group)
            signs[name] = digest([code, group_hash, actions_hash])
            raw_path, snap_path = raw_dir / f"{name}.parquet", snap_dir / f"{name}.parquet"
            checkpoint = raw_dir / f"{name}.json"
            old = read_json(checkpoint)
            if (raw_path.exists() and snap_path.exists()
                    and old.get("code") in compatible_code
                    and old.get("daily_fingerprint") == group_hash
                    and old.get("actions_hash") == actions_hash):
                signs[name] = old["signature"]
                continue
            _, statuses = ensure_plan_cached(shard_plan, names, cache, args.workers, key())
            if set(statuses) - {"200", "404"}:
                raise RuntimeError("Incomplete Massive requests. Correct the API error and rerun to resume.")
            snapshots = normalize_snapshot_batch(cache.snapshots_for_tickers(names), shard_plan)
            records = cache.records_for_tickers(names)
            if len(snapshots) != len(shard_plan) or any(
                not cache.complete(*records.get((r.ticker, r.snapshot_date), (None, None)))
                for r in shard_plan.itertuples(index=False)
            ):
                raise RuntimeError("Snapshot plan and cache differ")
            original = pd.read_sql_query(
                f"SELECT ticker,snapshot_date FROM original_snapshots WHERE ticker IN ({','.join('?' for _ in names)})",
                cache.conn, params=names,
            )
            restored_keys = set(original.itertuples(index=False, name=None))
            snapshots["snapshot_origin"] = [
                "imported_archive" if (ticker, day) in restored_keys else "massive_historical_refetch"
                for ticker, day in snapshots[["ticker", "snapshot_date"]].itertuples(index=False, name=None)
            ]
            selection = group[["ticker"]]
            calculation_snapshots = snapshots
            append_from = None
            if (cutoff and raw_path.exists() and old.get("code") in compatible_code
                and old.get("last_session") == cutoff
                and old.get("actions_hash") in {
                    actions_hash, digest(actions[actions.execution_date.le(pd.Timestamp(cutoff))].to_dict("records")),
                }
                and old.get("daily_fingerprint") == fingerprint(prefix[prefix.ticker.isin(names)])):
                # Warm up from the last completed observation no later than the
                # cutoff. Every terminal response resets or clears carried shares.
                warmup = shard_plan[shard_plan.snapshot_date.le(cutoff)].groupby("ticker").snapshot_date.max()
                selection = group.loc[group.last_day.gt(pd.Timestamp(cutoff)), ["ticker"]].copy()
                if not selection.empty:
                    append_from = cutoff
                    first_snapshot = shard_plan.groupby("ticker").snapshot_date.min()
                    selection["warmup_date"] = selection.ticker.map(warmup).fillna(
                        selection.ticker.map(first_snapshot)
                    )
                    warmup_dates = snapshots.ticker.map(selection.set_index("ticker").warmup_date)
                    calculation_snapshots = snapshots[warmup_dates.notna() & snapshots.snapshot_date.ge(warmup_dates)]
            raw, identity, split_events = pilot.make_daily_estimates(
                con, selection, calculation_snapshots, actions, daily_src=daily,
            )
            if append_from:
                existing = pd.read_parquet(raw_path)
                raw = pd.concat([existing[existing.date.le(append_from)], raw[raw.date.gt(append_from)]],
                                ignore_index=True)
                identity = append_events(raw_dir / f"{name}-identity.csv", identity, "snapshot_date", append_from)
                split_events = append_events(raw_dir / f"{name}-splits.csv", split_events, "blocked_from_date", append_from)
                tails += 1
            if len(raw) != group.sessions.sum() or raw.duplicated(["ticker", "date"]).any():
                raise RuntimeError(f"Invalid daily keys in {name}")
            write_part(raw, raw_path, daily=True)
            write_part(snapshots, snap_path)
            identity.to_csv(raw_dir / f"{name}-identity.csv", index=False)
            split_events.to_csv(raw_dir / f"{name}-splits.csv", index=False)
            write_json(checkpoint, {
                "signature": signs[name], "rows": len(raw), "snapshots": len(snapshots),
                "daily_fingerprint": group_hash, "actions_hash": actions_hash, "code": code,
                "last_session": last_session, "append_from": append_from,
                "parent_signature": old.get("signature") if append_from else None,
            })
            changed += 1
        provenance = dict(cache.conn.execute("SELECT key,value FROM metadata"))
    return signs, changed, tails, provenance


def sec_reference(work, data, meta, names, args, refresh_tickers=None):
    if args.sec_pit:
        return pd.read_parquet(args.sec_pit)
    if not names:
        return pd.DataFrame()
    sec.RAW = work / "sec_raw"
    archive = args.snapshot_archive
    if archive is None:
        archive_path = read_json(work / "manifest.json").get("original_snapshot_archive", {}).get("archive_path")
        archive = Path(archive_path) if archive_path else None
        if archive == ROOT / "market_cap_work/full/snapshots.sqlite" and not archive.is_file():
            archive = STATE / "full/snapshots.sqlite"
    archived_sec = archive.parent / "sec_raw" if archive else None
    sec.PRIOR_RAW = archived_sec if archived_sec and archived_sec.is_dir() else work / "sec_prior"
    sec.ROOT = data.parent
    sec.START = meta.first_day.min().date()
    sec.END = meta.last_day.max().date()
    sec.DAILY_GLOB = quoted(work / "raw/part-*.parquet")
    sec.SNAPSHOT_GLOB = quoted(work / "snapshots/part-*.parquet")
    sec.IDENTITY_MAP_PATH = args.identity_map or work / "no_imported_identity_map.parquet"
    selected = pd.DataFrame({"ticker": sorted(names)})
    inputs, _, aligned, _, _ = sec.load_daily_and_metadata(
        selected, splits_path=data / "metadata/splits.parquet",
    )
    ciks = sorted(set(inputs.identity_cik.dropna().astype(str)) | set(inputs.canonical_cik.dropna().astype(str)))
    if not ciks:
        return pd.DataFrame()
    recent = inputs.loc[pd.to_datetime(inputs.session_date) >= pd.Timestamp(sec.END - timedelta(days=120))]
    if refresh_tickers is not None:
        recent = recent[recent.ticker.isin(refresh_tickers)]
    latest_by_cik = {}
    for id_column in ["identity_cik", "canonical_cik"]:
        for cik, day in recent.dropna(subset=[id_column]).groupby(id_column).session_date.max().items():
            cutoff = datetime.combine(day, datetime.min.time(), timezone.utc).timestamp()
            latest_by_cik[str(cik)] = max(cutoff, latest_by_cik.get(str(cik), 0))
    client = sec.SecClient(refresh_from=latest_by_cik)
    facts = sec.fetch_sec_facts(ciks, client)
    calls = pd.DataFrame(client.requests)
    if not calls.empty:
        calls.to_csv(work / "sec_http_requests.csv", index=False)
        network = calls[~calls.cache_hit].drop_duplicates("url", keep="last")
        if (~network.http_status.isin([200, 404])).any():
            raise RuntimeError("Incomplete SEC requests. Retry to resume from the SEC cache.")
    write_part(facts, work / "sec_share_facts_raw.parquet")
    result = sec.reconstruct_daily(inputs, facts, aligned)
    return add_issuance_evidence(result, facts, pd.read_parquet(data / "metadata/splits.parquet"))


def add_issuance_evidence(reference, facts, splits):
    """Bridge a stale SEC count using documented common-stock issuance."""
    reference["issuance_shares_reference"] = float("nan")
    if facts.empty:
        return reference
    days = pd.to_datetime(reference.session_date)
    fact_days = pd.to_datetime(reference.shares_fact_end)
    ledger = pd.read_csv(ISSUANCE_EVIDENCE, dtype={"cik": str}, parse_dates=["first_session", "last_session"])
    for event in ledger.itertuples(index=False):
        # Require an independent filing that corroborates the enlarged share base.
        if not (facts.cik.eq(event.cik) & facts.accession.eq(event.corroborating_accession)
                & facts.shares.eq(event.corroborating_shares)
                & ~facts.scale_anomaly & ~facts.same_filing_conflict).any():
            continue
        rows = (reference.pit_status.eq("ok")
                & reference.canonical_cik.eq(event.cik)
                & reference.canonical_share_class_id.eq(event.share_class)
                & reference.shares_accession.eq(event.base_accession)
                & reference.shares_split_adjustment_factor.eq(1)
                & fact_days.lt(event.first_session)
                & days.between(event.first_session, event.last_session))
        # No bridge across splits, even where a split's mapping is unresolved.
        relevant = splits[splits.ticker.isin(reference.loc[rows, "ticker"])]
        for split in relevant.itertuples(index=False):
            day = pd.Timestamp(split.execution_date)
            rows &= ~(reference.ticker.eq(split.ticker) & fact_days.le(day) & days.ge(day))
        estimated = reference.shares_pit_sec + event.issued_shares
        rows &= (estimated / event.corroborating_shares - 1).abs().le(.02)
        if reference.loc[rows, "issuance_shares_reference"].notna().any():
            raise ValueError("Overlapping SEC issuance evidence for the same share class and session")
        reference.loc[rows, "issuance_shares_reference"] = estimated[rows]
    return reference


def input_versions(data):
    paths = sorted(data.glob("daily/year=*/month=*.parquet")) + [data / "metadata/splits.parquet"]
    return [(str(path), (stat := path.stat()).st_size, stat.st_mtime_ns) for path in paths]


def correction_evidence_signature(events, reference, cutoff=None):
    columns = ["ticker", "session_date", "shares_pit_sec"]
    if "issuance_shares_reference" in reference:
        columns.append("issuance_shares_reference")
    if not reference.empty:
        reference = reference.loc[reference.pit_status.eq("ok"), columns].copy()
        reference["session_date"] = pd.to_datetime(reference.session_date).dt.strftime("%Y-%m-%d")
        if cutoff:
            reference = reference[reference.session_date.le(cutoff)]
        reference = reference.sort_values(["ticker", "session_date"])
    sec_hash = pd.util.hash_pandas_object(reference, index=False).to_numpy().tobytes()
    return digest([events.to_dict("records"), hashlib.sha256(sec_hash).hexdigest()])


def build(args, work):
    if args.workers < 1 or (args.max_new_snapshots is not None and args.max_new_snapshots < 0):
        raise ValueError("Invalid worker count or snapshot limit")
    prior = read_json(work / "scope.json")
    for option in ("sec_pit", "identity_map"):
        value = getattr(args, option)
        if value is None and prior.get(option):
            setattr(args, option, Path(prior[option]))
        elif value is not None:
            setattr(args, option, value.resolve(strict=True))
    scope = {"data": str(args.data.resolve()),
             "tickers": sorted(set(args.tickers if args.tickers is not None else prior.get("tickers", [])))}
    scope.update({option: str(getattr(args, option)) for option in ("sec_pit", "identity_map")
                  if getattr(args, option) is not None})
    if prior and prior != scope:
        raise ValueError("Scope differs from the existing workspace. Select a separate --work directory.")
    if args.mode == "update" and not prior:
        raise ValueError("Run rebuild once to initialize this workspace.")
    write_json(work / "scope.json", scope)
    raw_files = [Path(pilot.__file__), Path(__file__).with_name("snapshot_cache.py")]
    # Preserve checkpoints from the equivalent modules that preceded the source cleanup.
    raw_code = stage_code("raw-estimates-v1", raw_files, {
        "d140070f5dac1f919a2919f6d1970c44eab06a895585f4edff4808234dc8dfc8":
            "205a642f99a046de498289a61a9c5b92f6de76235be84376b026bb7ef510e6dd",
    })
    sec_code = stage_code("sec-reference-v1", [Path(sec.__file__)], {
        "9da3849d403c49be84f20d6591d6eb057faef2bbf9ff3dbcde61978cfcecc08b":
            "fa0cbae9dfa0cddfd380a4502ff1266c6eb82947172254459736de7eb7f097d2",
    })
    correction_code = stage_code("split-correction-v1", [Path(basis.__file__)], {
        "5702f5cfc7ad4e8b95acb509f7c491a72db1cb64e23a7185bdc47d28f44a8778":
            "fb961bce9d83a5cc37f8fafc283f4cc631db02b7876c83efc3d710feed29bcfe",
    })
    compatible_raw_code = {raw_code}
    if raw_code == "205a642f99a046de498289a61a9c5b92f6de76235be84376b026bb7ef510e6dd":
        compatible_raw_code.add(COMBINED_SIGNATURE_VERSION)
    sec_paths = [args.sec_pit, args.identity_map]
    signature_inputs = [hashlib.sha256(p.read_bytes()).hexdigest() if p else None for p in [*sec_paths, ISSUANCE_EVIDENCE]]
    stage_versions = [raw_code, sec_code, correction_code, signature_inputs]
    source_versions = input_versions(args.data)
    prev = read_json(work / "manifest.json")
    if (args.mode == "update" and args.snapshot_archive is None and args.max_new_snapshots is None
            and prev.get("stage_versions") == stage_versions
            and prev.get("source_signature") == digest(source_versions)
            and not (work / "pending.json").exists()
            and prev.get("shard_signatures")
            and all((work / "corrected" / f"{shard}.parquet").is_file() for shard in prev["shard_signatures"])):
        print("Up to date. No new API queries or output writes.")
        return
    with closing(duckdb.connect()) as con:
        daily, meta, plan = define_inputs(con, args.data, scope["tickers"])
        splits = pd.read_parquet(args.data / "metadata/splits.parquet").sort_values(["ticker", "execution_date", "id"])
        if splits.id.duplicated().any():
            raise ValueError("Duplicate split IDs")
        # Shards never move between scopes; previously delisted tickers remain because their history remains.
        if set(prev.get("tickers", [])) - set(meta.ticker):
            raise ValueError("Source history lost tickers. Use a fresh workspace for a deliberate scope change.")
        if prev and str(meta.last_day.max().date()) < prev["last_session"]:
            raise ValueError("Source history moved backwards")
        pending_path = work / "pending.json"
        write_json(pending_path, {"started_at_utc": datetime.now(timezone.utc).isoformat()})
        signs, changed, tails, provenance = build_raw(
            con, work, meta, plan, splits, daily, args, raw_code, compatible_raw_code, prev,
        )
        signature = digest([signs, stage_versions])
        if prev.get("signature") == signature and all(
            (work / "corrected" / f"{shard}.parquet").exists() for shard in signs
        ):
            if input_versions(args.data) != source_versions:
                raise RuntimeError("Inputs changed during the run. Retry after ingestion.")
            pending_path.unlink()
            print("Up to date. No new API queries or output writes.")
            return
        active = splits[splits.ticker.isin(meta.ticker)]
        snapshots = con.sql(f"""
            SELECT * FROM read_parquet('{quoted(work / 'snapshots/part-*.parquet')}', union_by_name=true)
            JOIN scope USING(ticker)
        """).df()
        unknown = basis.load_event_evidence(con, splits=active, snapshots=snapshots,
                                            sec=pd.DataFrame(), daily_src=daily)
        # Across an explicit identity change, SEC can corroborate the old
        # security's 1x basis. The split factor itself remains unconfirmed.
        identity_change = (
            unknown.get("snapshot_identity_note", pd.Series(index=unknown.index, dtype=str))
            .isin({"cik_changed", "share_class_figi_changed"})
            & unknown.get("massive_shares_pre", pd.Series(index=unknown.index, dtype=float)).gt(0)
            & unknown.get("massive_shares_post", pd.Series(index=unknown.index, dtype=float)).gt(0)
        )
        candidates = unknown[unknown.basis_status.isin({
            "unknown_reexpressed_or_stale", "unknown_share_ratio", "unknown_non_split_share_change",
        }) | (unknown.basis_status.eq("unknown_identity_or_snapshot") & identity_change)]
        names = set(candidates.ticker)
        sec_path = work / "sec_split_reference.parquet"
        sec_epoch = digest([sec_code, sorted(names), signature_inputs])
        compatible_sec_epochs = {sec_epoch}
        if sec_code == "fa0cbae9dfa0cddfd380a4502ff1266c6eb82947172254459736de7eb7f097d2":
            compatible_sec_epochs.add(digest([COMBINED_SIGNATURE_VERSION, sorted(names), signature_inputs]))
        last_candidate = pd.to_datetime(candidates.execution_date).max() if names else pd.NaT
        previous_shards = prev.get("shard_signatures", {})
        tail_only = bool(previous_shards) and all(
            previous_shards.get(shard) == sig or (
                (checkpoint := read_json(work / "raw" / f"{shard}.json")).get("append_from") == prev["last_session"]
                and shard in previous_shards and checkpoint.get("parent_signature") == previous_shards[shard]
            ) for shard, sig in signs.items()
        )
        reuse_sec = (args.mode == "update" and prev.get("sec_epoch") in compatible_sec_epochs
                     and (not prev.get("sec_reference_rows") or sec_path.is_file())
                     and tail_only and (pd.isna(last_candidate)
                         or last_candidate + pd.Timedelta(days=120) <= pd.Timestamp(prev["last_session"])))
        if reuse_sec:
            reference = pd.read_parquet(sec_path) if sec_path.exists() else pd.DataFrame()
        else:
            refresh_tickers = None
            if tail_only:
                recent_cutoff = pd.Timestamp(prev["last_session"]) - pd.Timedelta(days=120)
                refresh_tickers = set(candidates.loc[pd.to_datetime(candidates.execution_date) >= recent_cutoff, "ticker"])
            reference = sec_reference(work, args.data, meta, names, args, refresh_tickers)
            if not reference.empty:
                write_part(reference, sec_path)
            else:
                sec_path.unlink(missing_ok=True)
        events = basis.load_event_evidence(con, splits=active, snapshots=snapshots,
                                           sec=reference, daily_src=daily)
        write_part(events, work / "split_evidence.parquet")
        out = work / "corrected"
        out.mkdir(exist_ok=True)
        corrected_tails = 0
        for shard, raw_signature in signs.items():
            raw_dir = work / "raw"
            raw_info = read_json(raw_dir / f"{shard}.json")
            raw = pd.read_parquet(raw_dir / f"{shard}.parquet")
            names = set(raw.ticker)
            shard_events = events[events.ticker.isin(names)]
            shard_sec = reference[reference.ticker.isin(names)] if not reference.empty else reference
            evidence_sig = correction_evidence_signature(shard_events, shard_sec)
            correction_sig = digest([correction_code, raw_signature, evidence_sig])
            path = out / f"{shard}.parquet"
            checkpoint = path.with_suffix(".json")
            old = read_json(checkpoint)
            if path.exists() and old.get("signature") == correction_sig:
                continue
            cutoff = raw_info.get("append_from")
            if (cutoff and path.exists() and old.get("code") == correction_code
                and old.get("raw_signature") == raw_info.get("parent_signature")
                and old.get("evidence_signature") == correction_evidence_signature(shard_events, shard_sec, cutoff)):
                existing = pd.read_parquet(path)
                tail = basis.correct_frame(raw[raw.date.gt(cutoff)].reset_index(drop=True), shard_events, shard_sec)
                corrected = pd.concat([existing[existing.date.le(cutoff)], tail], ignore_index=True)
                corrected_tails += 1
            else:
                corrected = basis.correct_frame(raw, shard_events, shard_sec)
            if len(corrected) != len(raw) or corrected.duplicated(["ticker", "date"]).any():
                raise RuntimeError(f"Invalid corrected keys in {shard}")
            write_part(corrected, path, daily=True)
            write_json(checkpoint, {"signature": correction_sig, "rows": len(corrected),
                                    "code": correction_code,
                                    "raw_signature": raw_signature, "evidence_signature": evidence_sig})
        if input_versions(args.data) != source_versions:
            raise RuntimeError("Daily or split inputs changed during the run. Rerun after ingestion is complete.")
        write_json(work / "manifest.json", {
            "signature": signature, "shard_signatures": signs, "is_pit": False, "tickers": meta.ticker.tolist(),
            "stage_versions": stage_versions, "source_signature": digest(source_versions),
            "first_session": str(meta.first_day.min().date()), "last_session": str(meta.last_day.max().date()),
            "rows": int(meta.sessions.sum()), "monthly_snapshots": len(plan),
            "snapshot_origins": snapshots.snapshot_origin.value_counts().to_dict(),
            "original_snapshot_archive": provenance, "updated_at_utc": datetime.now(timezone.utc).isoformat(),
            "sec_mode": "imported" if args.sec_pit else "reconstructed",
            "sec_epoch": sec_epoch, "sec_reference_reused": reuse_sec, "corrected_shards_appended": corrected_tails,
            "sec_reference_rows": len(reference), "raw_shards_changed": changed, "raw_shards_appended": tails,
        })
        pending_path.unlink()
        print(f"Staged {int(meta.sessions.sum()):,} rows, {len(plan):,} monthly snapshots, {changed} raw shards updated.")

def validate(args, work):
    manifest = read_json(work / "manifest.json")
    if not manifest or (work / "pending.json").exists():
        raise ValueError("Workspace has no completed run. Resume rebuild/update before validating.")
    current = quoted(args.data / "research/daily_features/year=*/month=*.parquet")
    corrected = quoted(work / "corrected/part-*.parquet")
    with closing(duckdb.connect()) as con:
        con.execute(f"""
            CREATE VIEW staged AS
            SELECT ticker, date::DATE AS day, market_cap_estimated_corrected AS rebuilt,
                   market_cap_estimated AS raw_estimate, market_cap_estimated_snapshot_date AS snapshot_date,
                   market_cap_estimated_pit AS pit, split_blocked,
                   split_basis_multiplier_corrected AS factor, market_cap_classification_status AS status,
                   split_basis_events_applied, split_basis_events_uncertain, split_basis_uncertainty_reason
            FROM read_parquet('{corrected}', union_by_name=true)
        """)
        keys, unique_keys, leaked_dates, pit, uncertain_caps = con.sql("""
            SELECT count(*), count(DISTINCT(ticker,day)),
                   count(*) FILTER(WHERE CAST(snapshot_date AS DATE)>day),
                   count(*) FILTER(WHERE pit),
                   count(*) FILTER(WHERE status='unknown_split_basis' AND rebuilt IS NOT NULL)
            FROM staged
        """).fetchone()
        if keys != manifest["rows"] or keys != unique_keys or leaked_dates or pit or uncertain_caps:
            raise ValueError("Staging integrity failed")
        con.execute(f"""
            CREATE VIEW comparison AS
            SELECT s.*, f.market_cap_estimated AS current_cap, f.ticker IS NOT NULL AS has_baseline
            FROM staged s LEFT JOIN read_parquet('{current}', union_by_name=true) f
              ON s.day = f.date::DATE AND s.ticker = f.ticker
        """)
        evidence = quoted(work / "split_evidence.parquet")
        if len(pd.read_parquet(work / "split_evidence.parquet", columns=["ticker"])):
            windows = con.sql(f"""
                SELECT e.ticker, e.event_id, cast(e.execution_date AS DATE) AS split_date,
                       e.share_multiplier, e.basis_status, c.day, c.current_cap, c.rebuilt, c.raw_estimate,
                       c.status, c.split_blocked, c.factor, c.split_basis_events_applied,
                       c.split_basis_uncertainty_reason
                FROM read_parquet('{evidence}') e JOIN comparison c ON c.ticker=e.ticker
                  AND c.day BETWEEN cast(e.execution_date AS DATE)-7 AND cast(e.execution_date AS DATE)+7
                ORDER BY e.ticker, split_date, c.day
            """).df()
            windows.to_csv(work / "validation_split_windows.csv", index=False)
        else:
            (work / "validation_split_windows.csv").unlink(missing_ok=True)
        details = con.sql("SELECT * FROM comparison").df() if len(manifest["tickers"]) <= 100 else None
        if details is not None:
            if len(details) != keys:
                raise ValueError("Duplicate ticker/date keys in the baseline")
            write_part(details, work / "validation_observations.parquet")
        if con.sql("SELECT count(*) FROM comparison").fetchone()[0] != keys:
            raise ValueError("Duplicate ticker/date keys in the baseline")
        grouped = con.sql("""
            SELECT coalesce(ticker,'ALL') AS ticker, count(*) AS matched_rows,
                   count(current_cap) AS current_covered, count(rebuilt) AS rebuilt_covered,
                   count(*) FILTER(WHERE current_cap IS NOT NULL AND rebuilt IS NOT NULL) AS paired,
                   count(*) FILTER(WHERE (current_cap IS NULL) != (rebuilt IS NULL)) AS coverage_diff,
                   count(*) FILTER(WHERE status = 'unknown_split_basis') AS unknown_split_basis,
                   count(*) FILTER(WHERE status = 'corrected_confirmed_split_basis') AS corrected_split_basis,
                   count(*) FILTER(WHERE split_blocked) AS split_blocked,
                   count(*) FILTER(WHERE current_cap IS NOT NULL AND rebuilt IS NOT NULL
                       AND (current_cap > 1e9) != (rebuilt > 1e9)) AS threshold_disagreements,
                   count(*) FILTER(WHERE current_cap IS NOT NULL AND rebuilt IS NOT NULL
                       AND ((current_cap>=2e9)::INT + (current_cap>=1e10)::INT + (current_cap>=2e11)::INT)
                       != ((rebuilt>=2e9)::INT + (rebuilt>=1e10)::INT + (rebuilt>=2e11)::INT)) AS class_disagreements,
                   count(*) FILTER(WHERE abs(rebuilt-current_cap) <= greatest(0.01,abs(current_cap)*1e-9)) AS matching_value,
                   quantile_cont(abs(rebuilt-current_cap)/nullif(abs(current_cap),0)*100, .95) AS p95_abs_pct
            FROM comparison WHERE has_baseline
            GROUP BY GROUPING SETS ((ticker), ()) ORDER BY ticker
        """).df()
        grouped.to_csv(work / "validation_summary.csv", index=False)
        all_stats = grouped[grouped.ticker.eq("ALL")].iloc[0].to_dict()
        matched = int(all_stats["matched_rows"])
        paired = int(all_stats["paired"])
        satisfactory = bool(matched and paired
                            and all_stats["coverage_diff"] / matched <= .01
                            and all_stats["class_disagreements"] / paired <= .01
                            and all_stats["threshold_disagreements"] / paired <= .01
                            and all_stats["matching_value"] / paired >= .99)
        write_json(work / "validation.json", {
            "staged_signature": manifest["signature"], "integrity_ok": True,
            "historical_parity_gate_passed": satisfactory,
            "staged_rows_without_baseline": keys - matched,
            "criteria": {
                "max_coverage_diff_fraction_of_matched": .01,
                "max_class_or_threshold_disagreement_fraction_of_paired": .01,
                "min_numeric_matches_fraction_of_paired": .99,
            },
            "statistics": {k: (None if pd.isna(v) else v.item() if hasattr(v, "item") else v)
                           for k, v in all_stats.items()},
        })
    print(grouped[grouped.ticker.eq("ALL")].to_string(index=False))
    if not satisfactory:
        raise SystemExit("Historical parity gate failed. Investigate validation reports before using staged values.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["rebuild", "update", "validate"])
    parser.add_argument("--data", type=Path, default=ROOT / "data", help="Daily, splits and baseline root")
    parser.add_argument("--work", type=Path, default=STATE, help="Dedicated staging directory outside production data")
    parser.add_argument("--tickers", nargs="+", help="Restrict rebuild/update to a pilot cohort")
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--max-new-snapshots", type=int, help="Abort before network access if the pending plan exceeds this count")
    parser.add_argument("--snapshot-archive", type=Path, help="Read-only import of original SQLite snapshot cache")
    parser.add_argument("--sec-pit", type=Path, help="Use the archived SEC PIT Parquet instead of recreating it")
    parser.add_argument("--identity-map", type=Path, help="Archived filing-level historical identity decisions")
    args = parser.parse_args()
    args.data, work = args.data.resolve(), args.work.resolve()
    protected = (args.data, ROOT / "data", ROOT / "data_2", ROOT / "apps", ROOT / "crates", ROOT / "tools")
    if work == ROOT or any(work.is_relative_to(root) for root in protected):
        parser.error("--work must be a dedicated staging directory outside production and code")
    if args.snapshot_archive:
        args.snapshot_archive = args.snapshot_archive.resolve(strict=True)
    work.mkdir(parents=True, exist_ok=True)
    with workspace_lock(work):
        if args.mode == "validate":
            validate(args, work)
        else:
            build(args, work)


if __name__ == "__main__":
    main()
