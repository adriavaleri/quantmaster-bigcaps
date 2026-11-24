"""Retrieve and reconcile SEC share-count evidence."""

from __future__ import annotations
import hashlib
import json
import math
import shutil
import time
from datetime import date, datetime, time as clock_time, timedelta
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo
import duckdb
import numpy as np
import pandas as pd
import requests

ROOT = Path(__file__).resolve().parents[3]

FINAL = ROOT / "data" / "research" / "market_cap_daily_estimate_scale_11958" / "final"

PRIOR_AUDIT = ROOT / "data" / "research" / "market_cap_pit_validation"

OUT = ROOT / "data" / "research" / "market_cap_pit_sec_100"

RAW = OUT / "sec_raw"

PRIOR_RAW = PRIOR_AUDIT / "sec_raw"

IDENTITY_MAP_PATH = OUT / "historical_identity_map.parquet"

DAILY_GLOB = str(FINAL / "daily_market_cap_estimated" / "part-*.parquet").replace("\\", "/")

SNAPSHOT_GLOB = str(FINAL / "ticker_overview_monthly_snapshots" / "part-*.parquet").replace("\\", "/")

SEC_DATA = "https://data.sec.gov"

SEC_USER_AGENT = "QuantMaster quantmaster@gmail.com"

ET = ZoneInfo("America/New_York")

OPEN = clock_time(9, 30)

BUFFER_MINUTES = 15

MAX_SHARE_AGE_DAYS = 120

START = date(2016, 1, 1)

END = date(2026, 10, 31)

FACT_START = date(2015, 8, 1)

FORMS = {"10-K", "10-K/A", "10-Q", "10-Q/A", "20-F", "20-F/A", "40-F", "40-F/A", "6-K", "6-K/A"}

CONCEPTS = [
    ("dei", "EntityCommonStockSharesOutstanding"),
    ("us-gaap", "CommonStockSharesOutstanding"),
]

def read_parquet_rows(sql: str, params: list[Any]) -> pd.DataFrame:
    con = duckdb.connect()
    try:
        return con.execute(sql, params).df()
    finally:
        con.close()

class SecClient:
    def __init__(self, refresh_from=None) -> None:
        self.refresh_from = refresh_from or {}
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": SEC_USER_AGENT, "Accept-Encoding": "gzip, deflate", "Accept": "application/json"})
        self.last_request = 0.0
        self.requests: list[dict[str, Any]] = []

    def json(self, url: str, cache_path: Path, label: str, fallback_path: Path | None = None) -> dict[str, Any] | None:
        parts = label.split(":")
        cutoff = self.refresh_from.get(parts[1], 0) if parts[0] in {"submissions", "companyconcept"} else 0
        for path, origin in [(cache_path, "pilot_cache"), (fallback_path, "prior_sec_audit_cache")]:
            if path is None or not path.exists() or path.stat().st_mtime < cutoff:
                continue
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
                if path != cache_path:
                    cache_path.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(path, cache_path)
                status = 404 if payload is None else 200
                self.requests.append({"label": label, "url": url, "http_status": status,
                                      "requested_at": datetime.now().astimezone().isoformat(timespec="seconds"),
                                      "error": "", "cache_hit": True, "cache_origin": origin})
                return payload
            except (OSError, json.JSONDecodeError):
                pass
        for attempt in range(5):
            wait_s = 0.12 - (time.monotonic() - self.last_request)
            if wait_s > 0:
                time.sleep(wait_s)
            started = datetime.now().astimezone().isoformat(timespec="seconds")
            try:
                response = self.session.get(url, timeout=45)
                self.last_request = time.monotonic()
                record = {"label": label, "url": url, "http_status": response.status_code,
                          "requested_at": started, "error": "", "cache_hit": False, "cache_origin": "network"}
                self.requests.append(record)
                if response.status_code == 200:
                    payload = response.json()
                    cache_path.parent.mkdir(parents=True, exist_ok=True)
                    self._save(cache_path, payload)
                    return payload
                record["error"] = f"http_{response.status_code}"
                if response.status_code == 404:
                    self._save(cache_path, None)
                    return None
                if response.status_code == 429 or response.status_code >= 500:
                    time.sleep(min(20, 2 ** attempt))
                    continue
                return None
            except (requests.RequestException, ValueError) as exc:
                self.last_request = time.monotonic()
                self.requests.append({"label": label, "url": url, "http_status": None,
                                      "requested_at": started, "error": type(exc).__name__,
                                      "cache_hit": False, "cache_origin": "network"})
                if attempt == 4:
                    return None
                time.sleep(min(20, 2 ** attempt))
        return None


    @staticmethod
    def _save(path: Path, payload):
        path.parent.mkdir(parents=True, exist_ok=True)
        text = json.dumps(payload, separators=(",", ":"))
        if path.exists():
            previous = path.read_bytes()
            if previous != text.encode("utf-8"):
                stamp = hashlib.sha256(previous).hexdigest()
                (path.parent / f"{path.stem}.{stamp}.previous").write_bytes(previous)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(text, encoding="utf-8")
        tmp.replace(path)

def acceptance_map(payload: dict[str, Any] | None) -> dict[str, dict[str, Any]]:
    result: dict[str, dict[str, Any]] = {}
    recent = (payload or {}).get("filings", {}).get("recent", {})
    n = max((len(v) for v in recent.values() if isinstance(v, list)), default=0)
    for i in range(n):
        acc = (recent.get("accessionNumber") or [None] * n)[i]
        if not acc:
            continue
        result[str(acc)] = {
            "acceptanceDateTime": (recent.get("acceptanceDateTime") or [None] * n)[i],
            "filingDate": (recent.get("filingDate") or [None] * n)[i],
            "form": (recent.get("form") or [None] * n)[i],
        }
    return result

def fetch_sec_facts(ciks: list[str], client: SecClient) -> pd.DataFrame:
    all_rows: list[dict[str, Any]] = []
    for cik in ciks:
        cik = str(cik).zfill(10)
        sub_rel = Path("submissions") / f"CIK{cik}.json"
        sub_url = f"{SEC_DATA}/submissions/CIK{cik}.json"
        sub = client.json(sub_url, RAW / sub_rel, f"submissions:{cik}", PRIOR_RAW / sub_rel)
        amap = acceptance_map(sub)
        issuer_rows: list[dict[str, Any]] = []
        for taxonomy, concept_name in CONCEPTS:
            concept_id = f"{taxonomy}/{concept_name}"
            rel = Path("companyconcept") / f"CIK{cik}_{taxonomy}_{concept_name}.json"
            url = f"{SEC_DATA}/api/xbrl/companyconcept/CIK{cik}/{concept_id}.json"
            payload = client.json(url, RAW / rel, f"companyconcept:{cik}:{concept_id}", PRIOR_RAW / rel)
            if not payload:
                continue
            for unit, items in payload.get("units", {}).items():
                if unit.lower() != "shares":
                    continue
                for item in items:
                    form = str(item.get("form") or "")
                    end = item.get("end")
                    filed = item.get("filed")
                    if form not in FORMS or not end or not filed:
                        continue
                    fact_end = pd.to_datetime(end, errors="coerce")
                    filed_date = pd.to_datetime(filed, errors="coerce")
                    if pd.isna(fact_end) or pd.isna(filed_date) or fact_end.date() < FACT_START:
                        continue
                    accession = str(item.get("accn") or "")
                    accession_info = amap.get(accession, {})
                    issuer_rows.append({
                        "cik": cik,
                        "taxonomy": taxonomy,
                        "concept": str(payload.get("tag") or concept_name),
                        "concept_description": str(payload.get("description") or ""),
                        "unit": unit,
                        "shares": pd.to_numeric(item.get("val"), errors="coerce"),
                        "fact_end": fact_end.date(),
                        "concept_filed_date": filed_date.date(),
                        "filed_date": pd.to_datetime(accession_info.get("filingDate"), errors="coerce").date()
                            if pd.notna(pd.to_datetime(accession_info.get("filingDate"), errors="coerce")) else None,
                        "acceptance_datetime_utc": pd.to_datetime(accession_info.get("acceptanceDateTime"), errors="coerce", utc=True),
                        "form": form,
                        "accession": accession,
                        "fy": item.get("fy"),
                        "fp": str(item.get("fp") or ""),
                    })

        missing = {r["accession"] for r in issuer_rows if r["accession"] and pd.isna(r["acceptance_datetime_utc"])}
        if missing and sub:
            for meta in sub.get("filings", {}).get("files", []):
                if not missing:
                    break
                lo = str(meta.get("filingFrom") or "")
                hi = str(meta.get("filingTo") or "")
                if hi and hi < FACT_START.isoformat():
                    continue
                name = str(meta.get("name") or "")
                if not name:
                    continue
                rel = Path("submission_archives") / cik / name
                archive_url = f"{SEC_DATA}/submissions/{name}"
                fallback = PRIOR_RAW / rel
                archive = client.json(archive_url, RAW / rel, f"submission_archive:{cik}:{name}", fallback)
                if not archive or "accessionNumber" not in archive:
                    continue
                n = len(archive.get("accessionNumber", []))
                for j in range(n):
                    acc = str(archive["accessionNumber"][j])
                    amap[acc] = {
                        "acceptanceDateTime": (archive.get("acceptanceDateTime") or [None] * n)[j],
                        "filingDate": (archive.get("filingDate") or [None] * n)[j],
                        "form": (archive.get("form") or [None] * n)[j],
                    }
                missing -= set(amap)
            for row in issuer_rows:
                info = amap.get(row["accession"], {})
                row["filed_date"] = pd.to_datetime(info.get("filingDate"), errors="coerce").date() if info.get("filingDate") else row["filed_date"]
                row["acceptance_datetime_utc"] = pd.to_datetime(info.get("acceptanceDateTime"), errors="coerce", utc=True)
        all_rows.extend(issuer_rows)

    facts = pd.DataFrame(all_rows)
    if facts.empty:
        return pd.DataFrame(columns=["cik", "taxonomy", "concept", "shares", "fact_end", "filed_date", "acceptance_datetime_utc", "accession"])
    facts["shares"] = pd.to_numeric(facts["shares"], errors="coerce")
    facts = facts[facts["shares"].gt(0) & facts["fact_end"].notna()].copy()
    facts = facts.drop_duplicates(["cik", "accession", "fact_end", "shares", "taxonomy", "concept"])
    facts["scale_anomaly"] = False
    facts["scale_anomaly_ratio_to_counterpart"] = np.nan
    facts["scale_anomaly_counterpart"] = ""
    facts["same_filing_conflict"] = False

    gaap = facts[(facts["taxonomy"] == "us-gaap") & (facts["concept"] == "CommonStockSharesOutstanding")]
    gaap_accession = {key: group for key, group in gaap.groupby(["cik", "accession"], sort=False)}
    for idx, fact in facts[facts["taxonomy"].eq("dei")].iterrows():
        matches = gaap_accession.get((fact["cik"], fact["accession"]))
        if matches is None or matches.empty:
            continue
        candidates = matches.copy()
        candidates["end_gap"] = candidates["fact_end"].map(lambda d: abs((d - fact["fact_end"]).days))
        candidates = candidates[candidates["end_gap"].le(90)]
        if candidates.empty:
            continue
        other = candidates.sort_values(["end_gap", "fact_end"]).iloc[0]
        ratio = float(fact["shares"]) / float(other["shares"])
        if ratio <= 0 or not math.isfinite(ratio):
            continue
        power = int(round(math.log10(ratio)))
        if abs(power) >= 3 and abs(ratio / (10.0 ** power) - 1.0) <= 0.02:
            bad_idx = idx if ratio < 1 else other.name
            counterpart = "us-gaap:CommonStockSharesOutstanding" if ratio < 1 else "dei:EntityCommonStockSharesOutstanding"
            small = float(facts.loc[bad_idx, "shares"])
            large = float(other["shares"] if ratio < 1 else fact["shares"])
            facts.loc[bad_idx, "scale_anomaly"] = True
            facts.loc[bad_idx, "scale_anomaly_ratio_to_counterpart"] = small / large
            facts.loc[bad_idx, "scale_anomaly_counterpart"] = counterpart

    # Different non-scale values for the same issuer, filing and measurement
    # date can be distinct share classes; do not guess which class they mean.
    for _, group in facts.groupby(["cik", "accession", "fact_end"], dropna=False, sort=False):
        usable = group[~group["scale_anomaly"]]
        vals = usable["shares"].dropna().astype(float)
        if len(vals) > 1 and (vals.max() / vals.min() - 1.0) > 0.01:
            facts.loc[usable.index, "same_filing_conflict"] = True

    facts["availability_proxy_utc"] = facts.apply(
        lambda fact: availability_proxy(fact) if pd.notna(fact["acceptance_datetime_utc"]) and pd.notna(fact["filed_date"]) else pd.NaT,
        axis=1,
    )
    facts["availability_proxy_utc"] = pd.to_datetime(facts["availability_proxy_utc"], utc=True)

    # Preserve all facts and reconciliation flags in the raw output; a separate
    # chooser below produces the one SEC source row used for calculations.
    facts["availability_proxy_utc"] = pd.to_datetime(facts["availability_proxy_utc"], utc=True)
    facts["acceptance_datetime_utc"] = pd.to_datetime(facts["acceptance_datetime_utc"], utc=True)
    return facts

def load_daily_and_metadata(sample: pd.DataFrame, *, splits_path=None) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    tickers = sample["ticker"].astype(str).tolist()
    marks = ",".join("?" for _ in tickers)
    daily = read_parquet_rows(f"""
        SELECT CAST(date AS DATE) AS session_date, ticker, close_no_adjusted,
               identity_cik, identity_share_class_figi, identity_composite_figi,
               identity_valid, split_blocked, market_cap_estimated,
               market_cap_estimated_snapshot_date
        FROM read_parquet('{DAILY_GLOB}')
        WHERE ticker IN ({marks}) AND CAST(date AS DATE) BETWEEN ? AND ?
        ORDER BY ticker, session_date
    """, [*tickers, START, END])
    daily["session_date"] = pd.to_datetime(daily["session_date"]).dt.date
    daily["ticker"] = daily["ticker"].astype(str)
    daily["identity_cik"] = daily["identity_cik"].astype("string").str.zfill(10)
    daily["identity_share_class_figi"] = daily["identity_share_class_figi"].astype("string")
    daily["close_no_adjusted"] = pd.to_numeric(daily["close_no_adjusted"], errors="coerce")
    daily["market_cap_estimated"] = pd.to_numeric(daily["market_cap_estimated"], errors="coerce")
    daily["identity_valid"] = daily["identity_valid"].fillna(False).astype(bool)
    daily["split_blocked"] = daily["split_blocked"].fillna(False).astype(bool)

    ciks = sorted(daily["identity_cik"].dropna().astype(str).unique())
    ci_marks = ",".join("?" for _ in ciks)
    related = read_parquet_rows(f"""
        SELECT CAST(date AS DATE) AS session_date, ticker, identity_cik, identity_share_class_figi,
               identity_valid
        FROM read_parquet('{DAILY_GLOB}')
        WHERE identity_cik IN ({ci_marks}) AND CAST(date AS DATE) BETWEEN ? AND ?
    """, [*ciks, START, END]) if ciks else daily.iloc[:0].copy()
    related["session_date"] = pd.to_datetime(related["session_date"]).dt.date
    related["identity_cik"] = related["identity_cik"].astype("string").str.zfill(10)
    related["identity_share_class_figi"] = related["identity_share_class_figi"].astype("string")
    class_rows = related[related["identity_valid"].fillna(False) & related["identity_share_class_figi"].notna()]
    classes = class_rows.groupby(["session_date", "identity_cik"], as_index=False).agg(
        listed_share_class_count=("identity_share_class_figi", "nunique"),
        listed_ticker_count=("ticker", "nunique"),
    )
    daily = daily.merge(classes, on=["session_date", "identity_cik"], how="left", validate="many_to_one")
    daily["listed_share_class_count"] = pd.to_numeric(daily["listed_share_class_count"], errors="coerce")

    snapshot = read_parquet_rows(f"""
        SELECT ticker, CAST(snapshot_date AS DATE) AS snapshot_date, type AS massive_instrument_type,
               share_class_figi AS snapshot_share_class_figi
        FROM read_parquet('{SNAPSHOT_GLOB}') WHERE ticker IN ({marks})
    """, tickers)
    snapshot["snapshot_date"] = pd.to_datetime(snapshot["snapshot_date"], errors="coerce").dt.date
    snapshot["ticker"] = snapshot["ticker"].astype(str)
    outputs: list[pd.DataFrame] = []
    for ticker, dg in daily.groupby("ticker", sort=False):
        sg = snapshot[snapshot["ticker"].eq(ticker)].dropna(subset=["snapshot_date"]).sort_values("snapshot_date")
        dg = dg.sort_values("session_date").copy()
        if sg.empty:
            dg["massive_instrument_type"] = pd.NA
            dg["snapshot_share_class_figi"] = pd.NA
        else:
            left = pd.DataFrame({"session_date": pd.to_datetime(dg["session_date"]), "_idx": dg.index}).sort_values("session_date")
            right = sg.copy()
            right["snapshot_date"] = pd.to_datetime(right["snapshot_date"])
            joined = pd.merge_asof(left, right.sort_values("snapshot_date"), left_on="session_date", right_on="snapshot_date", direction="backward")
            joined = joined.set_index("_idx")
            dg["massive_instrument_type"] = joined["massive_instrument_type"]
            dg["snapshot_share_class_figi"] = joined["snapshot_share_class_figi"]
        outputs.append(dg)
    daily = pd.concat(outputs, ignore_index=True).sort_values(["ticker", "session_date"]).reset_index(drop=True)

    # One dated canonical decision table can supplement missing or rejected
    # provider IDs. It never changes the source Daily files. Existing valid
    # CIK/FIGI pairs remain intact; SEC corrections require a filing available
    # before the session and an explicit share-class result.
    identity_columns = [
        "canonical_cik", "canonical_share_class_id", "canonical_share_class_title",
        "canonical_share_class_count", "identity_map_status", "identity_map_source",
        "identity_evidence_accession", "identity_evidence_form", "identity_evidence_filing_date",
        "identity_evidence_acceptance_utc", "identity_evidence_available_utc",
        "identity_evidence_class_title", "identity_evidence_exchange",
    ]
    if IDENTITY_MAP_PATH.exists():
        identity_map = pd.read_parquet(IDENTITY_MAP_PATH)
        identity_map["session_date"] = pd.to_datetime(identity_map["session_date"], errors="coerce").dt.date
        identity_map["ticker"] = identity_map["ticker"].astype(str)
        daily = daily.merge(identity_map[["session_date", "ticker", *identity_columns]],
                            on=["session_date", "ticker"], how="left", validate="one_to_one")
    else:
        for col in identity_columns:
            daily[col] = pd.NA
    daily["canonical_cik"] = daily["canonical_cik"].astype("string").str.zfill(10)
    daily["canonical_share_class_count"] = pd.to_numeric(daily["canonical_share_class_count"], errors="coerce")
    daily["identity_evidence_available_utc"] = pd.to_datetime(daily["identity_evidence_available_utc"], utc=True, errors="coerce")
    sec_class_count = daily["canonical_share_class_count"]
    daily["listed_share_class_count"] = pd.to_numeric(daily["listed_share_class_count"], errors="coerce")
    daily["listed_share_class_count"] = daily["listed_share_class_count"].where(
        daily["listed_share_class_count"].notna() | sec_class_count.isna(), sec_class_count)
    daily["listed_share_class_count"] = pd.concat(
        [daily["listed_share_class_count"], sec_class_count], axis=1).max(axis=1, skipna=True)

    # Identity segments are local to each ticker. A CIK/share-class change
    # starts a new segment; facts before that transition are not carried over.
    raw_pair = daily["identity_cik"].fillna("") + "|" + daily["identity_share_class_figi"].fillna("")
    canonical_class = daily["canonical_share_class_id"].copy()
    # If SEC verifies a ticker/CIK while the source row already has a class
    # FIGI, retain that same segment key. This avoids inventing an identity
    # transition at an interval where the vendor's validity flag alone changed.
    canonical_class = canonical_class.where(
        daily["identity_share_class_figi"].isna(), daily["identity_share_class_figi"])
    canonical_pair = daily["canonical_cik"].fillna("") + "|" + canonical_class.fillna("")
    daily["identity_pair"] = canonical_pair.where(daily["canonical_cik"].notna() & canonical_class.notna(), raw_pair)
    daily["identity_pair_changed"] = daily.groupby("ticker")["identity_pair"].transform(lambda x: x.ne(x.shift()).fillna(True))
    daily["identity_segment"] = daily.groupby("ticker")["identity_pair_changed"].cumsum().astype(int)
    daily["identity_segment_start_date"] = daily.groupby(["ticker", "identity_segment"])["session_date"].transform("min")
    daily["identity_transition"] = daily["identity_segment"].gt(1)
    transitions = daily[daily["identity_pair_changed"] & daily["identity_segment"].gt(1)][
        ["ticker", "session_date", "identity_segment", "identity_cik", "identity_share_class_figi", "identity_composite_figi",
         "canonical_cik", "canonical_share_class_id", "identity_map_status", "identity_evidence_accession"]
    ].copy()

    # Load split rows for names that mapped to one of the selected CIKs. Map the
    # corporate action to its CIK/share-class FIGI as observed on its effective
    # date; unresolved mappings are retained for auditing and block affected caps.
    split_file = pd.read_parquet(splits_path or ROOT / "data" / "metadata" / "splits.parquet")
    split_file["execution_date"] = pd.to_datetime(split_file["execution_date"], errors="coerce").dt.date
    split_file["split_from"] = pd.to_numeric(split_file["split_from"], errors="coerce")
    split_file["split_to"] = pd.to_numeric(split_file["split_to"], errors="coerce")
    related_tickers = sorted(related["ticker"].dropna().astype(str).unique())
    split_file = split_file[split_file["ticker"].astype(str).isin(related_tickers)
                            & split_file["execution_date"].between(FACT_START, END)
                            & split_file["split_from"].gt(0) & split_file["split_to"].gt(0)].copy()
    split_rows: list[dict[str, Any]] = []
    for event in split_file.to_dict("records"):
        candidates = related[related["ticker"].astype(str).eq(str(event["ticker"]))].copy()
        if candidates.empty:
            split_rows.append({**event, "identity_cik": None, "identity_share_class_figi": None, "split_mapping_status": "unmapped_ticker"})
            continue
        candidates["day_gap"] = candidates["session_date"].map(lambda d: abs((d - event["execution_date"]).days))
        near = candidates[candidates["day_gap"].le(10)].copy()
        if near.empty:
            split_rows.append({**event, "identity_cik": None, "identity_share_class_figi": None, "split_mapping_status": "no_identity_near_effective_date"})
            continue
        near["before_or_on"] = near["session_date"].le(event["execution_date"])
        near = near.sort_values(["day_gap", "before_or_on"], ascending=[True, False])
        chosen = near.iloc[0]
        split_rows.append({**event,
                           "identity_cik": str(chosen["identity_cik"]).zfill(10),
                           "identity_share_class_figi": str(chosen["identity_share_class_figi"]),
                           "split_mapping_status": "mapped_near_effective_date" if chosen["day_gap"] <= 3 else "mapped_low_date_confidence"})
    split_map = pd.DataFrame(split_rows)
    if not split_map.empty:
        split_map["split_ratio"] = split_map["split_to"] / split_map["split_from"]
        split_map["split_ratio"] = pd.to_numeric(split_map["split_ratio"], errors="coerce")
        split_symbols = sorted(split_map["ticker"].dropna().astype(str).unique())
        split_marks = ",".join("?" for _ in split_symbols)
        split_prices = read_parquet_rows(f"""
            SELECT CAST(date AS DATE) AS session_date, ticker, close_no_adjusted,
                   identity_cik, identity_share_class_figi
            FROM read_parquet('{DAILY_GLOB}') WHERE ticker IN ({split_marks})
              AND CAST(date AS DATE) BETWEEN ? AND ?
            ORDER BY ticker, session_date
        """, [*split_symbols, START, END])
        split_prices["session_date"] = pd.to_datetime(split_prices["session_date"]).dt.date
        split_prices["identity_cik"] = split_prices["identity_cik"].astype("string").str.zfill(10)
        split_prices["identity_share_class_figi"] = split_prices["identity_share_class_figi"].astype("string")
        split_prices["close_no_adjusted"] = pd.to_numeric(split_prices["close_no_adjusted"], errors="coerce")
        split_map = align_split_sessions(split_map, split_prices)
    else:
        split_prices = pd.DataFrame(columns=["session_date", "ticker", "close_no_adjusted", "identity_cik", "identity_share_class_figi"])
    return daily, snapshot, split_map, transitions, split_prices

def align_split_sessions(split_map: pd.DataFrame, split_prices: pd.DataFrame) -> pd.DataFrame:
    """Validate the candidate split date against unadjusted Daily prices.

    The price window is diagnostic only: it never moves an event date using
    later observations. A material split whose raw price boundary is only
    visible on a later session is unresolved and blocks affected caps.
    """
    aligned = split_map.copy()
    effective_dates: list[date] = []
    statuses: list[str] = []
    before_prices: list[float] = []
    after_prices: list[float] = []
    after_sessions: list[date | None] = []
    observed_ratios: list[float] = []
    for event in aligned.to_dict("records"):
        ticker = str(event["ticker"])
        candidates = split_prices[split_prices["ticker"].astype(str).eq(ticker)].copy()
        if pd.notna(event.get("identity_cik")) and pd.notna(event.get("identity_share_class_figi")):
            security = candidates[
                candidates["identity_cik"].astype(str).str.zfill(10).eq(str(event["identity_cik"]).zfill(10))
                & candidates["identity_share_class_figi"].astype(str).eq(str(event["identity_share_class_figi"]))
            ]
            if not security.empty:
                candidates = security
        before = candidates[candidates["session_date"] < event["execution_date"]].sort_values("session_date").tail(1)
        after = candidates[(candidates["session_date"] >= event["execution_date"])
                           & (candidates["session_date"] <= event["execution_date"] + timedelta(days=7))].sort_values("session_date")
        ratio = float(event["split_ratio"]) if pd.notna(event.get("split_ratio")) and float(event["split_ratio"]) > 0 else np.nan
        before_price = float(before.iloc[0]["close_no_adjusted"]) if not before.empty and pd.notna(before.iloc[0]["close_no_adjusted"]) else np.nan
        target = 1.0 / ratio if pd.notna(ratio) and ratio > 0 else np.nan
        effective = event["execution_date"]
        status = "metadata_date_used_no_price_window"
        found_session = None
        found_price = np.nan
        found_ratio = np.nan
        if pd.notna(before_price) and pd.notna(target) and not after.empty:
            comparisons = []
            for item in after.to_dict("records"):
                price = float(item["close_no_adjusted"]) if pd.notna(item["close_no_adjusted"]) else np.nan
                actual = price / before_price if pd.notna(price) and before_price else np.nan
                rel = abs(actual / target - 1.0) if pd.notna(actual) and target else np.inf
                comparisons.append((item["session_date"], price, actual, rel))
            # A small dividend has too little price signal for precise date
            # inference; retain metadata's date and flag the weak check.
            material = ratio >= 1.20 or ratio <= (1.0 / 1.20)
            close_enough = [x for x in comparisons if x[3] <= 0.15]
            if close_enough:
                chosen = min(close_enough, key=lambda x: x[0])
                found_session, found_price, found_ratio, _ = chosen
                if found_session == event["execution_date"]:
                    status = "price_basis_aligned_on_metadata_date"
                elif material:
                    # Do not infer a historical effective date from future prices.
                    # Keep the provider's candidate date and block until a later
                    # SEC fact establishes a post-split share basis.
                    status = "price_basis_unresolved"
                else:
                    status = "metadata_date_used_weak_price_signal"
            elif material:
                status = "price_basis_unresolved"
            else:
                found_session, found_price, found_ratio, _ = comparisons[0]
                status = "metadata_date_used_weak_price_signal"
        elif pd.notna(target) and (ratio > 0) and (0.95 <= ratio <= 1.05):
            status = "metadata_date_used_small_adjustment"
        elif pd.notna(target) and (ratio >= 1.25 or ratio <= 0.80):
            status = "price_basis_unresolved"
        effective_dates.append(effective)
        statuses.append(status)
        before_prices.append(before_price)
        after_prices.append(found_price)
        after_sessions.append(found_session)
        observed_ratios.append(found_ratio)
    aligned["cap_effective_session_date"] = effective_dates
    aligned["price_basis_alignment_status"] = statuses
    aligned["alignment_close_before"] = before_prices
    aligned["alignment_close_after"] = after_prices
    aligned["alignment_after_session"] = after_sessions
    aligned["alignment_observed_close_ratio"] = observed_ratios
    return aligned

def availability_proxy(row: pd.Series) -> pd.Timestamp:
    accepted = row["acceptance_datetime_utc"]
    filed = row["filed_date"]
    buffer = pd.Timedelta(value=int(BUFFER_MINUTES), unit="m")
    proxy = accepted + buffer
    if pd.notna(filed) and filed > accepted.tz_convert(ET).date():
        filed_open = pd.Timestamp(datetime.combine(filed, clock_time(6, 0), tzinfo=ET)).tz_convert("UTC")
        proxy = max(proxy, filed_open + buffer)
    return proxy

def choose_sec_measurements(facts: pd.DataFrame) -> pd.DataFrame:
    """Reconcile tags into one value per accession and fact-end date."""
    if facts.empty:
        return facts.copy()
    facts = facts[facts["availability_proxy_utc"].notna()
                  & facts["acceptance_datetime_utc"].notna()
                  & facts["filed_date"].notna()].copy()
    rows = []
    for (cik, accession, fact_end), group in facts.groupby(["cik", "accession", "fact_end"], sort=False):
        if group["same_filing_conflict"].any():
            continue
        use = group[~group["scale_anomaly"]]
        if use.empty:
            continue
        values = use["shares"].dropna().astype(float)
        if len(values) > 1 and values.max() / values.min() - 1.0 > 0.01:
            continue
        dei = use[use["taxonomy"].eq("dei")]
        rec = (dei.iloc[0] if not dei.empty else use.iloc[0]).to_dict()
        rows.append(rec)
    out = pd.DataFrame(rows)
    if not out.empty:
        out = out.sort_values(["cik", "fact_end", "availability_proxy_utc", "accession"]).drop_duplicates(
            ["cik", "accession", "fact_end"], keep="last")
    return out

def reconstruct_daily(daily: pd.DataFrame, facts: pd.DataFrame, split_map: pd.DataFrame) -> pd.DataFrame:
    measures = choose_sec_measurements(facts)
    facts_by_cik = {str(cik).zfill(10): group.sort_values("availability_proxy_utc").to_dict("records")
                    for cik, group in measures.groupby("cik", sort=False)} if not measures.empty else {}
    splits_by_security: dict[tuple[str, str], list[dict[str, Any]]] = {}
    if not split_map.empty:
        for key, group in split_map.groupby(["identity_cik", "identity_share_class_figi"], dropna=False, sort=False):
            cik, figi = str(key[0]), str(key[1])
            events = []
            for event_date, same_day in group.groupby("cap_effective_session_date", sort=True):
                ratios = set(round(float(x), 12) for x in same_day["split_ratio"].dropna())
                unresolved = (
                    same_day["split_mapping_status"].isin(["unmapped_ticker", "no_identity_near_effective_date", "mapped_low_date_confidence"]).any()
                    or same_day["price_basis_alignment_status"].eq("price_basis_unresolved").any()
                )
                if len(ratios) != 1:
                    events.append({"execution_date": event_date, "ratio": None, "conflict": True, "mapping_confidence": "unresolved"})
                else:
                    events.append({"execution_date": event_date, "ratio": next(iter(ratios)), "conflict": False,
                                   "mapping_confidence": "unresolved" if unresolved else "mapped"})
            splits_by_security[(cik, figi)] = events

    output: list[dict[str, Any]] = []
    for ticker, group in daily.groupby("ticker", sort=False):
        group = group.sort_values("session_date")
        for segment, rows in group.groupby("identity_segment", sort=True):
            rows = rows.sort_values("session_date")
            first = rows.iloc[0]
            cik_value = first.get("canonical_cik") if pd.notna(first.get("canonical_cik")) else first["identity_cik"]
            cik = str(cik_value).zfill(10) if pd.notna(cik_value) else ""
            figi = str(first["identity_share_class_figi"]) if pd.notna(first["identity_share_class_figi"]) else ""
            segment_start = first["identity_segment_start_date"]
            identity_transition = bool(first["identity_transition"])
            sec_facts = facts_by_cik.get(cik, [])
            events = list(splits_by_security.get((cik, figi), []))
            # If a corporate-action row cannot be mapped to CIK/FIGI, block the
            # same ticker through its own symbol history; never guess a ratio
            # across a missing identity interval or ticker reuse.
            direct_unmapped = split_map if split_map.empty else split_map[(split_map["ticker"].astype(str).eq(str(ticker)))
                                        & (~split_map["split_mapping_status"].eq("mapped_near_effective_date")
                                           | split_map["price_basis_alignment_status"].eq("price_basis_unresolved"))]
            for unresolved in direct_unmapped.to_dict("records"):
                event_date = unresolved.get("cap_effective_session_date")
                if event_date is None:
                    continue
                already = any(e["execution_date"] == event_date for e in events)
                if already:
                    continue
                ratio = unresolved.get("split_ratio")
                events.append({"execution_date": event_date,
                               "ratio": float(ratio) if pd.notna(ratio) else None,
                               "conflict": pd.isna(ratio),
                               "mapping_confidence": "unresolved"})
            events.sort(key=lambda e: e["execution_date"])
            # A fact published after a split with a pre-split measurement date
            # can be recast or not. Exclude it rather than guessing the units.
            unambiguous: list[dict[str, Any]] = []
            basis_ambiguous_facts: list[dict[str, Any]] = []
            for fact in sec_facts:
                if identity_transition and fact["availability_proxy_utc"].tz_convert(ET).date() < segment_start:
                    continue
                ambiguous = False
                for event in events:
                    if event["conflict"]:
                        if fact["fact_end"] < event["execution_date"] <= fact["availability_proxy_utc"].tz_convert(ET).date():
                            ambiguous = True
                            break
                    elif event["mapping_confidence"] == "unresolved" and fact["fact_end"] < event["execution_date"] <= fact["availability_proxy_utc"].tz_convert(ET).date():
                        ambiguous = True
                        break
                    elif fact["fact_end"] < event["execution_date"] <= fact["availability_proxy_utc"].tz_convert(ET).date():
                        ambiguous = True
                        break
                if ambiguous:
                    basis_ambiguous_facts.append(fact)
                else:
                    unambiguous.append(fact)
            unambiguous.sort(key=lambda f: f["availability_proxy_utc"])
            pointer = 0
            latest_by_end: dict[date, dict[str, Any]] = {}

            for record in rows.to_dict("records"):
                session = record["session_date"]
                open_utc = pd.Timestamp(datetime.combine(session, OPEN, tzinfo=ET)).tz_convert("UTC")
                while pointer < len(unambiguous) and unambiguous[pointer]["availability_proxy_utc"] <= open_utc:
                    fact = unambiguous[pointer]
                    if fact["fact_end"] <= session:
                        old = latest_by_end.get(fact["fact_end"])
                        if old is None or fact["availability_proxy_utc"] >= old["availability_proxy_utc"]:
                            latest_by_end[fact["fact_end"]] = fact
                    pointer += 1
                eligible_ends = [d for d in latest_by_end if d <= session]
                fact = latest_by_end[max(eligible_ends)] if eligible_ends else None
                if fact is not None and (session - fact["fact_end"]).days > MAX_SHARE_AGE_DAYS:
                    fact = None

                status = "ok"
                share_count_status = "single_listed_class_observed"
                cap = np.nan
                shares = np.nan
                split_factor = 1.0
                applied: list[str] = []
                legacy_identity_ok = (bool(record["identity_valid"])
                                      and pd.notna(record["identity_cik"])
                                      and pd.notna(record["identity_share_class_figi"]))
                identity_map_source = record.get("identity_map_source")
                sec_identity_ok = (
                    pd.notna(identity_map_source)
                    and str(identity_map_source) == "SEC_filing"
                    and pd.notna(record.get("canonical_cik"))
                    and str(record.get("canonical_cik")).zfill(10) == cik
                    and pd.notna(record.get("identity_evidence_available_utc"))
                    and record["identity_evidence_available_utc"] <= open_utc
                )
                if not pd.notna(record["close_no_adjusted"]) or float(record["close_no_adjusted"]) <= 0:
                    status = "missing_or_invalid_daily_price"
                elif not (legacy_identity_ok or sec_identity_ok) or not cik:
                    status = "identity_unresolved"
                    share_count_status = "identity_unresolved"
                elif pd.isna(record["massive_instrument_type"]):
                    status = "instrument_type_unresolved"
                    share_count_status = "instrument_type_unresolved"
                elif str(record["massive_instrument_type"]) == "ADRC":
                    status = "adr_ratio_unresolved"
                    share_count_status = "adr_units_unresolved"
                elif str(record["massive_instrument_type"]) != "CS":
                    status = "non_common_instrument"
                    share_count_status = "non_common_instrument"
                elif pd.isna(record["listed_share_class_count"]):
                    status = "listed_class_count_unresolved"
                    share_count_status = "listed_class_count_unresolved"
                elif int(record["listed_share_class_count"]) != 1:
                    status = "multiple_listed_classes_same_cik"
                    share_count_status = "multiple_listed_classes"
                elif bool(record["split_blocked"]):
                    status = "daily_split_identity_blocked"
                elif identity_transition and (session - segment_start).days < 0:
                    status = "identity_transition_unresolved"
                elif fact is None:
                    if basis_ambiguous_facts:
                        status = "post_split_historical_fact_basis_ambiguous"
                    elif sec_facts and not latest_by_end:
                        status = "no_sec_fact_available_before_open"
                    elif latest_by_end:
                        status = "sec_fact_stale_over_120_days"
                    else:
                        status = "no_sec_share_filing"
                else:
                    failed_split = False
                    for event in events:
                        if fact["fact_end"] < event["execution_date"] <= session:
                            if event["conflict"] or event["mapping_confidence"] == "unresolved":
                                failed_split = True
                                break
                            split_factor *= float(event["ratio"])
                            applied.append(f"{event['execution_date']}:{event['ratio']:.12g}")
                    if failed_split:
                        status = "split_ratio_or_identity_unresolved"
                    else:
                        shares = float(fact["shares"]) * split_factor
                        cap = float(record["close_no_adjusted"]) * shares
                        if not math.isfinite(cap) or cap <= 0:
                            cap = np.nan
                            shares = np.nan
                            status = "invalid_calculated_market_cap"

                record.update({
                    "shares_pit_sec": shares,
                    "market_cap_sec_pit": cap,
                    "market_cap_pit": bool(pd.notna(cap)),
                    "pit_status": status,
                    "share_count_class_status": share_count_status,
                    "shares_fact_end": fact["fact_end"] if fact is not None and status == "ok" else None,
                    "shares_filed_date": fact["filed_date"] if fact is not None and status == "ok" else None,
                    "shares_acceptance_datetime_utc": fact["acceptance_datetime_utc"].isoformat() if fact is not None and status == "ok" else None,
                    "shares_available_proxy_utc": fact["availability_proxy_utc"].isoformat() if fact is not None and status == "ok" else None,
                    "shares_source_taxonomy": fact["taxonomy"] if fact is not None and status == "ok" else None,
                    "shares_source_concept": fact["concept"] if fact is not None and status == "ok" else None,
                    "shares_accession": fact["accession"] if fact is not None and status == "ok" else None,
                    "shares_age_days": (session - fact["fact_end"]).days if fact is not None and status == "ok" else None,
                    "shares_split_adjustment_factor": split_factor if status == "ok" else None,
                    "shares_split_events_applied": ";".join(applied) if status == "ok" else None,
                    "identity_segment": int(segment),
                    "identity_segment_start_date": segment_start,
                    "identity_transition": identity_transition,
                    "canonical_cik": record.get("canonical_cik"),
                    "canonical_share_class_id": record.get("canonical_share_class_id"),
                    "canonical_share_class_title": record.get("canonical_share_class_title"),
                    "identity_map_status": record.get("identity_map_status"),
                    "identity_map_source": record.get("identity_map_source"),
                    "identity_evidence_accession": record.get("identity_evidence_accession"),
                    "identity_evidence_form": record.get("identity_evidence_form"),
                    "identity_evidence_filing_date": record.get("identity_evidence_filing_date"),
                    "identity_evidence_acceptance_utc": record.get("identity_evidence_acceptance_utc"),
                    "identity_evidence_available_utc": record.get("identity_evidence_available_utc"),
                    "identity_evidence_class_title": record.get("identity_evidence_class_title"),
                    "identity_evidence_exchange": record.get("identity_evidence_exchange"),
                    "price_basis": "close_no_adjusted",
                    "shares_source_of_truth": "SEC_CompanyConcept_only",
                    "market_cap_estimated_existing": record["market_cap_estimated"],
                    "massive_estimate_snapshot_date": record["market_cap_estimated_snapshot_date"],
                })
                output.append(record)

    out = pd.DataFrame(output)
    out["session_date"] = pd.to_datetime(out["session_date"]).dt.date
    out["market_cap_pit"] = out["market_cap_pit"].fillna(False).astype(bool)
    out["relative_error_vs_massive_estimate_pct"] = np.where(
        out["market_cap_sec_pit"].gt(0) & out["market_cap_estimated_existing"].gt(0),
        (out["market_cap_estimated_existing"] / out["market_cap_sec_pit"] - 1.0) * 100.0,
        np.nan,
    )
    return out
