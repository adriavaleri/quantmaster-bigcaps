# QuantMaster BigCaps

BigCaps is a Windows desktop app for screening historical US equity sessions
and studying what happened after them. Filter sessions by price, volume,
momentum, estimated market cap and other features. Compare returns from the
event day's open or close, inspect cumulative returns and drawdown, and explore
forward returns through 40 market sessions. The Charts tab displays market
breadth when a compatible local dataset is available.

## Requirements

- Windows with Microsoft Edge WebView2 Runtime
- Node.js with npm
- Stable Rust with the MSVC toolchain
- Visual Studio Build Tools with the **Desktop development with C++** workload
  and a Windows SDK
- Python 3.11 or later for building or updating data
- A Massive subscription with access to Stocks REST and Stocks Flat Files for
  downloading market data

## Quick start

1. On GitHub, select **Code → Download ZIP** and extract it. Open PowerShell in
   the extracted folder containing `Cargo.toml`.
2. Install the frontend and data pipeline dependencies.

   ```powershell
   npm ci --prefix apps/analytics/frontend
   python -m pip install -r tools/requirements-data.txt
   ```

3. Set your Massive credentials in that PowerShell session. Replace the
   placeholders with the values from your Massive dashboard.

   ```powershell
   $env:MASSIVE_API_KEY = "<REST API key>"
   $env:MASSIVE_S3_ACCESS_KEY = "<Flat Files access key>"
   $env:MASSIVE_S3_SECRET_KEY = "<Flat Files secret key>"
   ```

4. Create a small dataset to check the installation, then launch the desktop app
   from the same PowerShell session.

   ```powershell
   python -m tools.data_pipeline build --start 2025-01-02 --end 2025-01-10
   npm run dev
   ```

5. Open **Settings** in BigCaps. Enter the absolute path to the `data` folder
   created in step 4, then select **Save and load fields**.

The repository contains the source code. Each user creates their own local
dataset. A short date range is enough to check that the app works. Long-lookback
indicators and forward returns become available once there are enough sessions
on either side of the event date.

## Update the dataset

In **Settings → Update market data**, choose **Update to latest session** or
enter a start and end date and select **Download date range**. The app uses the
credentials inherited from the PowerShell session. From the command line, run:

```powershell
python -m tools.data_pipeline update
```

See the [data guide](docs/data.md) for alternate dataset paths, incremental
updates and optional Market Breadth setup. Historical market cap is an
estimate. See the [market cap methodology](docs/market-cap.md) for the data
sources and point-in-time limitations.

## Build a release executable

From the project root, run `npm run tauri:build`. With the default Cargo
target directory, the executable is `target/release/analytics_app.exe`.
The in-app updater uses Python and the source checkout at the path where the
executable was built.

## Project layout

| Path | Purpose |
| --- | --- |
| `apps/analytics/` | React frontend and Tauri desktop shell |
| `crates/` | Rust analytics engine and application commands |
| `tools/` | Data ingestion, daily features and historical market cap |
| `docs/` | Dataset setup and market cap methodology |
| `data/` | Local dataset created by the pipeline and excluded from Git |

## Development checks

```powershell
npm run typecheck --prefix apps/analytics/frontend
cargo test --workspace
python -m pip install pytest
python -m pytest -q tools/daily_features_pipeline
```
