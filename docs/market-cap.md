# Historical market cap

The pipeline multiplies the unadjusted daily close by
`weighted_shares_outstanding` from the latest eligible monthly Massive Ticker
Overview snapshot. A snapshot is requested for the ticker's first observed
session of each month. Confirmed changes in issuer or share-class identity,
missing snapshots and splits can interrupt the carried share count.

The split correction checks the price change, the split factor, snapshot
identity and the available share-count evidence. SEC filings can corroborate
a share basis when the monthly snapshots are ambiguous. Verified issuance
evidence is maintained in
[`sec_issuance_evidence.csv`](../tools/historical_market_cap/sec_issuance_evidence.csv).
Unresolved values remain null. SEC requests use the contact
`QuantMaster quantmaster@gmail.com`.

## Rebuild and validate in a separate workspace

```powershell
python tools/historical_market_cap/pipeline.py rebuild --data data --work ../BigCaps.local/market_cap_work/review --tickers AAPL NVDA
python tools/historical_market_cap/pipeline.py update --data data --work ../BigCaps.local/market_cap_work/review
python tools/historical_market_cap/pipeline.py validate --data data --work ../BigCaps.local/market_cap_work/review
```

Reuse the same workspace when resuming. `--max-new-snapshots` limits new
requests. `--snapshot-archive <snapshots.sqlite>` can import a compatible
original snapshot cache into an empty workspace. If a `sec_raw/` directory
sits beside that archive, the pipeline can reuse SEC responses that meet its
freshness checks. Corrected results, provenance, split evidence and validation
reports are saved in the workspace. The main data pipeline uses corrected
estimates to fill missing values in the requested range and preserves existing
estimates.

Validation compares coverage, numeric agreement, capitalisation bands and
the strict `Market Cap > 1B` filter against existing feature Parquet files.

## Point-in-time limitations

All estimated values carry `PIT=false`. A historical date on a Massive
response does not establish when the share count first became available.
Current responses may also differ from archived snapshots. Later evidence
can help identify a historical share basis, and the same-session close is
available only after the close. The estimates are appropriate for historical
classification with these limitations.
