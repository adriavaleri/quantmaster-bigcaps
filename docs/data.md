# Local data

Install Python 3.11 or later and the data dependencies from the checkout:

```powershell
python -m pip install -r tools/requirements-data.txt
```

Set `MASSIVE_API_KEY`, `MASSIVE_S3_ACCESS_KEY` and `MASSIVE_S3_SECRET_KEY` in the
environment. The REST API key and the Flat Files credentials are separate.

## Create or update a dataset

Run from the project root:

```powershell
python -m tools.data_pipeline build --start 2025-01-02 --end 2025-01-10
python -m tools.data_pipeline update
```

Choose a practical start date. Indicators with long lookbacks and forward
returns need enough sessions before they produce values. The default dataset
is `data/`, with working files in `../BigCaps.local/data_pipeline_work/`
for a checkout named `BigCaps`. For a separate
dataset, pass `--data <dataset>` and `--work <work-directory>` on every run.
Keep the work directory outside the dataset and reuse it for subsequent runs.

The updater starts after the latest local session and adds the sessions
available from Massive. Pass both `--start` and `--end` to check a specific
range. Use `--offline` to calculate features from existing local inputs, or
`--skip-market-cap` to omit the market cap stage. The first feature build
establishes a baseline. Later runs calculate core features from the first
changed month and refresh forward returns for the affected preceding sessions.

In the desktop app, open **Settings → Update market data**. Blank key fields
use the environment. Flat Files uses `MASSIVE_S3_SECRET_KEY` from the environment
or the private `keys.env` file in the sibling `BigCaps.local/` directory.

## Dataset layout

| Path relative to the dataset | Contents |
| --- | --- |
| `daily/year=*/month=*.parquet` | Unadjusted daily aggregates for historical CS and ADRC listings |
| `metadata/splits.parquet` | Massive corporate actions used for split adjustments |
| `metadata/massive_tickers_daily/` | Historical listing snapshots |
| `research/daily_features/year=*/month=*.parquet` | Features, rankings, forward returns and estimated market cap |
| `market-breath/` | Optional standalone Market Breadth project |

The updater detects `market-breath/tools/market_breadth.py` when present in the
selected dataset and runs it after the daily stages. Install that project's
Python requirements separately. When both dates are passed, the dates must
also fall within the available Market Breadth range.
