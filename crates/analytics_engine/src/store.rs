use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::{self, File},
    io::{BufWriter, Write},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

use chrono::{Datelike, Duration, NaiveDate};
use polars::prelude::*;
use serde::{Deserialize, Serialize};

use crate::error::AnalyticsError;
use crate::splits::SplitIndex;

pub const STORE_DIR_NAME: &str = "session_filter_store";
pub const PROFILE_STORE_DIR_NAME: &str = "session_profile_store";
pub const PROFILE_VALUES_EXTENSION: &str = "bin";
pub const PROFILE_KEYS_EXTENSION: &str = "keys";
const STORE_MANIFEST_NAME: &str = "manifest.json";
const STORE_SCHEMA_VERSION: u32 = 15;

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreBuildReport {
    pub output_dir: PathBuf,
    pub years: Vec<i32>,
    pub rows: u64,
    pub source_files: u64,
    pub manifest_path: PathBuf,
    pub reused: bool,
    pub profile_output_dir: PathBuf,
    pub profile_years: Vec<i32>,
    pub profile_rows: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoreManifest {
    schema_version: u32,
    years: Vec<i32>,
    rows: u64,
    source_files: u64,
    columns: Vec<String>,
    profile_years: Vec<i32>,
    profile_rows: u64,
    profile_columns: Vec<String>,
    sources: Vec<SourceFingerprint>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct SourceFingerprint {
    path: String,
    size: u64,
    modified_unix_ms: u128,
}

#[derive(Debug, Clone)]
pub struct SessionFilterStoreBuilder;

impl SessionFilterStoreBuilder {
    pub fn ensure(data_root: &Path) -> Result<StoreBuildReport, AnalyticsError> {
        let output_dir = data_root.join("runtime").join(STORE_DIR_NAME);
        if let Some(report) = Self::current_report(data_root, &output_dir)? {
            return Ok(report);
        }
        Self::build(data_root, None)
    }

    pub fn current_report(
        data_root: &Path,
        output_dir: &Path,
    ) -> Result<Option<StoreBuildReport>, AnalyticsError> {
        Self::current_report_with_schema(data_root, output_dir, true)
    }

    pub fn current_report_compatible(
        data_root: &Path,
        output_dir: &Path,
    ) -> Result<Option<StoreBuildReport>, AnalyticsError> {
        Self::current_report_with_schema(data_root, output_dir, false)
    }

    fn current_report_with_schema(
        data_root: &Path,
        output_dir: &Path,
        require_current_schema: bool,
    ) -> Result<Option<StoreBuildReport>, AnalyticsError> {
        let manifest_path = output_dir.join(STORE_MANIFEST_NAME);
        let profile_output_dir = data_root.join("runtime").join(PROFILE_STORE_DIR_NAME);
        if !manifest_path.is_file() {
            return Ok(None);
        }
        let manifest: StoreManifest = match serde_json::from_reader(File::open(&manifest_path)?) {
            Ok(manifest) => manifest,
            Err(_) => return Ok(None),
        };
        if (require_current_schema && manifest.schema_version != STORE_SCHEMA_VERSION)
            || (!require_current_schema && manifest.schema_version < 8)
            || manifest.years.is_empty()
            || manifest.columns.is_empty()
            || !manifest
                .years
                .iter()
                .all(|year| output_dir.join(format!("{year}.arrow")).is_file())
            || !manifest.profile_years.iter().all(|year| {
                profile_output_dir.join(format!("{year}.arrow")).is_file()
                    && profile_output_dir
                        .join(format!("{year}.{PROFILE_VALUES_EXTENSION}"))
                        .is_file()
                    && profile_output_dir
                        .join(format!("{year}.{PROFILE_KEYS_EXTENSION}"))
                        .is_file()
            })
        {
            return Ok(None);
        }
        if source_fingerprints(data_root)? != manifest.sources {
            return Ok(None);
        }
        Ok(Some(StoreBuildReport {
            output_dir: output_dir.to_owned(),
            years: manifest.years,
            rows: manifest.rows,
            source_files: manifest.source_files,
            manifest_path,
            reused: true,
            profile_output_dir,
            profile_years: manifest.profile_years,
            profile_rows: manifest.profile_rows,
        }))
    }

    pub fn build(
        data_root: &Path,
        output_dir: Option<&Path>,
    ) -> Result<StoreBuildReport, AnalyticsError> {
        let session_dir = data_root.join("features").join("session_index");
        let liquidity_dir = data_root.join("liquidity_daily");
        let output_dir = output_dir
            .map(PathBuf::from)
            .unwrap_or_else(|| data_root.join("runtime").join(STORE_DIR_NAME));
        let profile_output_dir = data_root.join("runtime").join(PROFILE_STORE_DIR_NAME);

        let mut files_by_year = BTreeMap::<i32, Vec<PathBuf>>::new();
        collect_parquet_files(&session_dir, &mut files_by_year)?;
        if files_by_year.is_empty() {
            return Err(AnalyticsError::StoreMissing {
                path: session_dir.display().to_string(),
            });
        }

        // A rebuild must start from an empty generated store. This prevents
        // stale yearly files, old columns, or an old profile index from being
        // reused after the schema or source data changes.
        if output_dir.is_dir() {
            fs::remove_dir_all(&output_dir)?;
        }
        if profile_output_dir.is_dir() {
            fs::remove_dir_all(&profile_output_dir)?;
        }
        fs::create_dir_all(&output_dir)?;
        let summary_cache = data_root.join("runtime/session_summary_cache");
        if summary_cache.is_dir() {
            fs::remove_dir_all(summary_cache)?;
        }
        let mut total_rows = 0_u64;
        let mut source_files = 0_u64;
        let mut years = Vec::with_capacity(files_by_year.len());
        let mut profile_years = Vec::new();
        let mut sources = Vec::new();
        let mut columns = BTreeMap::<String, ()>::new();
        let mut profile_columns = BTreeMap::<String, ()>::new();
        let mut profile_rows = 0_u64;
        let mut profile_frames_by_year = BTreeMap::<i32, Vec<DataFrame>>::new();
        let mut previous_rth_returns = HashMap::<String, f64>::new();
        let mut previous_ah_metrics = HashMap::<String, AfterHoursMetrics>::new();
        let mut previous_raw_day = HashMap::<String, RawDayMetrics>::new();
        let mut previous_raw_date = None;
        let split_index = SplitIndex::load(data_root)?;
        let split_registry = split_registry_path(data_root);
        if split_registry.is_file() {
            sources.push(source_fingerprint(data_root, &split_registry)?);
        }
        fs::create_dir_all(&profile_output_dir)?;

        for (year, files) in files_by_year {
            let mut frames = Vec::with_capacity(files.len());
            let mut tickers = HashSet::new();

            for session_file in files {
                let date = date_from_file_name(&session_file).ok_or_else(|| {
                    AnalyticsError::InvalidDate {
                        value: session_file.display().to_string(),
                    }
                })?;
                let liquidity_file = liquidity_dir
                    .join(format!("year={}", &date[0..4]))
                    .join(format!("month={}", &date[5..7]))
                    .join(format!("{date}.parquet"));
                if !liquidity_file.is_file() {
                    return Err(AnalyticsError::MissingLiquidityFile {
                        session_file: session_file.display().to_string(),
                    });
                }
                sources.push(source_fingerprint(data_root, &session_file)?);
                sources.push(source_fingerprint(data_root, &liquidity_file)?);
                let profile_file = data_root
                    .join("features/session_timeseries")
                    .join(format!("year={}", &date[0..4]))
                    .join(format!("month={}", &date[5..7]))
                    .join(format!("{date}.parquet"));
                if profile_file.is_file() {
                    sources.push(source_fingerprint(data_root, &profile_file)?);
                }
                for raw_file in raw_day_paths(data_root, &date) {
                    if raw_file.is_file() {
                        sources.push(source_fingerprint(data_root, &raw_file)?);
                    }
                }

                let mut session = read_parquet(&session_file)?;
                let liquidity =
                    read_parquet_columns(&liquidity_file, &["ticker", "liquidity_rank"])?;
                let ranks = liquidity_ranks(&liquidity, &date)?;
                let session_tickers = session
                    .column("ticker")
                    .map_err(|_| AnalyticsError::MissingColumn {
                        dataset: session_file.display().to_string(),
                        column: "ticker".to_owned(),
                    })?
                    .str()?;
                let mut rank_values = Vec::with_capacity(session.height());
                for ticker in session_tickers.into_iter() {
                    let ticker = ticker.ok_or_else(|| AnalyticsError::InvalidFilter {
                        message: format!("null ticker in {}", session_file.display()),
                    })?;
                    tickers.insert(ticker.to_owned());
                    let rank = ranks.get(ticker).copied().ok_or_else(|| {
                        AnalyticsError::MissingLiquidityRank {
                            date: date.clone(),
                            ticker: ticker.to_owned(),
                        }
                    })?;
                    rank_values.push(rank);
                }
                session.with_column(
                    UInt16Chunked::from_iter(rank_values)
                        .with_name("liquidity_rank".into())
                        .into_column(),
                )?;
                let profile = if profile_file.is_file() {
                    Some(normalize_frame(read_parquet(&profile_file)?)?)
                } else {
                    None
                };
                add_overnight_return(&mut session)?;
                if let Some(profile) = profile.as_ref() {
                    add_after_hours_metrics(&mut session, profile, &mut previous_ah_metrics)?;
                } else {
                    add_null_column(&mut session, "ah_prev_return_pct")?;
                    add_null_column(&mut session, "ah_return_pct")?;
                    add_null_column(&mut session, "ah_prev_high_spike_pct")?;
                    add_null_column(&mut session, "ah_prev_low_spike_pct")?;
                    add_null_column(&mut session, "ah_prev_range_pct")?;
                    add_null_column(&mut session, "ah_high_spike_pct")?;
                    add_null_column(&mut session, "ah_low_spike_pct")?;
                    add_null_column(&mut session, "ah_range_pct")?;
                }
                let raw_day = read_raw_day_metrics(data_root, &date)?;
                if !raw_day.is_empty() {
                    let reference_date =
                        NaiveDate::parse_from_str(&date, "%Y-%m-%d").map_err(|_| {
                            AnalyticsError::InvalidDate {
                                value: date.clone(),
                            }
                        })?;
                    add_raw_period_metrics(
                        &mut session,
                        &raw_day,
                        &previous_raw_day,
                        previous_raw_date,
                        reference_date,
                        &split_index,
                    )?;
                    previous_raw_day = raw_day;
                    previous_raw_date = Some(reference_date);
                } else {
                    for field in OPEN_RETURN_FIELDS {
                        add_null_column(&mut session, field)?;
                    }
                }
                frames.push(normalize_frame(session)?);
                source_files += 1;
                if let Some(profile) = profile {
                    profile_rows += profile.height() as u64;
                    for column in profile.get_column_names() {
                        profile_columns.insert(column.to_string(), ());
                    }
                    profile_frames_by_year
                        .entry(year)
                        .or_default()
                        .push(profile);
                }
            }

            let mut frames = frames;
            let mut yearly = frames.remove(0);
            for frame in frames {
                yearly.vstack_mut(&frame)?;
            }
            add_previous_day_change(&mut yearly, &mut previous_rth_returns)?;
            encode_ticker_dictionary(&mut yearly, &tickers)?;
            for column in yearly.get_column_names() {
                columns.insert(column.to_string(), ());
            }
            let rows = yearly.height() as u64;
            let output_file = output_dir.join(format!("{year}.arrow"));
            let temporary_file = output_dir.join(format!(".{year}.arrow.tmp"));
            let mut writer = IpcWriter::new(File::create(&temporary_file)?);
            writer.finish(&mut yearly)?;
            if output_file.is_file() {
                fs::remove_file(&output_file)?;
            }
            fs::rename(temporary_file, output_file)?;
            total_rows += rows;
            years.push(year);
            if let Some(mut profile_frames) = profile_frames_by_year.remove(&year) {
                let mut profile = profile_frames.remove(0);
                for frame in profile_frames {
                    profile.vstack_mut(&frame)?;
                }
                encode_ticker_dictionary(&mut profile, &HashSet::new())?;
                let profile_file = profile_output_dir.join(format!("{year}.arrow"));
                let temporary_profile = profile_output_dir.join(format!(".{year}.arrow.tmp"));
                let mut writer = IpcWriter::new(File::create(&temporary_profile)?);
                writer.finish(&mut profile)?;
                if profile_file.is_file() {
                    fs::remove_file(&profile_file)?;
                }
                fs::rename(temporary_profile, profile_file)?;
                let values_file =
                    profile_output_dir.join(format!("{year}.{PROFILE_VALUES_EXTENSION}"));
                let temporary_values =
                    profile_output_dir.join(format!(".{year}.{PROFILE_VALUES_EXTENSION}.tmp"));
                write_profile_values(&temporary_values, &profile)?;
                if values_file.is_file() {
                    fs::remove_file(&values_file)?;
                }
                fs::rename(temporary_values, values_file)?;
                let keys_file = profile_output_dir.join(format!("{year}.{PROFILE_KEYS_EXTENSION}"));
                let temporary_keys =
                    profile_output_dir.join(format!(".{year}.{PROFILE_KEYS_EXTENSION}.tmp"));
                write_profile_keys(&temporary_keys, &profile)?;
                if keys_file.is_file() {
                    fs::remove_file(&keys_file)?;
                }
                fs::rename(temporary_keys, keys_file)?;
                profile_years.push(year);
            }
        }

        add_next_overnight_columns(&output_dir, &years)?;
        columns.insert("overnight_next_available".to_owned(), ());
        columns.insert("overnight_next_reference_date".to_owned(), ());
        for field in OVERNIGHT_NEXT_NUMERIC_FIELDS {
            columns.insert(format!("overnight_next_{field}"), ());
        }
        for field in OVERNIGHT_NEXT_TEXT_FIELDS {
            columns.insert(format!("overnight_next_{field}"), ());
        }

        sources.sort_by(|left, right| left.path.cmp(&right.path));
        let manifest = StoreManifest {
            schema_version: STORE_SCHEMA_VERSION,
            years: years.clone(),
            rows: total_rows,
            source_files,
            columns: columns.into_keys().collect(),
            profile_years: profile_years.clone(),
            profile_rows,
            profile_columns: profile_columns.into_keys().collect(),
            sources,
        };
        let manifest_path = output_dir.join(STORE_MANIFEST_NAME);
        let temporary_manifest = output_dir.join(format!(".{STORE_MANIFEST_NAME}.tmp"));
        fs::write(&temporary_manifest, serde_json::to_vec_pretty(&manifest)?)?;
        if manifest_path.is_file() {
            fs::remove_file(&manifest_path)?;
        }
        fs::rename(&temporary_manifest, &manifest_path)?;

        Ok(StoreBuildReport {
            output_dir,
            years,
            rows: total_rows,
            source_files,
            manifest_path,
            reused: false,
            profile_output_dir,
            profile_years,
            profile_rows,
        })
    }
}

fn add_previous_day_change(
    frame: &mut DataFrame,
    previous_rth_returns: &mut HashMap<String, f64>,
) -> Result<(), AnalyticsError> {
    let tickers = frame.column("ticker")?.cast(&DataType::String)?;
    let overnight = frame
        .column("overnight_return_pct")
        .or_else(|_| frame.column("overnight_fade_pct"))?
        .cast(&DataType::Float64)?;
    let returns = frame.column("rth_return_pct")?.cast(&DataType::Float64)?;
    let tickers = tickers.str()?;
    let overnight = overnight.f64()?;
    let returns = returns.f64()?;
    let mut previous = Vec::with_capacity(frame.height());
    for index in 0..frame.height() {
        let ticker = tickers.get(index).unwrap_or("");
        previous.push(previous_rth_returns.get(ticker).copied());
        if let (Some(overnight), Some(rth)) = (overnight.get(index), returns.get(index)) {
            if overnight.is_finite() && rth.is_finite() {
                previous_rth_returns.insert(ticker.to_owned(), overnight + rth);
            }
        }
    }
    frame.with_column(
        Float64Chunked::from_iter(previous)
            .with_name("previous_day_change_pct".into())
            .into_column(),
    )?;
    Ok(())
}

fn add_null_column(frame: &mut DataFrame, name: &str) -> Result<(), AnalyticsError> {
    frame.with_column(Series::new(name.into(), vec![None::<f64>; frame.height()]).into_column())?;
    Ok(())
}

fn add_overnight_return(frame: &mut DataFrame) -> Result<(), AnalyticsError> {
    let values = match (frame.column("open"), frame.column("prev_day_close")) {
        (Ok(open), Ok(previous_close)) => {
            let open = open.cast(&DataType::Float64)?;
            let previous_close = previous_close.cast(&DataType::Float64)?;
            open.f64()?
                .into_iter()
                .zip(previous_close.f64()?.into_iter())
                .map(|(open, previous)| match (open, previous) {
                    (Some(open), Some(previous))
                        if open.is_finite() && previous.is_finite() && previous != 0.0 =>
                    {
                        Some((open / previous - 1.0) * 100.0)
                    }
                    _ => None,
                })
                .collect::<Vec<_>>()
        }
        _ => vec![None; frame.height()],
    };
    frame.with_column(
        Float64Chunked::from_iter(values)
            .with_name("overnight_return_pct".into())
            .into_column(),
    )?;
    Ok(())
}

#[derive(Clone, Copy)]
struct AfterHoursMetrics {
    return_pct: f64,
    high_spike_pct: f64,
    low_spike_pct: f64,
    range_pct: f64,
}

fn add_after_hours_metrics(
    session: &mut DataFrame,
    profile: &DataFrame,
    previous_ah_metrics: &mut HashMap<String, AfterHoursMetrics>,
) -> Result<(), AnalyticsError> {
    let profile_tickers = profile.column("ticker")?.cast(&DataType::String)?;
    let profile_tickers = profile_tickers.str()?;
    let baseline = profile
        .column("16:00")
        .or_else(|_| profile.column("16:15"))?
        .cast(&DataType::Float64)?;
    let mut after_hours_names = profile
        .get_column_names()
        .iter()
        .filter_map(|name| {
            let (hour, minute) = name.split_once(':')?;
            let total = hour.parse::<i32>().ok()? * 60 + minute.parse::<i32>().ok()?;
            (total >= 975 && total <= 1200).then_some((total, name.as_str()))
        })
        .collect::<Vec<_>>();
    after_hours_names.sort_by_key(|(total, _)| *total);
    if after_hours_names.is_empty() {
        return Err(AnalyticsError::MissingColumn {
            dataset: "session_timeseries".to_owned(),
            column: "16:15-20:00".to_owned(),
        });
    }
    let after_hours = after_hours_names
        .iter()
        .map(|(_, name)| {
            profile
                .column(name)
                .and_then(|column| column.cast(&DataType::Float64))
        })
        .collect::<PolarsResult<Vec<_>>>()?;
    let mut current_ah = HashMap::<String, AfterHoursMetrics>::new();
    for index in 0..profile.height() {
        let (Some(ticker), Some(start)) = (profile_tickers.get(index), baseline.f64()?.get(index))
        else {
            continue;
        };
        let values = after_hours
            .iter()
            .filter_map(|column| column.f64().ok()?.get(index))
            .filter(|value| value.is_finite())
            .collect::<Vec<_>>();
        let Some(end) = values.last().copied() else {
            continue;
        };
        let (Some(high), Some(low), Some(return_pct)) = (
            values.iter().copied().max_by(f64::total_cmp),
            values.iter().copied().min_by(f64::total_cmp),
            return_between(start, end),
        ) else {
            continue;
        };
        current_ah.insert(
            ticker.to_owned(),
            AfterHoursMetrics {
                return_pct,
                high_spike_pct: high,
                low_spike_pct: low,
                range_pct: high - low,
            },
        );
    }

    let session_tickers = session.column("ticker")?.cast(&DataType::String)?;
    let mut previous_return = Vec::with_capacity(session.height());
    let mut current_return = Vec::with_capacity(session.height());
    let mut previous_high = Vec::with_capacity(session.height());
    let mut previous_low = Vec::with_capacity(session.height());
    let mut previous_range = Vec::with_capacity(session.height());
    let mut current_high = Vec::with_capacity(session.height());
    let mut current_low = Vec::with_capacity(session.height());
    let mut current_range = Vec::with_capacity(session.height());
    for ticker in session_tickers.str()?.into_iter() {
        let previous = ticker.and_then(|ticker| previous_ah_metrics.get(ticker).copied());
        let current = ticker.and_then(|ticker| current_ah.get(ticker).copied());
        previous_return.push(previous.map(|metrics| metrics.return_pct));
        current_return.push(current.map(|metrics| metrics.return_pct));
        previous_high.push(previous.map(|metrics| metrics.high_spike_pct));
        previous_low.push(previous.map(|metrics| metrics.low_spike_pct));
        previous_range.push(previous.map(|metrics| metrics.range_pct));
        current_high.push(current.map(|metrics| metrics.high_spike_pct));
        current_low.push(current.map(|metrics| metrics.low_spike_pct));
        current_range.push(current.map(|metrics| metrics.range_pct));
    }
    for (ticker, value) in &current_ah {
        previous_ah_metrics.insert(ticker.clone(), *value);
    }
    session.with_column(
        Float64Chunked::from_iter(previous_return)
            .with_name("ah_prev_return_pct".into())
            .into_column(),
    )?;
    session.with_column(
        Float64Chunked::from_iter(current_return)
            .with_name("ah_return_pct".into())
            .into_column(),
    )?;
    session.with_column(
        Float64Chunked::from_iter(previous_high)
            .with_name("ah_prev_high_spike_pct".into())
            .into_column(),
    )?;
    session.with_column(
        Float64Chunked::from_iter(previous_low)
            .with_name("ah_prev_low_spike_pct".into())
            .into_column(),
    )?;
    session.with_column(
        Float64Chunked::from_iter(previous_range)
            .with_name("ah_prev_range_pct".into())
            .into_column(),
    )?;
    session.with_column(
        Float64Chunked::from_iter(current_high)
            .with_name("ah_high_spike_pct".into())
            .into_column(),
    )?;
    session.with_column(
        Float64Chunked::from_iter(current_low)
            .with_name("ah_low_spike_pct".into())
            .into_column(),
    )?;
    session.with_column(
        Float64Chunked::from_iter(current_range)
            .with_name("ah_range_pct".into())
            .into_column(),
    )?;
    Ok(())
}

fn return_between(start: f64, end: f64) -> Option<f64> {
    let start_price = 100.0 + start;
    (start_price.is_finite() && start_price != 0.0 && end.is_finite())
        .then_some(((100.0 + end) / start_price - 1.0) * 100.0)
}

#[derive(Clone, Default)]
struct RawPeriodMetrics {
    first_timestamp: Option<i64>,
    last_timestamp: Option<i64>,
    open: Option<f64>,
    close: Option<f64>,
    high: Option<f64>,
    low: Option<f64>,
    high_time: Option<i32>,
    low_time: Option<i32>,
    volume: f64,
    dollar_volume: f64,
    window_timestamps: [Option<i64>; 5],
    window_closes: [Option<f64>; 5],
}

impl RawPeriodMetrics {
    fn adjusted_by(&self, factor: f64) -> Self {
        let mut adjusted = self.clone();
        for value in [
            &mut adjusted.open,
            &mut adjusted.close,
            &mut adjusted.high,
            &mut adjusted.low,
        ] {
            if let Some(price) = *value {
                *value = Some(price / factor);
            }
        }
        for value in &mut adjusted.window_closes {
            if let Some(price) = *value {
                *value = Some(price / factor);
            }
        }
        adjusted.volume *= factor;
        adjusted.dollar_volume = self.dollar_volume;
        adjusted
    }
}

const OPEN_RETURN_WINDOWS: [i32; 5] = [15, 30, 60, 90, 120];

const OPEN_RETURN_FIELDS: [&str; 14] = [
    "ah_open_price",
    "ah_open_m15_return_pct",
    "ah_open_m30_return_pct",
    "ah_open_m60_return_pct",
    "ah_open_m90_return_pct",
    "ah_open_m120_return_pct",
    "pm_open_m15_return_pct",
    "pm_open_m30_return_pct",
    "pm_open_m60_return_pct",
    "pm_open_m90_return_pct",
    "pm_open_m120_return_pct",
    "ah_open_to_close_return_pct",
    "pm_open_to_close_return_pct",
    "ah_close_to_pm_open_return_pct",
];

#[derive(Clone, Default)]
struct RawDayMetrics {
    pm: RawPeriodMetrics,
    rth: RawPeriodMetrics,
    ah: RawPeriodMetrics,
}

impl RawDayMetrics {
    fn adjusted_by(&self, factor: f64) -> Self {
        Self {
            pm: self.pm.adjusted_by(factor),
            rth: self.rth.adjusted_by(factor),
            ah: self.ah.adjusted_by(factor),
        }
    }
}

const RAW_RANK_DIRECTORIES: &[&str] = &[
    "rank_0001_0250",
    "rank_0251_0500",
    "rank_0501_0750",
    "rank_0751_1000",
];

fn raw_day_paths(data_root: &Path, date: &str) -> Vec<PathBuf> {
    RAW_RANK_DIRECTORIES
        .iter()
        .map(|rank| {
            data_root
                .join("raw/m1")
                .join(rank)
                .join(format!("year={}", &date[0..4]))
                .join(format!("month={}", &date[5..7]))
                .join(format!("{date}.parquet"))
        })
        .collect()
}

fn read_raw_day_metrics(
    data_root: &Path,
    date: &str,
) -> Result<HashMap<String, RawDayMetrics>, AnalyticsError> {
    let paths = raw_day_paths(data_root, date);
    if !paths.iter().any(|path| path.is_file()) {
        return Ok(HashMap::new());
    }
    let date =
        NaiveDate::parse_from_str(date, "%Y-%m-%d").map_err(|_| AnalyticsError::InvalidDate {
            value: date.to_owned(),
        })?;
    let offset_minutes = new_york_offset_minutes(date);
    let mut result = HashMap::<String, RawDayMetrics>::new();

    for path in paths {
        if !path.is_file() {
            continue;
        }
        let frame = read_parquet_columns(
            &path,
            &[
                "timestamp",
                "ticker",
                "open",
                "high",
                "low",
                "close",
                "volume",
                "vwap",
            ],
        )?;
        let timestamps = frame.column("timestamp")?.cast(&DataType::Int64)?;
        let tickers = frame.column("ticker")?.cast(&DataType::String)?;
        let opens = optional_float_column(&frame, "open")?;
        let highs = optional_float_column(&frame, "high")?;
        let lows = optional_float_column(&frame, "low")?;
        let closes = optional_float_column(&frame, "close")?;
        let volumes = optional_float_column(&frame, "volume")?;
        let vwaps = optional_float_column(&frame, "vwap")?;
        let timestamps = timestamps.i64()?;
        let tickers = tickers.str()?;

        for index in 0..frame.height() {
            let Some(timestamp) = timestamps.get(index) else {
                continue;
            };
            let Some(ticker) = tickers.get(index) else {
                continue;
            };
            let timestamp = normalize_timestamp_seconds(timestamp);
            let utc_minute = (timestamp.div_euclid(60)).rem_euclid(1_440) as i32;
            let local_minute = (utc_minute + offset_minutes).rem_euclid(1_440);
            let (period, period_start) = if (240..=555).contains(&local_minute) {
                (Some(PeriodKind::Pm), 240)
            } else if (570..=960).contains(&local_minute) {
                (Some(PeriodKind::Rth), 570)
            } else if (975..=1_200).contains(&local_minute) {
                (Some(PeriodKind::Ah), 960)
            } else {
                (None, 0)
            };
            let Some(period) = period else {
                continue;
            };
            let entry = result.entry(ticker.to_owned()).or_default();
            let metrics = match period {
                PeriodKind::Pm => &mut entry.pm,
                PeriodKind::Rth => &mut entry.rth,
                PeriodKind::Ah => &mut entry.ah,
            };
            update_raw_period(
                metrics,
                timestamp,
                local_minute,
                value_at(opens.as_ref(), index),
                value_at(highs.as_ref(), index),
                value_at(lows.as_ref(), index),
                value_at(closes.as_ref(), index),
                value_at(volumes.as_ref(), index),
                value_at(vwaps.as_ref(), index),
                period_start,
            );
        }
    }
    Ok(result)
}

#[derive(Clone, Copy)]
enum PeriodKind {
    Pm,
    Rth,
    Ah,
}

fn optional_float_column(frame: &DataFrame, name: &str) -> Result<Option<Column>, AnalyticsError> {
    frame
        .column(name)
        .ok()
        .map(|column| {
            column
                .cast(&DataType::Float64)
                .map_err(AnalyticsError::from)
        })
        .transpose()
}

fn value_at(column: Option<&Column>, index: usize) -> Option<f64> {
    column
        .and_then(|column| column.f64().ok()?.get(index))
        .filter(|value| value.is_finite())
}

fn normalize_timestamp_seconds(value: i64) -> i64 {
    let absolute = value.unsigned_abs();
    if absolute >= 1_000_000_000_000_000_000 {
        value / 1_000_000_000
    } else if absolute >= 1_000_000_000_000_000 {
        value / 1_000_000
    } else if absolute >= 1_000_000_000_000 {
        value / 1_000
    } else {
        value
    }
}

fn update_raw_period(
    metrics: &mut RawPeriodMetrics,
    timestamp: i64,
    local_minute: i32,
    open: Option<f64>,
    high: Option<f64>,
    low: Option<f64>,
    close: Option<f64>,
    volume: Option<f64>,
    vwap: Option<f64>,
    period_start: i32,
) {
    if let Some(open) = open {
        if metrics
            .first_timestamp
            .is_none_or(|value| timestamp < value)
        {
            metrics.first_timestamp = Some(timestamp);
            metrics.open = Some(open);
        }
    }
    if let Some(close) = close {
        if metrics
            .last_timestamp
            .is_none_or(|value| timestamp >= value)
        {
            metrics.last_timestamp = Some(timestamp);
            metrics.close = Some(close);
        }
        for (index, window) in OPEN_RETURN_WINDOWS.iter().enumerate() {
            if local_minute < period_start + *window
                && metrics.window_timestamps[index].is_none_or(|value| timestamp >= value)
            {
                metrics.window_timestamps[index] = Some(timestamp);
                metrics.window_closes[index] = Some(close);
            }
        }
    }
    if let Some(high) = high {
        if metrics.high.is_none_or(|value| high > value) {
            metrics.high = Some(high);
            metrics.high_time = Some(local_minute);
        }
    }
    if let Some(low) = low {
        if metrics.low.is_none_or(|value| low < value) {
            metrics.low = Some(low);
            metrics.low_time = Some(local_minute);
        }
    }
    if let Some(volume) = volume.filter(|value| *value >= 0.0) {
        metrics.volume += volume;
        if let Some(price) = vwap.or(close) {
            metrics.dollar_volume += price * volume;
        }
    }
}

fn new_york_offset_minutes(date: NaiveDate) -> i32 {
    let march_first = NaiveDate::from_ymd_opt(date.year(), 3, 1).expect("valid March date");
    let november_first = NaiveDate::from_ymd_opt(date.year(), 11, 1).expect("valid November date");
    let march_second_sunday = march_first
        + Duration::days((7 - march_first.weekday().num_days_from_sunday()) as i64 % 7 + 7);
    let november_first_sunday = november_first
        + Duration::days((7 - november_first.weekday().num_days_from_sunday()) as i64 % 7);
    if date >= march_second_sunday && date < november_first_sunday {
        240
    } else {
        300
    }
}

fn percent_change(base: Option<f64>, target: Option<f64>) -> Option<f64> {
    match (base, target) {
        (Some(base), Some(target)) if base.is_finite() && target.is_finite() && base != 0.0 => {
            Some((target / base - 1.0) * 100.0)
        }
        _ => None,
    }
}

fn format_time(value: Option<i32>) -> Option<String> {
    value.map(|minute| format!("{:02}:{:02}", minute / 60, minute % 60))
}

fn add_raw_period_metrics(
    session: &mut DataFrame,
    current: &HashMap<String, RawDayMetrics>,
    previous: &HashMap<String, RawDayMetrics>,
    previous_date: Option<NaiveDate>,
    reference_date: NaiveDate,
    split_index: &SplitIndex,
) -> Result<(), AnalyticsError> {
    let tickers = session.column("ticker")?.cast(&DataType::String)?;
    let mut ah_prev_close = Vec::with_capacity(session.height());
    let mut ah_prev_high_price = Vec::with_capacity(session.height());
    let mut ah_prev_low_price = Vec::with_capacity(session.height());
    let mut ah_prev_vol = Vec::with_capacity(session.height());
    let mut ah_prev_dollar_vol = Vec::with_capacity(session.height());
    let mut ah_prev_return = Vec::with_capacity(session.height());
    let mut ah_prev_high_spike = Vec::with_capacity(session.height());
    let mut ah_prev_low_spike = Vec::with_capacity(session.height());
    let mut ah_prev_range = Vec::with_capacity(session.height());
    let mut ah_prev_fade = Vec::with_capacity(session.height());
    let mut ah_prev_high_time = Vec::with_capacity(session.height());
    let mut ah_prev_low_time = Vec::with_capacity(session.height());
    let mut ah_prev_hod_lod = Vec::with_capacity(session.height());
    let mut ah_open_price = Vec::with_capacity(session.height());
    let mut ah_close = Vec::with_capacity(session.height());
    let mut ah_high_price = Vec::with_capacity(session.height());
    let mut ah_low_price = Vec::with_capacity(session.height());
    let mut ah_vol = Vec::with_capacity(session.height());
    let mut ah_dollar_vol = Vec::with_capacity(session.height());
    let mut ah_return = Vec::with_capacity(session.height());
    let mut ah_high_spike = Vec::with_capacity(session.height());
    let mut ah_low_spike = Vec::with_capacity(session.height());
    let mut ah_range = Vec::with_capacity(session.height());
    let mut ah_high_time = Vec::with_capacity(session.height());
    let mut ah_low_time = Vec::with_capacity(session.height());
    let mut ah_hod_lod = Vec::with_capacity(session.height());
    let mut overnight_high_price = Vec::with_capacity(session.height());
    let mut overnight_low_price = Vec::with_capacity(session.height());
    let mut overnight_high_spike = Vec::with_capacity(session.height());
    let mut overnight_low_spike = Vec::with_capacity(session.height());
    let mut overnight_range = Vec::with_capacity(session.height());
    let mut overnight_high_time = Vec::with_capacity(session.height());
    let mut overnight_low_time = Vec::with_capacity(session.height());
    let mut overnight_hod_lod = Vec::with_capacity(session.height());
    let mut overnight_vol = Vec::with_capacity(session.height());
    let mut overnight_dollar_vol = Vec::with_capacity(session.height());
    let mut pm_open = Vec::with_capacity(session.height());
    let mut pm_close = Vec::with_capacity(session.height());
    let mut pm_high = Vec::with_capacity(session.height());
    let mut pm_low = Vec::with_capacity(session.height());
    let mut pm_low_spike = Vec::with_capacity(session.height());
    let mut pm_hod_lod = Vec::with_capacity(session.height());
    let mut pm_position = Vec::with_capacity(session.height());
    let mut pm_fade_open = Vec::with_capacity(session.height());
    let mut pm_fade_close = Vec::with_capacity(session.height());
    let mut pm_high_time = Vec::with_capacity(session.height());
    let mut pm_low_time = Vec::with_capacity(session.height());
    let mut ah_open_returns: [Vec<Option<f64>>; 5] =
        std::array::from_fn(|_| Vec::with_capacity(session.height()));
    let mut pm_open_returns: [Vec<Option<f64>>; 5] =
        std::array::from_fn(|_| Vec::with_capacity(session.height()));
    let mut ah_open_to_close_return = Vec::with_capacity(session.height());
    let mut pm_open_to_close_return = Vec::with_capacity(session.height());
    let mut ah_close_to_pm_open_return = Vec::with_capacity(session.height());

    let session_open = session
        .column("open")
        .ok()
        .and_then(|column| column.cast(&DataType::Float64).ok());
    let session_close = session
        .column("close")
        .ok()
        .and_then(|column| column.cast(&DataType::Float64).ok());
    let session_prev_close = session
        .column("prev_day_close")
        .ok()
        .and_then(|column| column.cast(&DataType::Float64).ok());
    let session_open = session_open.as_ref().and_then(|column| column.f64().ok());
    let session_close = session_close.as_ref().and_then(|column| column.f64().ok());
    let session_prev_close = session_prev_close
        .as_ref()
        .and_then(|column| column.f64().ok());

    for index in 0..session.height() {
        let ticker = tickers.str()?.get(index).unwrap_or("");
        let day = current.get(ticker);
        let prior = previous.get(ticker).cloned().unwrap_or_default();
        let prior = previous_date
            .map(|date| prior.adjusted_by(split_index.factor(ticker, date, reference_date)))
            .unwrap_or(prior);
        let pm = day.map(|day| &day.pm).cloned().unwrap_or_default();
        let rth = day.map(|day| &day.rth).cloned().unwrap_or_default();
        let ah = day.map(|day| &day.ah).cloned().unwrap_or_default();
        let prior_rth = prior.rth;
        let prior_ah = prior.ah;
        let rth_open = rth
            .open
            .or_else(|| session_open.and_then(|values| values.get(index)));
        let rth_close = rth
            .close
            .or_else(|| session_close.and_then(|values| values.get(index)));
        let prev_close = prior_rth
            .close
            .or_else(|| session_prev_close.and_then(|values| values.get(index)));

        ah_prev_close.push(prior_ah.close);
        ah_prev_high_price.push(prior_ah.high);
        ah_prev_low_price.push(prior_ah.low);
        ah_prev_vol.push((prior_ah.volume > 0.0).then_some(prior_ah.volume));
        ah_prev_dollar_vol.push((prior_ah.dollar_volume > 0.0).then_some(prior_ah.dollar_volume));
        ah_prev_return.push(percent_change(prior_rth.close, prior_ah.close));
        ah_prev_high_spike.push(percent_change(prior_rth.close, prior_ah.high));
        ah_prev_low_spike.push(percent_change(prior_rth.close, prior_ah.low));
        ah_prev_range.push(
            percent_change(prior_rth.close, prior_ah.high)
                .zip(percent_change(prior_rth.close, prior_ah.low))
                .map(|(high, low)| high - low),
        );
        ah_prev_fade.push(percent_change(prior_ah.high, pm.open));
        ah_prev_high_time.push(format_time(prior_ah.high_time));
        ah_prev_low_time.push(format_time(prior_ah.low_time));
        ah_prev_hod_lod.push(
            prior_ah
                .high_time
                .zip(prior_ah.low_time)
                .map(|(high, low)| (high - low).abs() as f64),
        );

        ah_open_price.push(ah.open);
        ah_close.push(ah.close);
        ah_high_price.push(ah.high);
        ah_low_price.push(ah.low);
        ah_vol.push((ah.volume > 0.0).then_some(ah.volume));
        ah_dollar_vol.push((ah.dollar_volume > 0.0).then_some(ah.dollar_volume));
        ah_return.push(percent_change(rth_close, ah.close));
        ah_high_spike.push(percent_change(rth_close, ah.high));
        ah_low_spike.push(percent_change(rth_close, ah.low));
        ah_range.push(
            percent_change(rth_close, ah.high)
                .zip(percent_change(rth_close, ah.low))
                .map(|(high, low)| high - low),
        );
        ah_high_time.push(format_time(ah.high_time));
        ah_low_time.push(format_time(ah.low_time));
        ah_hod_lod.push(
            ah.high_time
                .zip(ah.low_time)
                .map(|(high, low)| (high - low).abs() as f64),
        );

        let overnight_high = prior_ah
            .high
            .into_iter()
            .chain(pm.high)
            .max_by(f64::total_cmp);
        let overnight_low = prior_ah
            .low
            .into_iter()
            .chain(pm.low)
            .min_by(f64::total_cmp);
        let high_time = match (prior_ah.high, prior_ah.high_time, pm.high, pm.high_time) {
            (Some(previous_high), Some(previous_time), Some(current_high), Some(current_time))
                if current_high > previous_high =>
            {
                Some(current_time)
            }
            (Some(_), Some(previous_time), _, _) => Some(previous_time),
            (_, _, Some(_), current_time) => current_time,
            _ => None,
        };
        let low_time = match (prior_ah.low, prior_ah.low_time, pm.low, pm.low_time) {
            (Some(previous_low), Some(previous_time), Some(current_low), Some(current_time))
                if current_low < previous_low =>
            {
                Some(current_time)
            }
            (Some(_), Some(previous_time), _, _) => Some(previous_time),
            (_, _, Some(_), current_time) => current_time,
            _ => None,
        };
        overnight_high_price.push(overnight_high);
        overnight_low_price.push(overnight_low);
        overnight_high_spike.push(percent_change(prev_close, overnight_high));
        overnight_low_spike.push(percent_change(prev_close, overnight_low));
        overnight_range.push(
            percent_change(prev_close, overnight_high)
                .zip(percent_change(prev_close, overnight_low))
                .map(|(high, low)| high - low),
        );
        overnight_high_time.push(format_time(high_time));
        overnight_low_time.push(format_time(low_time));
        overnight_hod_lod.push(
            high_time
                .zip(low_time)
                .map(|(high, low)| (high - low).abs() as f64),
        );
        overnight_vol
            .push((prior_ah.volume + pm.volume > 0.0).then_some(prior_ah.volume + pm.volume));
        overnight_dollar_vol.push(
            (prior_ah.dollar_volume + pm.dollar_volume > 0.0)
                .then_some(prior_ah.dollar_volume + pm.dollar_volume),
        );

        pm_open.push(pm.open);
        pm_close.push(pm.close);
        pm_high.push(pm.high);
        pm_low.push(pm.low);
        pm_low_spike.push(percent_change(rth_open, pm.low));
        pm_hod_lod.push(
            pm.high_time
                .zip(pm.low_time)
                .map(|(high, low)| (high - low).abs() as f64),
        );
        pm_position.push(
            rth_open
                .zip(pm.high)
                .zip(pm.low)
                .and_then(|((open, high), low)| {
                    (high > low).then_some((open - low) / (high - low))
                }),
        );
        pm_fade_open.push(percent_change(pm.high, rth_open));
        pm_fade_close.push(percent_change(pm.high, rth_close));
        pm_high_time.push(format_time(pm.high_time));
        pm_low_time.push(format_time(pm.low_time));
        ah_open_to_close_return.push(percent_change(ah.open, ah.close));
        pm_open_to_close_return.push(percent_change(pm.open, pm.close));
        ah_close_to_pm_open_return.push(percent_change(ah.close, pm.open));
        for window_index in 0..OPEN_RETURN_WINDOWS.len() {
            ah_open_returns[window_index]
                .push(percent_change(ah.open, ah.window_closes[window_index]));
            pm_open_returns[window_index]
                .push(percent_change(pm.open, pm.window_closes[window_index]));
        }
    }

    for (name, values) in [
        ("ah_prev_close_price", ah_prev_close),
        ("ah_prev_high_price", ah_prev_high_price),
        ("ah_prev_low_price", ah_prev_low_price),
        ("ah_prev_vol", ah_prev_vol),
        ("ah_prev_dollar_vol", ah_prev_dollar_vol),
        ("ah_prev_return_pct", ah_prev_return),
        ("ah_prev_high_spike_pct", ah_prev_high_spike),
        ("ah_prev_low_spike_pct", ah_prev_low_spike),
        ("ah_prev_range_pct", ah_prev_range),
        ("ah_prev_high_fade_to_pm_open_pct", ah_prev_fade),
        ("ah_prev_hod_to_lod_minutes", ah_prev_hod_lod),
        ("ah_open_price", ah_open_price),
        ("ah_close_price", ah_close),
        ("ah_high_price", ah_high_price),
        ("ah_low_price", ah_low_price),
        ("ah_vol", ah_vol),
        ("ah_dollar_vol", ah_dollar_vol),
        ("ah_return_pct", ah_return),
        ("ah_high_spike_pct", ah_high_spike),
        ("ah_low_spike_pct", ah_low_spike),
        ("ah_range_pct", ah_range),
        ("ah_hod_to_lod_minutes", ah_hod_lod),
        ("overnight_high_price", overnight_high_price),
        ("overnight_low_price", overnight_low_price),
        ("overnight_high_spike_pct", overnight_high_spike),
        ("overnight_low_spike_pct", overnight_low_spike),
        ("overnight_range_pct", overnight_range),
        ("overnight_hod_to_lod_minutes", overnight_hod_lod),
        ("overnight_vol", overnight_vol),
        ("overnight_dollar_vol", overnight_dollar_vol),
        ("pm_open_price", pm_open),
        ("pm_close_price", pm_close),
        ("pm_high_price", pm_high),
        ("pm_low_price", pm_low),
        ("pm_low_spike_pct", pm_low_spike),
        ("pm_hod_to_lod_minutes", pm_hod_lod),
        ("open_position_in_pm_range", pm_position),
        ("pmh_fade_to_open_pct", pm_fade_open),
        ("pmh_fade_to_close_pct", pm_fade_close),
    ] {
        session.with_column(
            Float64Chunked::from_iter(values)
                .with_name(name.into())
                .into_column(),
        )?;
    }
    for (window_index, window) in OPEN_RETURN_WINDOWS.iter().enumerate() {
        let ah_name = format!("ah_open_m{window}_return_pct");
        let pm_name = format!("pm_open_m{window}_return_pct");
        session.with_column(
            Float64Chunked::from_iter(std::mem::take(&mut ah_open_returns[window_index]))
                .with_name(ah_name.into())
                .into_column(),
        )?;
        session.with_column(
            Float64Chunked::from_iter(std::mem::take(&mut pm_open_returns[window_index]))
                .with_name(pm_name.into())
                .into_column(),
        )?;
    }
    for (name, values) in [
        ("ah_open_to_close_return_pct", ah_open_to_close_return),
        ("pm_open_to_close_return_pct", pm_open_to_close_return),
        ("ah_close_to_pm_open_return_pct", ah_close_to_pm_open_return),
    ] {
        session.with_column(
            Float64Chunked::from_iter(values)
                .with_name(name.into())
                .into_column(),
        )?;
    }
    for (name, values) in [
        ("ah_prev_high_time", ah_prev_high_time),
        ("ah_prev_low_time", ah_prev_low_time),
        ("ah_high_time", ah_high_time),
        ("ah_low_time", ah_low_time),
        ("overnight_high_time", overnight_high_time),
        ("overnight_low_time", overnight_low_time),
        ("pm_high_time", pm_high_time),
        ("pm_low_time", pm_low_time),
    ] {
        session.with_column(Series::new(name.into(), values).into_column())?;
    }
    Ok(())
}

const PROFILE_VALUES_MAGIC: &[u8; 8] = b"QMPROF01";
const PROFILE_KEYS_MAGIC: &[u8; 8] = b"QMKEY001";
const PROFILE_KEY_RECORD_SIZE: usize = 32;
const PROFILE_TICKER_BYTES: usize = PROFILE_KEY_RECORD_SIZE - 6;

fn write_profile_values(path: &Path, frame: &DataFrame) -> Result<(), AnalyticsError> {
    let columns = frame
        .get_columns()
        .iter()
        .skip(2)
        .map(|column| column.cast(&DataType::Float64))
        .collect::<PolarsResult<Vec<_>>>()?;
    let mut file = BufWriter::new(File::create(path)?);
    file.write_all(PROFILE_VALUES_MAGIC)?;
    file.write_all(&(columns.len() as u32).to_le_bytes())?;
    file.write_all(&(frame.height() as u64).to_le_bytes())?;
    let values = columns
        .iter()
        .map(|column| column.f64())
        .collect::<PolarsResult<Vec<_>>>()?;
    let mut buffer = Vec::with_capacity(1024 * 1024);
    for row in 0..frame.height() {
        for column in &values {
            buffer.extend_from_slice(&column.get(row).unwrap_or(f64::NAN).to_le_bytes());
            if buffer.len() >= 1024 * 1024 {
                file.write_all(&buffer)?;
                buffer.clear();
            }
        }
    }
    if !buffer.is_empty() {
        file.write_all(&buffer)?;
    }
    file.flush()?;
    Ok(())
}

fn write_profile_keys(path: &Path, frame: &DataFrame) -> Result<(), AnalyticsError> {
    let dates = frame.column("reference_date")?.date()?.physical();
    let tickers = frame.column("ticker")?.cast(&DataType::String)?;
    let mut file = BufWriter::new(File::create(path)?);
    file.write_all(PROFILE_KEYS_MAGIC)?;
    file.write_all(&(frame.height() as u64).to_le_bytes())?;
    for (date, ticker) in dates.into_iter().zip(tickers.str()?.into_iter()) {
        let ticker = ticker.unwrap_or("").as_bytes();
        if ticker.len() > PROFILE_TICKER_BYTES {
            return Err(AnalyticsError::InvalidFilter {
                message: "ticker is too long for profile key index".to_owned(),
            });
        }
        file.write_all(&date.unwrap_or(i32::MIN).to_le_bytes())?;
        file.write_all(&(ticker.len() as u16).to_le_bytes())?;
        let mut fixed = [0_u8; PROFILE_TICKER_BYTES];
        fixed[..ticker.len()].copy_from_slice(ticker);
        file.write_all(&fixed)?;
    }
    file.flush()?;
    Ok(())
}

// These columns describe the overnight period that starts after the current
// RTH row. The regular columns keep their historical meaning for RTH and the
// data explorer; the overnight screen opts into these aligned copies.
const OVERNIGHT_NEXT_NUMERIC_FIELDS: &[&str] = &[
    "prev_day_close",
    "open_gap_pct",
    "pm_open",
    "pmh",
    "pml",
    "pm_open_price",
    "pm_close_price",
    "pm_high_price",
    "pm_low_price",
    "pm_low_spike_pct",
    "pm_hod_to_lod_minutes",
    "pm_open_to_close_return_pct",
    "open_position_in_pm_range",
    "pmh_fade_to_open_pct",
    "pmh_fade_to_close_pct",
    "pmh_fade_pct",
    "pmh_gap_pct",
    "pm_return_pct",
    "pm_open_m15_return_pct",
    "pm_open_m30_return_pct",
    "pm_open_m60_return_pct",
    "pm_open_m90_return_pct",
    "pm_open_m120_return_pct",
    "pm_high_spike_pct",
    "pm_vol",
    "pm_dollar_vol",
    "ah_prev_close_price",
    "ah_close_price",
    "ah_open_to_close_return_pct",
    "ah_close_to_pm_open_return_pct",
    "ah_prev_high_price",
    "ah_prev_low_price",
    "ah_prev_vol",
    "ah_prev_dollar_vol",
    "ah_prev_return_pct",
    "ah_prev_high_spike_pct",
    "ah_prev_low_spike_pct",
    "ah_prev_range_pct",
    "ah_prev_high_fade_to_pm_open_pct",
    "ah_prev_hod_to_lod_minutes",
    "ah_open_price",
    "overnight_high_price",
    "overnight_low_price",
    "overnight_high_spike_pct",
    "overnight_low_spike_pct",
    "overnight_range_pct",
    "overnight_hod_to_lod_minutes",
    "overnight_vol",
    "overnight_dollar_vol",
    "overnight_return_pct",
    "overnight_session_return_pct",
];

const OVERNIGHT_NEXT_TEXT_FIELDS: &[&str] = &[
    "pm_high_time",
    "pm_low_time",
    "ah_prev_high_time",
    "ah_prev_low_time",
    "overnight_high_time",
    "overnight_low_time",
];

fn add_next_overnight_columns(output_dir: &Path, years: &[i32]) -> Result<(), AnalyticsError> {
    let mut frames = Vec::with_capacity(years.len());
    let mut row_refs = Vec::with_capacity(years.len());
    let mut by_ticker = HashMap::<String, Vec<(i32, usize, usize)>>::new();

    for (frame_index, year) in years.iter().enumerate() {
        let path = output_dir.join(format!("{year}.arrow"));
        let reader = IpcReader::new(File::open(&path)?).memory_mapped(Some(path.clone()));
        let frame = reader.finish()?;
        let dates = frame.column("reference_date")?.date()?.physical();
        let tickers = frame.column("ticker")?.cast(&DataType::String)?;
        for (row, (date, ticker)) in dates
            .into_iter()
            .zip(tickers.str()?.into_iter())
            .enumerate()
        {
            if let (Some(date), Some(ticker)) = (date, ticker) {
                by_ticker
                    .entry(ticker.to_owned())
                    .or_default()
                    .push((date, frame_index, row));
            }
        }
        row_refs.push(vec![None; frame.height()]);
        frames.push(frame);
    }

    for rows in by_ticker.values_mut() {
        rows.sort_by_key(|(date, _, _)| *date);
        for pair in rows.windows(2) {
            let (_, current_frame, current_row) = pair[0];
            let (_, next_frame, next_row) = pair[1];
            row_refs[current_frame][current_row] = Some((next_frame, next_row));
        }
    }

    for (frame_index, year) in years.iter().enumerate() {
        let mut frame = frames[frame_index].clone();
        let refs = &row_refs[frame_index];
        let source_dates = frames
            .iter()
            .map(|source| {
                source
                    .column("reference_date")?
                    .date()
                    .map(|dates| dates.physical().to_vec())
            })
            .collect::<PolarsResult<Vec<_>>>()?;
        let next_dates = refs.iter().map(|reference| {
            reference.and_then(|(source_frame, source_row)| {
                source_dates[source_frame]
                    .get(source_row)
                    .copied()
                    .flatten()
            })
        });
        frame.with_column(
            Int32Chunked::from_iter(next_dates)
                .cast(&DataType::Date)?
                .with_name("overnight_next_reference_date".into()),
        )?;
        let available = refs.iter().map(Option::is_some);
        frame.with_column(
            BooleanChunked::from_iter(available)
                .with_name("overnight_next_available".into())
                .into_column(),
        )?;

        for field in OVERNIGHT_NEXT_NUMERIC_FIELDS {
            if *field == "ah_close_to_pm_open_return_pct" {
                let current_ah_close = frame
                    .column("ah_close_price")
                    .ok()
                    .and_then(|column| column.cast(&DataType::Float64).ok())
                    .and_then(|column| {
                        column
                            .f64()
                            .ok()
                            .map(|values| values.into_iter().collect::<Vec<_>>())
                    });
                let next_pm_open = frames
                    .iter()
                    .map(|source| {
                        source
                            .column("pm_open_price")
                            .ok()
                            .and_then(|column| column.cast(&DataType::Float64).ok())
                            .and_then(|column| {
                                column
                                    .f64()
                                    .ok()
                                    .map(|values| values.into_iter().collect::<Vec<_>>())
                            })
                    })
                    .collect::<Vec<_>>();
                let cross_date_values = refs.iter().enumerate().map(|(current_row, reference)| {
                    let ah_close = current_ah_close
                        .as_ref()
                        .and_then(|values| values.get(current_row).copied().flatten());
                    let pm_open = reference.and_then(|(source_frame, source_row)| {
                        next_pm_open[source_frame]
                            .as_ref()
                            .and_then(|values| values.get(source_row).copied().flatten())
                    });
                    ah_close.zip(pm_open).and_then(|(ah_close, pm_open)| {
                        percent_change(Some(ah_close), Some(pm_open))
                    })
                });
                frame.with_column(
                    Float64Chunked::from_iter(cross_date_values)
                        .with_name(format!("overnight_next_{field}").into())
                        .into_column(),
                )?;
                continue;
            }
            if *field == "overnight_session_return_pct" {
                let current_ah_open = frame
                    .column("ah_open_price")
                    .ok()
                    .and_then(|column| column.cast(&DataType::Float64).ok())
                    .and_then(|column| {
                        column
                            .f64()
                            .ok()
                            .map(|values| values.into_iter().collect::<Vec<_>>())
                    });
                let next_pm_close = frames
                    .iter()
                    .map(|source| {
                        source
                            .column("pm_close_price")
                            .ok()
                            .and_then(|column| column.cast(&DataType::Float64).ok())
                            .and_then(|column| {
                                column
                                    .f64()
                                    .ok()
                                    .map(|values| values.into_iter().collect::<Vec<_>>())
                            })
                    })
                    .collect::<Vec<_>>();
                let cross_date_values = refs.iter().enumerate().map(|(current_row, reference)| {
                    let ah_open = current_ah_open
                        .as_ref()
                        .and_then(|values| values.get(current_row).copied().flatten());
                    let pm_close = reference.and_then(|(source_frame, source_row)| {
                        next_pm_close[source_frame]
                            .as_ref()
                            .and_then(|values| values.get(source_row).copied().flatten())
                    });
                    ah_open.zip(pm_close).and_then(|(ah_open, pm_close)| {
                        percent_change(Some(ah_open), Some(pm_close))
                    })
                });
                frame.with_column(
                    Float64Chunked::from_iter(cross_date_values)
                        .with_name(format!("overnight_next_{field}").into())
                        .into_column(),
                )?;
                continue;
            }
            let values = frames
                .iter()
                .map(|source| {
                    source
                        .column(field)
                        .ok()
                        .and_then(|column| column.cast(&DataType::Float64).ok())
                        .and_then(|column| column.f64().ok().cloned())
                })
                .collect::<Vec<_>>();
            let next_values = refs.iter().map(|reference| {
                reference.and_then(|(source_frame, source_row)| {
                    values[source_frame]
                        .as_ref()
                        .and_then(|column| column.get(source_row))
                })
            });
            frame.with_column(
                Float64Chunked::from_iter(next_values)
                    .with_name(format!("overnight_next_{field}").into())
                    .into_column(),
            )?;
        }
        for field in OVERNIGHT_NEXT_TEXT_FIELDS {
            let values = frames
                .iter()
                .map(|source| {
                    source
                        .column(field)
                        .ok()
                        .and_then(|column| column.cast(&DataType::String).ok())
                        .and_then(|column| column.str().ok().cloned())
                })
                .collect::<Vec<_>>();
            let next_values = refs.iter().map(|reference| {
                reference.and_then(|(source_frame, source_row)| {
                    values[source_frame]
                        .as_ref()
                        .and_then(|column| column.get(source_row).map(str::to_owned))
                })
            });
            frame.with_column(
                StringChunked::from_iter(next_values)
                    .with_name(format!("overnight_next_{field}").into())
                    .into_column(),
            )?;
        }

        let path = output_dir.join(format!("{year}.arrow"));
        let temporary = output_dir.join(format!(".{year}.arrow.next.tmp"));
        let mut writer = IpcWriter::new(File::create(&temporary)?);
        writer.finish(&mut frame)?;
        if path.is_file() {
            fs::remove_file(&path)?;
        }
        fs::rename(temporary, path)?;
    }
    Ok(())
}

fn source_fingerprints(data_root: &Path) -> Result<Vec<SourceFingerprint>, AnalyticsError> {
    let session_dir = data_root.join("features").join("session_index");
    let liquidity_dir = data_root.join("liquidity_daily");
    let mut session_files = BTreeMap::<i32, Vec<PathBuf>>::new();
    collect_parquet_files(&session_dir, &mut session_files)?;
    if session_files.is_empty() {
        return Ok(Vec::new());
    }
    let mut fingerprints = Vec::new();
    let split_registry = split_registry_path(data_root);
    if split_registry.is_file() {
        fingerprints.push(source_fingerprint(data_root, &split_registry)?);
    }
    for files in session_files.values() {
        for session_file in files {
            let date =
                date_from_file_name(session_file).ok_or_else(|| AnalyticsError::InvalidDate {
                    value: session_file.display().to_string(),
                })?;
            let liquidity_file = liquidity_dir
                .join(format!("year={}", &date[0..4]))
                .join(format!("month={}", &date[5..7]))
                .join(format!("{date}.parquet"));
            if !liquidity_file.is_file() {
                return Err(AnalyticsError::MissingLiquidityFile {
                    session_file: session_file.display().to_string(),
                });
            }
            fingerprints.push(source_fingerprint(data_root, session_file)?);
            fingerprints.push(source_fingerprint(data_root, &liquidity_file)?);
            let profile_file = data_root
                .join("features/session_timeseries")
                .join(format!("year={}", &date[0..4]))
                .join(format!("month={}", &date[5..7]))
                .join(format!("{date}.parquet"));
            if profile_file.is_file() {
                fingerprints.push(source_fingerprint(data_root, &profile_file)?);
            }
            for raw_file in raw_day_paths(data_root, &date) {
                if raw_file.is_file() {
                    fingerprints.push(source_fingerprint(data_root, &raw_file)?);
                }
            }
        }
    }
    fingerprints.sort_by(|left, right| left.path.cmp(&right.path));
    Ok(fingerprints)
}

fn split_registry_path(data_root: &Path) -> PathBuf {
    data_root
        .join("reference")
        .join("corporate_actions")
        .join("splits")
        .join("latest_splits.parquet")
}

fn source_fingerprint(data_root: &Path, path: &Path) -> Result<SourceFingerprint, AnalyticsError> {
    let metadata = fs::metadata(path)?;
    let modified_unix_ms = metadata
        .modified()
        .unwrap_or(UNIX_EPOCH)
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let relative = path
        .strip_prefix(data_root)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/");
    Ok(SourceFingerprint {
        path: relative,
        size: metadata.len(),
        modified_unix_ms,
    })
}

fn collect_parquet_files(
    root: &Path,
    by_year: &mut BTreeMap<i32, Vec<PathBuf>>,
) -> Result<(), AnalyticsError> {
    if !root.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(root)? {
        let path = entry?.path();
        if path.is_dir() {
            collect_parquet_files(&path, by_year)?;
        } else if path
            .extension()
            .is_some_and(|extension| extension == "parquet")
        {
            if let Some(date) = date_from_file_name(&path) {
                let year = date[0..4]
                    .parse::<i32>()
                    .map_err(|_| AnalyticsError::InvalidDate {
                        value: date.clone(),
                    })?;
                by_year.entry(year).or_default().push(path);
            }
        }
    }
    for files in by_year.values_mut() {
        files.sort();
    }
    Ok(())
}

pub(crate) fn date_from_file_name(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    (stem.len() == 10
        && stem.as_bytes()[4] == b'-'
        && stem.as_bytes()[7] == b'-'
        && stem.as_bytes()[..4].iter().all(u8::is_ascii_digit)
        && stem.as_bytes()[5..7].iter().all(u8::is_ascii_digit)
        && stem.as_bytes()[8..].iter().all(u8::is_ascii_digit))
    .then(|| stem.to_owned())
}

fn read_parquet(path: &Path) -> Result<DataFrame, AnalyticsError> {
    ParquetReader::new(File::open(path)?)
        .finish()
        .map_err(AnalyticsError::from)
}

fn read_parquet_columns(path: &Path, columns: &[&str]) -> Result<DataFrame, AnalyticsError> {
    let mut reader = ParquetReader::new(File::open(path)?);
    reader = reader.with_columns(Some(
        columns.iter().map(|column| (*column).to_owned()).collect(),
    ));
    reader.finish().map_err(AnalyticsError::from)
}

fn liquidity_ranks(
    frame: &DataFrame,
    date: &str,
) -> Result<HashMap<String, Option<u16>>, AnalyticsError> {
    let tickers = frame.column("ticker")?.str()?;
    let ranks = frame.column("liquidity_rank")?.i64()?;
    let mut result = HashMap::with_capacity(frame.height());
    for (ticker, rank) in tickers.into_iter().zip(ranks.into_iter()) {
        let ticker = ticker.ok_or_else(|| AnalyticsError::InvalidFilter {
            message: format!("null ticker in liquidity_daily for {date}"),
        })?;
        let rank = rank
            .map(|rank| {
                u16::try_from(rank).map_err(|_| AnalyticsError::LiquidityRankOutOfRange {
                    date: date.to_owned(),
                    ticker: ticker.to_owned(),
                    rank,
                })
            })
            .transpose()?;
        result.insert(ticker.to_owned(), rank);
    }
    Ok(result)
}

fn normalize_frame(frame: DataFrame) -> Result<DataFrame, AnalyticsError> {
    let Some(reference_date) = frame.column("reference_date").ok() else {
        return Err(AnalyticsError::MissingColumn {
            dataset: "session store source".to_owned(),
            column: "reference_date".to_owned(),
        });
    };
    if !matches!(reference_date.dtype(), DataType::String) {
        return Ok(frame);
    }
    frame
        .lazy()
        .with_column(
            col("reference_date")
                .str()
                .strptime(
                    DataType::Date,
                    StrptimeOptions {
                        format: Some("%Y-%m-%d".into()),
                        strict: true,
                        exact: true,
                        cache: true,
                    },
                    lit("raise"),
                )
                .alias("reference_date"),
        )
        .collect()
        .map_err(AnalyticsError::from)
}

fn encode_ticker_dictionary(
    frame: &mut DataFrame,
    tickers: &HashSet<String>,
) -> Result<(), AnalyticsError> {
    let _ = tickers;
    let categories = Categories::new(
        "ticker".into(),
        "session_filter_store".into(),
        CategoricalPhysical::U32,
    );
    let dtype = DataType::from_categories(categories);
    let ticker = frame
        .column("ticker")?
        .as_materialized_series()
        .cast(&dtype)?;
    frame.replace("ticker", ticker)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{SessionCondition, SessionFilterConfig, SessionSelector};
    use polars::df;
    use tempfile::tempdir;

    #[test]
    fn builds_arrow_store_and_filters_without_m1() -> Result<(), Box<dyn std::error::Error>> {
        let temp = tempdir()?;
        let data_root = temp.path().join("data");
        let session_dir = data_root.join("features/session_index/year=2024/month=01");
        let liquidity_dir = data_root.join("liquidity_daily/year=2024/month=01");
        fs::create_dir_all(&session_dir)?;
        fs::create_dir_all(&liquidity_dir)?;

        let mut sessions = df![
            "reference_date" => &["2024-01-02", "2024-01-02", "2024-01-02"],
            "ticker" => &["AAA", "BBB", "CCC"],
            "open_gap_pct" => &[6.0, 8.0, 7.0],
            "pm_vol" => &[2_000_000.0, 2_000_000.0, 500_000.0],
            "overnight_fade_pct" => &[0.5, 1.0, -1.0],
            "rth_return_pct" => &[1.0, -2.0, 3.0],
        ]?;
        ParquetWriter::new(File::create(session_dir.join("2024-01-02.parquet"))?)
            .finish(&mut sessions)?;

        let mut liquidity = df![
            "ticker" => &["AAA", "BBB", "CCC"],
            "liquidity_rank" => &[1_i64, 600_i64, 2_i64],
        ]?;
        ParquetWriter::new(File::create(liquidity_dir.join("2024-01-02.parquet"))?)
            .finish(&mut liquidity)?;

        let report = SessionFilterStoreBuilder::build(&data_root, None)?;
        SessionFilterStoreBuilder::build(&data_root, None)?;
        assert_eq!(report.years, vec![2024]);
        assert_eq!(report.rows, 3);
        let reused = SessionFilterStoreBuilder::ensure(&data_root)?;
        assert!(reused.reused);
        assert!(reused.manifest_path.is_file());
        assert!(data_root
            .join("runtime/session_filter_store/2024.arrow")
            .is_file());

        let config = SessionFilterConfig {
            date_from: "2024-01-01".to_owned(),
            date_to: "2024-01-31".to_owned(),
            liquidity_top: Some(500),
            ticker: None,
            analysis_mode: None,
            min_tickers_per_day: None,
            max_tickers_per_day: None,
            conditions: vec![SessionCondition {
                field_id: "open_gap_pct".to_owned(),
                operator: "gte".to_owned(),
                value: crate::FilterValue::Number(5.0),
                lookback_days: None,
            }],
        };
        let preview = SessionSelector::preview(&data_root, &config)?;
        assert_eq!(preview.matched_sessions, 2);
        assert_eq!(preview.files_scanned, 1);

        let mut single_ticker_config = config.clone();
        single_ticker_config.ticker = Some("BBB".to_owned());
        let single_ticker = SessionSelector::preview(&data_root, &single_ticker_config)?;
        assert_eq!(single_ticker.matched_sessions, 1);

        let selected = SessionSelector::select_keys(&data_root, &config)?;
        assert_eq!(selected.session_keys.unwrap()[0].ticker, "AAA");
        let rows = SessionSelector::rows(&data_root, &config, "AAA", "date", true, 1, 20)?;
        assert_eq!(rows.total, 1);
        assert_eq!(
            rows.rows[0].get("open_gap_pct").map(String::as_str),
            Some("6.0")
        );
        let mut bounded_config = config.clone();
        bounded_config.min_tickers_per_day = Some(2);
        bounded_config.max_tickers_per_day = Some(2);
        let bounded = SessionSelector::preview(&data_root, &bounded_config)?;
        assert_eq!(bounded.matched_sessions, 2);
        let mut capped_config = config;
        capped_config.min_tickers_per_day = None;
        capped_config.max_tickers_per_day = Some(1);
        let capped = SessionSelector::preview(&data_root, &capped_config)?;
        assert_eq!(capped.matched_sessions, 0);
        Ok(())
    }

    #[test]
    fn derives_previous_day_change_per_ticker() -> Result<(), Box<dyn std::error::Error>> {
        let mut frame = df![
            "reference_date" => &[
                "2024-01-02", "2024-01-02", "2024-01-03", "2024-01-03"
            ],
            "ticker" => &["AAA", "BBB", "AAA", "BBB"],
            "overnight_fade_pct" => &[1.0, -1.0, 2.0, 0.5],
            "rth_return_pct" => &[4.0, -2.0, 1.0, 3.0],
        ]?;
        let mut previous = HashMap::new();
        add_previous_day_change(&mut frame, &mut previous)?;
        let values = frame.column("previous_day_change_pct")?.f64()?;
        assert!(values.get(0).is_none());
        assert!(values.get(1).is_none());
        assert_eq!(values.get(2), Some(5.0));
        assert_eq!(values.get(3), Some(-3.0));
        Ok(())
    }

    #[test]
    fn filters_on_change_over_trading_days() -> Result<(), Box<dyn std::error::Error>> {
        let temp = tempdir()?;
        let data_root = temp.path().join("data");
        for (date, close) in [
            ("2024-01-02", 100.0),
            ("2024-01-03", 110.0),
            ("2024-01-04", 120.0),
        ] {
            let session_dir = data_root.join(format!("features/session_index/year=2024/month=01"));
            let liquidity_dir = data_root.join("liquidity_daily/year=2024/month=01");
            fs::create_dir_all(&session_dir)?;
            fs::create_dir_all(&liquidity_dir)?;
            let mut sessions = df![
                "reference_date" => &[date],
                "ticker" => &["AAA"],
                "close" => &[close],
                "open_gap_pct" => &[1.0],
                "pm_vol" => &[2_000_000.0],
                "overnight_fade_pct" => &[0.5],
                "rth_return_pct" => &[1.0],
            ]?;
            ParquetWriter::new(File::create(session_dir.join(format!("{date}.parquet")))?)
                .finish(&mut sessions)?;
            let mut liquidity = df![
                "ticker" => &["AAA"],
                "liquidity_rank" => &[1_i64],
            ]?;
            ParquetWriter::new(File::create(liquidity_dir.join(format!("{date}.parquet")))?)
                .finish(&mut liquidity)?;
        }
        SessionFilterStoreBuilder::build(&data_root, None)?;
        let config = SessionFilterConfig {
            date_from: "2024-01-01".to_owned(),
            date_to: "2024-01-31".to_owned(),
            liquidity_top: Some(500),
            ticker: None,
            analysis_mode: None,
            min_tickers_per_day: None,
            max_tickers_per_day: None,
            conditions: vec![SessionCondition {
                field_id: "change_pct".to_owned(),
                operator: "gte".to_owned(),
                value: crate::FilterValue::Number(5.0),
                lookback_days: Some(1),
            }],
        };
        let rows = SessionSelector::rows(&data_root, &config, "", "date", false, 1, 20)?;
        assert_eq!(rows.total, 1);
        assert_eq!(
            rows.rows[0].get("change_pct").map(String::as_str),
            Some("10.0")
        );
        assert_eq!(
            rows.rows[0].get("reference_date").map(String::as_str),
            Some("2024-01-04")
        );
        Ok(())
    }
}
