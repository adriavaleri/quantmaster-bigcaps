use std::{fs, path::Path, sync::Arc};

use chrono::{DateTime, Datelike, NaiveDate, Utc};
use polars::prelude::*;
use serde::Serialize;

use crate::error::AnalyticsError;
use crate::splits::SplitIndex;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCandle {
    pub time: String,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
    pub vwap: Option<f64>,
    pub transactions: Option<f64>,
}

pub fn load_m1(
    data_root: &Path,
    ticker: &str,
    date: &str,
) -> Result<Vec<SessionCandle>, AnalyticsError> {
    let ticker = ticker.trim().trim_matches('"').trim_matches('\'').trim();
    let raw_dir = data_root.join("raw").join("m1");
    if !raw_dir.is_dir() {
        return Err(AnalyticsError::StoreMissing {
            path: raw_dir.display().to_string(),
        });
    }
    let year = &date[0..4];
    let month = &date[5..7];
    let mut candles = Vec::new();
    for rank_dir in fs::read_dir(&raw_dir)?.flatten() {
        let path = rank_dir
            .path()
            .join(format!("year={year}"))
            .join(format!("month={month}"))
            .join(format!("{date}.parquet"));
        if !path.is_file() {
            continue;
        }
        let frame = ParquetReader::new(std::fs::File::open(path)?).finish()?;
        let tickers = frame.column("ticker")?.str()?;
        let timestamp_series = frame.column("timestamp")?.cast(&DataType::Int64)?;
        let timestamp = timestamp_series.i64()?;
        let open = frame.column("open")?.f64()?;
        let high = frame.column("high")?.f64()?;
        let low = frame.column("low")?.f64()?;
        let close = frame.column("close")?.f64()?;
        let volume = frame.column("volume")?.f64()?;
        let vwap = frame.column("vwap")?.f64()?;
        let transactions_series = frame.column("transactions")?.cast(&DataType::Float64)?;
        let transactions = transactions_series.f64()?;
        for index in 0..frame.height() {
            if tickers.get(index) != Some(ticker) {
                continue;
            }
            let Some(nanos) = timestamp.get(index) else {
                continue;
            };
            let Some(open) = open.get(index) else {
                continue;
            };
            let Some(high) = high.get(index) else {
                continue;
            };
            let Some(low) = low.get(index) else {
                continue;
            };
            let Some(close) = close.get(index) else {
                continue;
            };
            let Some(volume) = volume.get(index) else {
                continue;
            };
            let seconds = nanos.div_euclid(1_000_000_000);
            let nanos_part = nanos.rem_euclid(1_000_000_000) as u32;
            let time = DateTime::<Utc>::from_timestamp(seconds, nanos_part)
                .map(|value| value.format("%Y-%m-%d %H:%M:%S").to_string())
                .unwrap_or_else(|| date.to_owned());
            candles.push(SessionCandle {
                time,
                open,
                high,
                low,
                close,
                volume,
                vwap: vwap.get(index),
                transactions: transactions.get(index),
            });
        }
    }
    candles.sort_by(|left, right| left.time.cmp(&right.time));
    Ok(candles)
}

pub fn load_daily_ticker_candles(
    data_root: &Path,
    ticker: &str,
    date_to: &str,
) -> Result<Vec<SessionCandle>, AnalyticsError> {
    let ticker = ticker
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim()
        .to_ascii_uppercase();
    let date_to = date_to.trim().trim_matches('"').trim_matches('\'').trim();
    let Ok(parsed_date) = NaiveDate::parse_from_str(date_to, "%Y-%m-%d") else {
        return Ok(Vec::new());
    };
    if ticker.is_empty() {
        return Ok(Vec::new());
    }

    let daily_root = data_root.join("daily");
    if !daily_root.is_dir() {
        return Err(AnalyticsError::StoreMissing {
            path: daily_root.display().to_string(),
        });
    }

    let mut parquet_paths = Vec::new();
    for year_entry in fs::read_dir(&daily_root)? {
        let year_entry = year_entry?;
        if !year_entry.file_type()?.is_dir() {
            continue;
        }
        let year_name = year_entry.file_name().to_string_lossy().into_owned();
        let Some(year) = year_name
            .strip_prefix("year=")
            .and_then(|value| value.parse::<i32>().ok())
        else {
            continue;
        };
        if year > parsed_date.year() {
            continue;
        }
        for month in 1..=12 {
            if year == parsed_date.year() && month > parsed_date.month() {
                continue;
            }
            let path = year_entry.path().join(format!("month={month:02}.parquet"));
            if path.is_file() {
                parquet_paths.push(path);
            }
        }
    }
    if parquet_paths.is_empty() {
        return Ok(Vec::new());
    }

    let cutoff = parsed_date.format("%Y-%m-%d").to_string();
    let split_index = SplitIndex::load(data_root)?;
    let mut schema_groups: Vec<(
        String,
        String,
        String,
        Option<String>,
        Option<String>,
        Vec<PlPath>,
    )> = Vec::new();
    for path in &parquet_paths {
        let mut reader = ParquetReader::new(fs::File::open(path)?);
        let schema = reader.schema()?;
        let schema_key = format!("{schema:?}");
        let columns = schema
            .iter()
            .map(|(name, _)| name.to_string())
            .collect::<Vec<_>>();
        let has_column = |name: &str| columns.iter().any(|column| column == name);
        let date_field = if has_column("date") {
            "date".to_owned()
        } else {
            "timestamp".to_owned()
        };
        let ticker_field = if has_column("ticker") {
            "ticker".to_owned()
        } else {
            "symbol".to_owned()
        };
        let vwap_field = has_column("vwap").then(|| "vwap".to_owned());
        let transactions_field = if has_column("transactions") {
            Some("transactions".to_owned())
        } else if has_column("trades") {
            Some("trades".to_owned())
        } else {
            None
        };
        let parquet_path = PlPath::new(&path.to_string_lossy());
        if let Some((_, _, _, _, _, grouped_paths)) = schema_groups
            .iter_mut()
            .find(|(existing_schema, _, _, _, _, _)| existing_schema.as_str() == schema_key.as_str())
        {
            grouped_paths.push(parquet_path);
        } else {
            schema_groups.push((
                schema_key,
                date_field,
                ticker_field,
                vwap_field,
                transactions_field,
                vec![parquet_path],
            ));
        }
    }

    let mut frames = Vec::with_capacity(schema_groups.len());
    for (_, date_field, ticker_field, vwap_field, transactions_field, grouped_paths) in schema_groups {
        let paths: Arc<[PlPath]> = grouped_paths.into();
        let vwap_expr = vwap_field
            .as_deref()
            .map(|field| col(field).cast(DataType::Float64))
            .unwrap_or_else(|| lit(NULL).cast(DataType::Float64));
        let transactions_expr = transactions_field
            .as_deref()
            .map(|field| col(field).cast(DataType::Float64))
            .unwrap_or_else(|| lit(NULL).cast(DataType::Float64));
        frames.push(
            LazyFrame::scan_parquet_files(paths, ScanArgsParquet::default())?
                .filter(
                    col(&date_field)
                        .cast(DataType::Date)
                        .cast(DataType::String)
                        .lt_eq(lit(cutoff.clone())),
                )
                .filter(
                    col(&ticker_field)
                        .cast(DataType::String)
                        .str()
                        .to_uppercase()
                        .eq(lit(ticker.clone())),
                )
                .select([
                    col(&date_field)
                        .cast(DataType::Date)
                        .cast(DataType::String)
                        .alias("time"),
                    col("open").cast(DataType::Float64),
                    col("high").cast(DataType::Float64),
                    col("low").cast(DataType::Float64),
                    col("close").cast(DataType::Float64),
                    col("volume").cast(DataType::Float64),
                    vwap_expr.alias("vwap"),
                    transactions_expr.alias("transactions"),
                ])
                .collect()?,
        );
    }

    let mut frame_iter = frames.into_iter();
    let Some(mut frame) = frame_iter.next() else {
        return Ok(Vec::new());
    };
    for next_frame in frame_iter {
        frame.vstack_mut(&next_frame)?;
    }

    let times = frame.column("time")?.str()?;
    let open = frame.column("open")?.f64()?;
    let high = frame.column("high")?.f64()?;
    let low = frame.column("low")?.f64()?;
    let close = frame.column("close")?.f64()?;
    let volume = frame.column("volume")?.f64()?;
    let vwap = frame.column("vwap")?.f64()?;
    let transactions = frame.column("transactions")?.f64()?;
    let mut candles = Vec::with_capacity(frame.height());
    for index in 0..frame.height() {
        let (Some(raw_time), Some(open), Some(high), Some(low), Some(close)) = (
            times.get(index),
            open.get(index),
            high.get(index),
            low.get(index),
            close.get(index),
        ) else {
            continue;
        };
        let time = if raw_time.len() >= 10 {
            raw_time[..10].to_owned()
        } else {
            raw_time.to_owned()
        };
        let Ok(bar_date) = NaiveDate::parse_from_str(&time, "%Y-%m-%d") else {
            continue;
        };
        let split_factor = split_index.factor(&ticker, bar_date, parsed_date);
        // Keep historical prices on the selected day's post-split scale.
        let adjusted_vwap = vwap.get(index).map(|value| value / split_factor);
        candles.push(SessionCandle {
            time,
            open: open / split_factor,
            high: high / split_factor,
            low: low / split_factor,
            close: close / split_factor,
            volume: volume.get(index).unwrap_or_default() * split_factor,
            vwap: adjusted_vwap,
            transactions: transactions.get(index),
        });
    }
    candles.sort_by(|left, right| left.time.cmp(&right.time));
    Ok(candles)
}
