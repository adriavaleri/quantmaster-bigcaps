use std::{
    collections::{BTreeMap, BTreeSet, HashMap, HashSet, VecDeque},
    fs::{self, File},
    io::{BufReader, Read},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::Instant,
};

use chrono::{Datelike, Duration, NaiveDate};
use memmap2::MmapOptions;
use polars::prelude::*;
use serde::{de::DeserializeOwned, Deserialize, Serialize};
use std::hash::{Hash, Hasher};

use crate::{
    error::AnalyticsError,
    store::{
        PROFILE_KEYS_EXTENSION, PROFILE_STORE_DIR_NAME, PROFILE_VALUES_EXTENSION, STORE_DIR_NAME,
    },
};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFilterConfig {
    pub date_from: String,
    pub date_to: String,
    #[serde(default)]
    pub liquidity_top: Option<u16>,
    #[serde(default)]
    pub ticker: Option<String>,
    #[serde(default)]
    pub analysis_mode: Option<String>,
    #[serde(default)]
    pub max_tickers_per_day: Option<u32>,
    #[serde(default)]
    pub min_tickers_per_day: Option<u32>,
    #[serde(default)]
    pub conditions: Vec<SessionCondition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCondition {
    pub field_id: String,
    pub operator: String,
    pub value: FilterValue,
    #[serde(default)]
    pub lookback_days: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(untagged)]
pub enum FilterValue {
    Number(f64),
    Text(String),
    Boolean(bool),
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionKey {
    pub reference_date: String,
    pub ticker: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionSelectionResult {
    pub matched_sessions: u64,
    pub files_scanned: u64,
    pub elapsed_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_keys: Option<Vec<SessionKey>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub summary: Option<SessionAnalyticsSummary>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCountResult {
    pub matched_sessions: u64,
    pub files_scanned: u64,
    pub elapsed_ms: u64,
    pub operable_days: u64,
    pub market_days: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionOverviewResult {
    pub matched_sessions: u64,
    pub files_scanned: u64,
    pub elapsed_ms: u64,
    pub operable_days: u64,
    pub market_days: u64,
    pub summary: SessionAnalyticsSummary,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRowsResult {
    pub rows: Vec<BTreeMap<String, String>>,
    pub total: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionAnalyticsSummary {
    pub count: u64,
    pub avg: BTreeMap<String, f64>,
    pub p25: BTreeMap<String, f64>,
    pub median: BTreeMap<String, f64>,
    pub p75: BTreeMap<String, f64>,
    pub distribution_buckets: BTreeMap<String, Vec<SessionDistributionBucket>>,
    pub distribution_averages: BTreeMap<String, f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTimingSummary {
    pub distribution_buckets: BTreeMap<String, Vec<SessionDistributionBucket>>,
    pub distribution_averages: BTreeMap<String, f64>,
    pub avg: BTreeMap<String, f64>,
    pub p25: BTreeMap<String, f64>,
    pub median: BTreeMap<String, f64>,
    pub p75: BTreeMap<String, f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDistributionBucket {
    pub label: String,
    pub count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHeatmapCell {
    pub bucket_index: usize,
    pub time_index: usize,
    pub count: u64,
    pub average_return: Option<f64>,
    pub median_return: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHeatmapResult {
    pub cells: Vec<SessionHeatmapCell>,
    pub included_observations: u64,
    pub x_labels: Vec<String>,
    pub y_labels: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionReturnTrendPoint {
    pub year: i32,
    pub bucket: String,
    pub count: u64,
    pub average_return: Option<f64>,
    pub median_return: Option<f64>,
    pub total_return: Option<f64>,
    pub cumulative_return: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionReturnTrendResult {
    pub field: String,
    pub points: Vec<SessionReturnTrendPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIntradayReturnPoint {
    pub minute: i32,
    pub time: String,
    pub phase: String,
    pub count: u64,
    pub average_return: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionIntradayReturnResult {
    pub points: Vec<SessionIntradayReturnPoint>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTickerReturnBucket {
    pub label: String,
    pub days: u64,
    pub average_return: Option<f64>,
    pub average_tickers: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTickerReturnResult {
    pub field: String,
    pub buckets: Vec<SessionTickerReturnBucket>,
    pub operable_days: u64,
    pub market_days: u64,
}

#[derive(Debug, Clone)]
pub struct CompiledFilterPlan {
    predicate: Expr,
    required_columns: Vec<String>,
    description: String,
    rolling_change_days: Option<u32>,
    max_tickers_per_day: Option<u32>,
    min_tickers_per_day: Option<u32>,
    overnight_alignment: bool,
}

impl CompiledFilterPlan {
    pub fn description(&self) -> &str {
        &self.description
    }
}

pub struct SessionSelector;

impl SessionSelector {
    pub fn compile(config: &SessionFilterConfig) -> Result<CompiledFilterPlan, AnalyticsError> {
        let from = parse_date(&config.date_from)?;
        let to = parse_date(&config.date_to)?;
        if from > to {
            return Err(AnalyticsError::InvalidFilter {
                message: "dateFrom must be on or before dateTo".to_owned(),
            });
        }
        if config.liquidity_top == Some(0) {
            return Err(AnalyticsError::InvalidFilter {
                message: "liquidityTop must be greater than zero".to_owned(),
            });
        }
        if config.max_tickers_per_day == Some(0) {
            return Err(AnalyticsError::InvalidFilter {
                message: "maxTickersPerDay must be greater than zero".to_owned(),
            });
        }
        if config.min_tickers_per_day == Some(0) {
            return Err(AnalyticsError::InvalidFilter {
                message: "minTickersPerDay must be greater than zero".to_owned(),
            });
        }
        if let (Some(min), Some(max)) = (config.min_tickers_per_day, config.max_tickers_per_day) {
            if min > max {
                return Err(AnalyticsError::InvalidFilter {
                    message: "minTickersPerDay cannot be greater than maxTickersPerDay".to_owned(),
                });
            }
        }

        let mut required_columns = BTreeSet::from([
            "reference_date".to_owned(),
            "ticker".to_owned(),
            "liquidity_rank".to_owned(),
        ]);
        let mut predicates = vec![
            date_predicate(&config.date_from, ">=")?,
            date_predicate(&config.date_to, "<=")?,
        ];
        let mut description = vec![
            format!("reference_date >= {}", config.date_from),
            format!("reference_date <= {}", config.date_to),
        ];
        let mut rolling_change_days = None;
        let overnight_alignment = config
            .analysis_mode
            .as_deref()
            .is_some_and(|mode| mode.eq_ignore_ascii_case("overnight"));
        if overnight_alignment {
            required_columns.insert("overnight_next_available".to_owned());
            required_columns.insert("overnight_next_reference_date".to_owned());
            // The overnight window starts with the current session's AH and
            // ends with the next session's PM/open. Keep both baselines
            // available for the cross-date profile.
            required_columns.insert("rth_return_pct".to_owned());
            required_columns.insert("overnight_next_open_gap_pct".to_owned());
            predicates.push(col("overnight_next_available").eq(lit(true)));
            description.push("next overnight period available".to_owned());
        }

        if let Some(ticker) = config
            .ticker
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
        {
            predicates.push(col("ticker").eq(lit(ticker.to_owned())));
            description.push(format!("ticker = {ticker}"));
        } else if let Some(top) = config.liquidity_top {
            predicates.push(col("liquidity_rank").lt_eq(lit(top as u16)));
            description.push(format!("liquidity_rank <= {top}"));
        }
        if let Some(max) = config.max_tickers_per_day {
            description.push(format!("daily_ticker_count <= {max}"));
        }
        if let Some(min) = config.min_tickers_per_day {
            description.push(format!("daily_ticker_count >= {min}"));
        }

        for condition in &config.conditions {
            let field = canonical_field(&condition.field_id).ok_or_else(|| {
                AnalyticsError::InvalidFilter {
                    message: format!(
                        "unsupported fieldId '{}'; it is not in the session store",
                        condition.field_id
                    ),
                }
            })?;
            let predicate_field = overnight_predicate_field(field, overnight_alignment);
            if field != "reference_date" && field != "change_pct" {
                required_columns.insert(predicate_field.to_owned());
            }
            if field == "change_pct" {
                let days =
                    condition
                        .lookback_days
                        .ok_or_else(|| AnalyticsError::InvalidFilter {
                            message: "change_pct requires lookbackDays".to_owned(),
                        })?;
                if days == 0 || days > 5_000 {
                    return Err(AnalyticsError::InvalidFilter {
                        message: "change_pct lookbackDays must be between 1 and 5000".to_owned(),
                    });
                }
                if let Some(previous_days) = rolling_change_days {
                    if previous_days != days {
                        return Err(AnalyticsError::InvalidFilter {
                            message: "all change_pct filters must use the same lookbackDays"
                                .to_owned(),
                        });
                    }
                } else {
                    rolling_change_days = Some(days);
                }
                required_columns.insert("close".to_owned());
            }
            let (expression, rendered) = compile_condition(&predicate_field, condition)?;
            predicates.push(expression);
            description.push(rendered);
        }

        let predicate = predicates
            .into_iter()
            .reduce(|left, right| left.and(right))
            .expect("date range always adds predicates");
        Ok(CompiledFilterPlan {
            predicate,
            required_columns: required_columns.into_iter().collect(),
            description: description.join(" AND "),
            rolling_change_days,
            max_tickers_per_day: config.max_tickers_per_day,
            min_tickers_per_day: config.min_tickers_per_day,
            overnight_alignment,
        })
    }

    pub fn preview(
        data_root: &Path,
        config: &SessionFilterConfig,
    ) -> Result<SessionSelectionResult, AnalyticsError> {
        Self::select(data_root, config, false)
    }

    pub fn count_matches(
        data_root: &Path,
        config: &SessionFilterConfig,
    ) -> Result<SessionCountResult, AnalyticsError> {
        let cache_path = cache_path(data_root, "count_v2", config)?;
        if let Some(result) = read_cache(&cache_path)? {
            return Ok(result);
        }
        let started = Instant::now();
        let plan = Self::compile(config)?;
        let store_dir = data_root.join("runtime").join(STORE_DIR_NAME);
        let mut matched_sessions = 0_u64;
        let mut files_scanned = 0_u64;
        let mut operable_dates = HashSet::<i32>::new();
        let mut market_dates = HashSet::<i32>::new();
        for year in years_between(&config.date_from, &config.date_to)? {
            let path = store_dir.join(format!("{year}.arrow"));
            if !path.is_file() {
                return Err(AnalyticsError::StoreMissing {
                    path: path.display().to_string(),
                });
            }
            files_scanned += 1;
            for date in read_market_day_dates(&path)? {
                market_dates.insert(date);
            }
            let filtered = read_filtered_ipc(data_root, &path, &plan, true)?;
            matched_sessions += filtered.height() as u64;
            for date in filtered.column("reference_date")?.date()?.physical() {
                if let Some(date) = date {
                    operable_dates.insert(date);
                }
            }
        }
        let result = SessionCountResult {
            matched_sessions,
            files_scanned,
            elapsed_ms: started.elapsed().as_millis() as u64,
            operable_days: operable_dates.len() as u64,
            market_days: market_dates.len() as u64,
        };
        write_cache(&cache_path, &result)?;
        Ok(result)
    }

    pub fn summary(
        data_root: &Path,
        config: &SessionFilterConfig,
    ) -> Result<SessionAnalyticsSummary, AnalyticsError> {
        let cache_path = cache_path(data_root, "summary_v2", config)?;
        if let Some(summary) = read_cache(&cache_path)? {
            return Ok(summary);
        }
        let summary = Self::select(data_root, config, false)?
            .summary
            .unwrap_or_else(|| summarize_values(0, BTreeMap::new()));
        write_cache(&cache_path, &summary)?;
        Ok(summary)
    }

    pub fn overview(
        data_root: &Path,
        config: &SessionFilterConfig,
    ) -> Result<SessionOverviewResult, AnalyticsError> {
        let cache_path = cache_path(data_root, "overview_v2", config)?;
        if let Some(result) = read_cache(&cache_path)? {
            return Ok(result);
        }
        let started = Instant::now();
        let plan = Self::compile(config)?;
        let from = parse_date(&config.date_from)?.num_days_from_ce() - 719_163;
        let to = parse_date(&config.date_to)?.num_days_from_ce() - 719_163;
        let store_dir = data_root.join("runtime").join(STORE_DIR_NAME);
        let mut files_scanned = 0_u64;
        let mut matched_sessions = 0_u64;
        let mut operable_dates = HashSet::<i32>::new();
        let mut market_dates = HashSet::<i32>::new();
        let mut values = BTreeMap::<String, Vec<f64>>::new();

        for year in years_between(&config.date_from, &config.date_to)? {
            let path = store_dir.join(format!("{year}.arrow"));
            if !path.is_file() {
                return Err(AnalyticsError::StoreMissing {
                    path: path.display().to_string(),
                });
            }
            files_scanned += 1;
            let (frame, file_market_dates) = read_overview_ipc(data_root, &path, &plan, from, to)?;
            market_dates.extend(file_market_dates);
            matched_sessions += frame.height() as u64;
            for date in frame.column("reference_date")?.date()?.physical() {
                if let Some(date) = date {
                    operable_dates.insert(date);
                }
            }
            collect_numeric_values(&frame, &mut values)?;
        }

        let summary = summarize_values(matched_sessions, values);
        let result = SessionOverviewResult {
            matched_sessions,
            files_scanned,
            elapsed_ms: started.elapsed().as_millis() as u64,
            operable_days: operable_dates.len() as u64,
            market_days: market_dates.len() as u64,
            summary,
        };
        write_cache(&cache_path, &result)?;
        Ok(result)
    }

    pub fn return_trend(
        data_root: &Path,
        config: &SessionFilterConfig,
        return_field: &str,
        granularity: &str,
    ) -> Result<SessionReturnTrendResult, AnalyticsError> {
        let granularity = normalize_trend_granularity(granularity)?;
        let field = canonical_field(return_field).ok_or_else(|| AnalyticsError::InvalidFilter {
            message: format!("unsupported return field '{return_field}'"),
        })?;
        if !SUMMARY_COLUMNS.contains(&field) {
            return Err(AnalyticsError::InvalidFilter {
                message: format!(
                    "return field '{return_field}' is not available in the session store"
                ),
            });
        }
        // The v3 cache uses interpolated percentiles for bucket medians.
        let cache_path = cache_path(
            data_root,
            &format!("trend_v3_{granularity}_{field}"),
            config,
        )?;
        if let Some(result) = read_cache(&cache_path)? {
            return Ok(result);
        }
        let plan = Self::compile(config)?;
        let store_dir = data_root.join("runtime").join(STORE_DIR_NAME);
        let mut grouped = BTreeMap::<String, Vec<f64>>::new();
        for year in years_between(&config.date_from, &config.date_to)? {
            let path = store_dir.join(format!("{year}.arrow"));
            if !path.is_file() {
                return Err(AnalyticsError::StoreMissing {
                    path: path.display().to_string(),
                });
            }
            let frame = read_trend_ipc(data_root, &path, &plan, field)?;
            let dates = frame.column("reference_date")?.date()?.physical();
            let values_column = frame.column(field)?.cast(&DataType::Float64)?;
            let values = values_column.f64()?;
            for (date, value) in dates.into_iter().zip(values.into_iter()) {
                let (Some(date), Some(value)) = (date, value.filter(|value| value.is_finite()))
                else {
                    continue;
                };
                let date =
                    NaiveDate::from_num_days_from_ce_opt(date + 719_163).ok_or_else(|| {
                        AnalyticsError::InvalidDate {
                            value: format!("invalid trend date {date}"),
                        }
                    })?;
                grouped
                    .entry(trend_bucket(date, granularity))
                    .or_default()
                    .push(value);
            }
        }
        let mut cumulative_return = 0.0;
        let points = grouped
            .into_iter()
            .map(|(bucket, mut values)| {
                values.sort_by(f64::total_cmp);
                let count = values.len() as u64;
                let total_return = (count > 0).then(|| values.iter().sum::<f64>());
                let average_return = total_return.map(|total| total / count as f64);
                let median_return = (count > 0).then(|| quantile(&mut values, 0.5));
                if let Some(total) = total_return {
                    cumulative_return += total;
                }
                let year = bucket[..4].parse::<i32>().unwrap_or_default();
                SessionReturnTrendPoint {
                    year,
                    bucket,
                    count,
                    average_return,
                    median_return,
                    total_return,
                    cumulative_return: (count > 0).then_some(cumulative_return),
                }
            })
            .collect();
        let result = SessionReturnTrendResult {
            field: field.to_owned(),
            points,
        };
        write_cache(&cache_path, &result)?;
        Ok(result)
    }

    pub fn intraday_return_profile(
        data_root: &Path,
        config: &SessionFilterConfig,
    ) -> Result<SessionIntradayReturnResult, AnalyticsError> {
        let cache_path = cache_path(data_root, "intraday_return_profile_15m_v4", config)?;
        if let Some(result) = read_cache(&cache_path)? {
            return Ok(result);
        }

        let plan = Self::compile(config)?;
        let years = years_between(&config.date_from, &config.date_to)?;
        let store_dir = data_root.join("runtime").join(STORE_DIR_NAME);
        let mut wanted = BTreeMap::<i32, BTreeSet<String>>::new();
        let mut overnight_pairs = Vec::<(i32, i32, String, f64, f64)>::new();

        for year in &years {
            let path = store_dir.join(format!("{year}.arrow"));
            if !path.is_file() {
                return Err(AnalyticsError::StoreMissing {
                    path: path.display().to_string(),
                });
            }
            let frame = read_filtered_ipc(data_root, &path, &plan, true)?;
            let dates = frame.column("reference_date")?.date()?.physical();
            let next_dates = frame
                .column("overnight_next_reference_date")
                .ok()
                .and_then(|column| column.date().ok());
            let tickers = frame.column("ticker")?.cast(&DataType::String)?;
            let rth_returns = frame
                .column("rth_return_pct")
                .ok()
                .and_then(|column| column.cast(&DataType::Float64).ok());
            let next_open_gaps = frame
                .column("overnight_next_open_gap_pct")
                .ok()
                .and_then(|column| column.cast(&DataType::Float64).ok());
            for (index, (date, ticker)) in dates
                .into_iter()
                .zip(tickers.str()?.into_iter())
                .enumerate()
            {
                if let (Some(date), Some(ticker)) = (date, ticker) {
                    if plan.overnight_alignment {
                        let Some(next_date) = next_dates
                            .as_ref()
                            .and_then(|values| values.physical().get(index))
                        else {
                            continue;
                        };
                        let Some(rth_return) = rth_returns
                            .as_ref()
                            .and_then(|column| column.f64().ok())
                            .and_then(|values| values.get(index))
                        else {
                            continue;
                        };
                        let Some(next_open_gap) = next_open_gaps
                            .as_ref()
                            .and_then(|column| column.f64().ok())
                            .and_then(|values| values.get(index))
                        else {
                            continue;
                        };
                        wanted.entry(date).or_default().insert(ticker.to_owned());
                        wanted
                            .entry(next_date)
                            .or_default()
                            .insert(ticker.to_owned());
                        overnight_pairs.push((
                            date,
                            next_date,
                            ticker.to_owned(),
                            rth_return,
                            next_open_gap,
                        ));
                    } else {
                        wanted.entry(date).or_default().insert(ticker.to_owned());
                    }
                }
            }
        }

        let profile_dir = data_root.join("runtime").join(PROFILE_STORE_DIR_NAME);
        let profile_years = wanted
            .keys()
            .filter_map(|date| NaiveDate::from_num_days_from_ce_opt(*date + 719_163))
            .map(|date| date.year())
            .collect::<BTreeSet<_>>();
        let profile_available = !years.is_empty()
            && profile_years.iter().all(|year| {
                profile_dir.join(format!("{year}.arrow")).is_file()
                    && profile_dir
                        .join(format!("{year}.{PROFILE_VALUES_EXTENSION}"))
                        .is_file()
                    && profile_dir
                        .join(format!("{year}.{PROFILE_KEYS_EXTENSION}"))
                        .is_file()
            });
        let mut values = BTreeMap::<i32, Vec<f64>>::new();

        if profile_available {
            let mut profile_rows = HashMap::<(i32, String), Vec<(i32, f64)>>::new();
            let previous_wanted = BTreeMap::new();
            for year in &profile_years {
                collect_timing_profile_values(
                    &profile_dir.join(format!("{year}.arrow")),
                    &profile_dir.join(format!("{year}.{PROFILE_KEYS_EXTENSION}")),
                    &profile_dir.join(format!("{year}.{PROFILE_VALUES_EXTENSION}")),
                    &wanted,
                    &previous_wanted,
                    &mut profile_rows,
                )?;
            }
            if plan.overnight_alignment {
                for (date, next_date, ticker, rth_return, next_open_gap) in overnight_pairs {
                    if let Some(points) = profile_rows.get(&(date, ticker.clone())) {
                        for (minute, value) in points.iter().filter(|(minute, _)| *minute >= 975) {
                            if let Some(value) =
                                overnight_return_from_rth_open(*value, rth_return, None)
                            {
                                values.entry(*minute).or_default().push(value);
                            }
                        }
                    }
                    if let Some(points) = profile_rows.get(&(next_date, ticker)) {
                        for (minute, value) in points.iter().filter(|(minute, _)| *minute < 570) {
                            if let Some(value) =
                                overnight_return_from_rth_open(*value, 0.0, Some(next_open_gap))
                            {
                                values.entry(*minute).or_default().push(value);
                            }
                        }
                    }
                }
            } else {
                for (date, tickers) in wanted {
                    for ticker in tickers {
                        if let Some(points) = profile_rows.get(&(date, ticker)) {
                            for (minute, value) in points {
                                if (570..=960).contains(minute) {
                                    values.entry(*minute).or_default().push(*value);
                                }
                            }
                        }
                    }
                }
            }
        } else {
            collect_intraday_return_values_legacy(
                data_root,
                &wanted,
                plan.overnight_alignment,
                &mut values,
            )?;
        }

        let points = intraday_minutes(plan.overnight_alignment)
            .into_iter()
            .filter_map(|minute| {
                let values = values.remove(&minute)?;
                let phase = intraday_phase(minute, plan.overnight_alignment).to_owned();
                let time = if plan.overnight_alignment {
                    format!("{phase} {}", format_minutes(minute))
                } else {
                    format_minutes(minute)
                };
                Some(SessionIntradayReturnPoint {
                    minute,
                    time,
                    phase,
                    count: values.len() as u64,
                    average_return: mean(&values),
                })
            })
            .collect();
        let result = SessionIntradayReturnResult { points };
        write_cache(&cache_path, &result)?;
        Ok(result)
    }

    pub fn ticker_return_distribution(
        data_root: &Path,
        config: &SessionFilterConfig,
        return_field: &str,
    ) -> Result<SessionTickerReturnResult, AnalyticsError> {
        let field = canonical_field(return_field).ok_or_else(|| AnalyticsError::InvalidFilter {
            message: format!("unsupported return field '{return_field}'"),
        })?;
        if !SUMMARY_COLUMNS.contains(&field) {
            return Err(AnalyticsError::InvalidFilter {
                message: format!(
                    "return field '{return_field}' is not available in the session store"
                ),
            });
        }
        let cache_path = cache_path(data_root, &format!("ticker_return_v2_{field}"), config)?;
        if let Some(result) = read_cache(&cache_path)? {
            return Ok(result);
        }

        let plan = Self::compile(config)?;
        let store_dir = data_root.join("runtime").join(STORE_DIR_NAME);
        let mut daily = BTreeMap::<i32, (HashSet<String>, f64, u64)>::new();
        let mut market_dates = HashSet::<i32>::new();

        for year in years_between(&config.date_from, &config.date_to)? {
            let path = store_dir.join(format!("{year}.arrow"));
            if !path.is_file() {
                return Err(AnalyticsError::StoreMissing {
                    path: path.display().to_string(),
                });
            }

            let mut market_reader =
                IpcReader::new(File::open(&path)?).memory_mapped(Some(path.clone()));
            market_reader = market_reader.with_columns(Some(vec!["reference_date".to_owned()]));
            let market_frame = market_reader.finish()?;
            for date in market_frame.column("reference_date")?.date()?.physical() {
                if let Some(date) = date {
                    market_dates.insert(date);
                }
            }

            let frame = read_ticker_return_ipc(data_root, &path, &plan, field)?;
            let dates = frame.column("reference_date")?.date()?.physical();
            let tickers = frame.column("ticker")?.cast(&DataType::String)?;
            let values = frame.column(field)?.cast(&DataType::Float64)?;
            for ((date, ticker), value) in dates
                .into_iter()
                .zip(tickers.str()?.into_iter())
                .zip(values.f64()?.into_iter())
            {
                let (Some(date), Some(ticker), Some(value)) = (date, ticker, value) else {
                    continue;
                };
                if !value.is_finite() {
                    continue;
                }
                let entry = daily
                    .entry(date)
                    .or_insert_with(|| (HashSet::new(), 0.0, 0));
                if entry.0.insert(ticker.to_owned()) {
                    entry.1 += value;
                    entry.2 += 1;
                }
            }
        }

        let mut bucket_values = vec![Vec::<f64>::new(); 7];
        let mut bucket_ticker_counts = vec![Vec::<f64>::new(); 7];
        for (_date, (tickers, sum, value_count)) in daily.iter() {
            if *value_count == 0 {
                continue;
            }
            let bucket = ticker_count_bucket(tickers.len());
            bucket_values[bucket].push(*sum / *value_count as f64);
            bucket_ticker_counts[bucket].push(tickers.len() as f64);
        }

        let labels = ["< 5", "5–9", "10–14", "15–19", "20–29", "30–39", "40+"];
        let buckets = labels
            .into_iter()
            .enumerate()
            .map(|(index, label)| SessionTickerReturnBucket {
                label: label.to_owned(),
                days: bucket_values[index].len() as u64,
                average_return: mean(&bucket_values[index]),
                average_tickers: mean(&bucket_ticker_counts[index]),
            })
            .collect();
        let result = SessionTickerReturnResult {
            field: field.to_owned(),
            buckets,
            operable_days: daily.len() as u64,
            market_days: market_dates.len() as u64,
        };
        write_cache(&cache_path, &result)?;
        Ok(result)
    }

    pub fn select_keys(
        data_root: &Path,
        config: &SessionFilterConfig,
    ) -> Result<SessionSelectionResult, AnalyticsError> {
        Self::select(data_root, config, true)
    }

    pub fn timing_distributions(
        data_root: &Path,
        config: &SessionFilterConfig,
    ) -> Result<SessionTimingSummary, AnalyticsError> {
        let cache_path = cache_path(data_root, "timing_v2", config)?;
        if let Some(summary) = read_cache(&cache_path)? {
            return Ok(summary);
        }
        let plan = Self::compile(config)?;
        let store_dir = data_root.join("runtime").join(STORE_DIR_NAME);
        let mut values = BTreeMap::<String, Vec<f64>>::new();
        for year in years_between(&config.date_from, &config.date_to)? {
            let path = store_dir.join(format!("{year}.arrow"));
            if !path.is_file() {
                return Err(AnalyticsError::StoreMissing {
                    path: path.display().to_string(),
                });
            }
            let frame = read_filtered_ipc(data_root, &path, &plan, true)?;
            collect_timing_values(data_root, &frame, &mut values)?;
        }
        let summary = summarize_values(0, values);
        let result = SessionTimingSummary {
            distribution_buckets: summary.distribution_buckets,
            distribution_averages: summary.distribution_averages,
            avg: summary.avg,
            p25: summary.p25,
            median: summary.median,
            p75: summary.p75,
        };
        write_cache(&cache_path, &result)?;
        Ok(result)
    }

    pub fn rows(
        data_root: &Path,
        config: &SessionFilterConfig,
        search: &str,
        sort_col: &str,
        sort_desc: bool,
        page: u32,
        page_size: u32,
    ) -> Result<SessionRowsResult, AnalyticsError> {
        let plan = Self::compile(config)?;
        let mut rows = Vec::new();
        let query = search.trim().to_ascii_lowercase();
        for year in years_between(&config.date_from, &config.date_to)? {
            let path = data_root
                .join("runtime")
                .join(STORE_DIR_NAME)
                .join(format!("{year}.arrow"));
            if !path.is_file() {
                return Err(AnalyticsError::StoreMissing {
                    path: path.display().to_string(),
                });
            }
            let frame = read_filtered_ipc(data_root, &path, &plan, false)?;
            append_rows(&mut rows, &frame, &query)?;
        }
        let total = rows.len() as u64;
        let sort_key = canonical_field(sort_col).unwrap_or("reference_date");
        rows.sort_by(|left, right| {
            let a = left
                .get(sort_key)
                .or_else(|| left.get(sort_col))
                .map(String::as_str)
                .unwrap_or("");
            let b = right
                .get(sort_key)
                .or_else(|| right.get(sort_col))
                .map(String::as_str)
                .unwrap_or("");
            let order = a.cmp(b);
            if sort_desc {
                order.reverse()
            } else {
                order
            }
        });
        let start = ((page.saturating_sub(1)) as usize).saturating_mul(page_size as usize);
        let rows = rows
            .into_iter()
            .skip(start)
            .take(page_size as usize)
            .collect();
        Ok(SessionRowsResult { rows, total })
    }

    pub fn heatmap(
        data_root: &Path,
        config: &SessionFilterConfig,
        bucket_field: &str,
        direction: &str,
    ) -> Result<SessionHeatmapResult, AnalyticsError> {
        let plan = Self::compile(config)?;
        let bucket_field =
            canonical_field(bucket_field).ok_or_else(|| AnalyticsError::InvalidFilter {
                message: format!("unsupported chart bucket field '{bucket_field}'"),
            })?;
        let direction = match direction.to_ascii_lowercase().as_str() {
            "greater" | "greater_than" | "gt" => true,
            "less" | "less_than" | "lt" => false,
            _ => {
                return Err(AnalyticsError::InvalidFilter {
                    message: "chart direction must be 'greater' or 'less'".to_owned(),
                })
            }
        };
        let store_dir = data_root.join("runtime").join(STORE_DIR_NAME);
        const TIME_FIELDS: [(&str, &str); 8] = [
            ("", "Open"),
            ("m1_return_pct", "M1"),
            ("m5_return_pct", "M5"),
            ("m15_return_pct", "M15"),
            ("m30_return_pct", "M30"),
            ("m60_return_pct", "M60"),
            ("m120_return_pct", "M120"),
            ("rth_return_pct", "RTH Close"),
        ];
        const THRESHOLDS: [f64; 7] = [1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0];
        let mut buckets = vec![Vec::<f64>::new(); THRESHOLDS.len() * TIME_FIELDS.len()];
        let mut included_observations = 0_u64;
        for year in years_between(&config.date_from, &config.date_to)? {
            let path = store_dir.join(format!("{year}.arrow"));
            if !path.is_file() {
                return Err(AnalyticsError::StoreMissing {
                    path: path.display().to_string(),
                });
            }
            let frame = read_filtered_ipc(data_root, &path, &plan, false)?;
            included_observations += frame.height() as u64;
            let bucket = frame
                .column(bucket_field)
                .map_err(|_| AnalyticsError::InvalidFilter {
                    message: format!(
                        "chart bucket '{bucket_field}' is not available in the session store"
                    ),
                })?
                .cast(&DataType::Float64)?;
            let returns = TIME_FIELDS
                .iter()
                .skip(1)
                .map(|(field, _)| {
                    frame
                        .column(field)
                        .map_err(|_| AnalyticsError::InvalidFilter {
                            message: format!(
                                "chart return '{field}' is not available in the session store"
                            ),
                        })
                        .and_then(|column| {
                            column
                                .cast(&DataType::Float64)
                                .map_err(AnalyticsError::from)
                        })
                })
                .collect::<Result<Vec<_>, _>>()?;
            for row in 0..frame.height() {
                let Some(bucket_value) = bucket.f64()?.get(row) else {
                    continue;
                };
                if !bucket_value.is_finite() {
                    continue;
                }
                for (threshold_index, threshold) in THRESHOLDS.iter().enumerate() {
                    let matches = if direction {
                        bucket_value > *threshold
                    } else {
                        bucket_value < -*threshold
                    };
                    if !matches {
                        continue;
                    }
                    for time_index in 0..TIME_FIELDS.len() {
                        let value = if time_index == 0 {
                            Some(0.0)
                        } else {
                            returns[time_index - 1]
                                .f64()?
                                .get(row)
                                .filter(|value| value.is_finite())
                        };
                        if let Some(value) = value {
                            buckets[threshold_index * TIME_FIELDS.len() + time_index].push(value);
                        }
                    }
                }
            }
        }
        let cells = buckets
            .into_iter()
            .enumerate()
            .map(|(index, mut values)| {
                values.sort_by(f64::total_cmp);
                let count = values.len() as u64;
                let mean = (count > 0).then(|| values.iter().sum::<f64>() / count as f64);
                let median = (count > 0).then(|| quantile(&mut values, 0.5));
                SessionHeatmapCell {
                    bucket_index: index / TIME_FIELDS.len(),
                    time_index: index % TIME_FIELDS.len(),
                    count,
                    average_return: mean,
                    median_return: median,
                }
            })
            .collect();
        Ok(SessionHeatmapResult {
            cells,
            included_observations,
            x_labels: TIME_FIELDS
                .iter()
                .map(|(_, label)| (*label).to_owned())
                .collect(),
            y_labels: THRESHOLDS
                .iter()
                .map(|threshold| {
                    if direction {
                        format!("> {threshold:.0}%")
                    } else {
                        format!("< -{threshold:.0}%")
                    }
                })
                .collect(),
        })
    }

    fn select(
        data_root: &Path,
        config: &SessionFilterConfig,
        materialize_keys: bool,
    ) -> Result<SessionSelectionResult, AnalyticsError> {
        let started = Instant::now();
        let plan = Self::compile(config)?;
        let years = years_between(&config.date_from, &config.date_to)?;
        let store_dir = data_root.join("runtime").join(STORE_DIR_NAME);
        let mut files_scanned = 0_u64;
        let mut matched_sessions = 0_u64;
        let mut session_keys = materialize_keys.then(Vec::new);
        let mut summary_values = (!materialize_keys).then(BTreeMap::<String, Vec<f64>>::new);

        for year in years {
            let path = store_dir.join(format!("{year}.arrow"));
            if !path.is_file() {
                return Err(AnalyticsError::StoreMissing {
                    path: path.display().to_string(),
                });
            }
            files_scanned += 1;
            let frame = if materialize_keys {
                read_filtered_ipc(data_root, &path, &plan, true)?
            } else {
                read_summary_ipc(data_root, &path, &plan)?
            };
            matched_sessions += frame.height() as u64;
            if let Some(keys) = session_keys.as_mut() {
                append_keys(keys, &frame)?;
            }
            if let Some(values) = summary_values.as_mut() {
                collect_numeric_values(&frame, values)?;
            }
        }

        let summary = summary_values.map(|values| summarize_values(matched_sessions, values));

        Ok(SessionSelectionResult {
            matched_sessions,
            files_scanned,
            elapsed_ms: started.elapsed().as_millis() as u64,
            session_keys,
            summary,
        })
    }
}

fn session_timeseries_path(data_root: &Path, date: NaiveDate) -> std::path::PathBuf {
    data_root
        .join("features/session_timeseries")
        .join(format!("year={:04}", date.year()))
        .join(format!("month={:02}", date.month()))
        .join(format!("{date}.parquet"))
}

// Bump when the set of fields calculated by Overview changes. Old summary and
// timing cache files must never repopulate the reduced active view.
const QUERY_CACHE_VERSION: u32 = 9;

fn cache_path(
    data_root: &Path,
    kind: &str,
    config: &SessionFilterConfig,
) -> Result<PathBuf, AnalyticsError> {
    let payload = serde_json::to_vec(&(QUERY_CACHE_VERSION, config))?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    payload.hash(&mut hasher);
    Ok(data_root
        .join("runtime/session_summary_cache")
        .join(format!("{kind}-{:016x}.json", hasher.finish())))
}

fn read_cache<T: DeserializeOwned>(path: &Path) -> Result<Option<T>, AnalyticsError> {
    if !path.is_file() {
        return Ok(None);
    }
    match serde_json::from_reader(File::open(path)?) {
        Ok(value) => Ok(Some(value)),
        Err(_) => Ok(None),
    }
}

fn write_cache<T: Serialize>(path: &Path, value: &T) -> Result<(), AnalyticsError> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("json.tmp");
    fs::write(&temporary, serde_json::to_vec(value)?)?;
    if path.is_file() {
        fs::remove_file(path)?;
    }
    fs::rename(temporary, path)?;
    Ok(())
}

const PROFILE_VALUES_HEADER_SIZE: usize = 8 + 4 + 8;

fn profile_values_column_count(
    path: &Path,
    expected: usize,
    rows: usize,
) -> Result<usize, AnalyticsError> {
    let mut file = File::open(path)?;
    let mut magic = [0_u8; 8];
    file.read_exact(&mut magic)?;
    let mut count_bytes = [0_u8; 4];
    file.read_exact(&mut count_bytes)?;
    let count = u32::from_le_bytes(count_bytes) as usize;
    let mut row_bytes = [0_u8; 8];
    file.read_exact(&mut row_bytes)?;
    let stored_rows = u64::from_le_bytes(row_bytes) as usize;
    if &magic != b"QMPROF01" || count != expected || stored_rows != rows {
        return Err(AnalyticsError::InvalidFilter {
            message: format!("invalid profile values store: {}", path.display()),
        });
    }
    Ok(count)
}

fn profile_points(raw: &[u8], time_columns: &[i32]) -> Vec<(i32, f64)> {
    time_columns
        .iter()
        .enumerate()
        .filter_map(|(index, minute)| {
            let offset = index * 8;
            let value = f64::from_le_bytes(raw[offset..offset + 8].try_into().ok()?);
            value.is_finite().then_some((*minute, value))
        })
        .collect()
}

fn read_profile_key_header<R: Read>(file: &mut R, path: &Path) -> Result<usize, AnalyticsError> {
    let mut magic = [0_u8; 8];
    file.read_exact(&mut magic)?;
    let mut rows = [0_u8; 8];
    file.read_exact(&mut rows)?;
    if &magic != b"QMKEY001" {
        return Err(AnalyticsError::InvalidFilter {
            message: format!("invalid profile key store: {}", path.display()),
        });
    }
    Ok(u64::from_le_bytes(rows) as usize)
}

const CHANGE_STORE_DIR_NAME: &str = "session_change_store";
const CHANGE_STORE_MANIFEST_NAME: &str = "manifest.json";
const CHANGE_STORE_VERSION: u32 = 2;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ChangeStoreManifest {
    algorithm_version: u32,
    days: u32,
    base_store_version: String,
    years: Vec<i32>,
}

static CHANGE_STORE_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

fn ensure_change_store(data_root: &Path, days: u32) -> Result<(), AnalyticsError> {
    let lock = CHANGE_STORE_LOCK.get_or_init(|| Mutex::new(()));
    let _guard = lock.lock().unwrap();
    let base_dir = data_root.join("runtime").join(STORE_DIR_NAME);
    let base_manifest = base_dir.join("manifest.json");
    let base_store_version = store_file_version(&base_manifest)?;
    let years = fs::read_dir(&base_dir)?
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            (path.extension().and_then(|value| value.to_str()) == Some("arrow"))
                .then(|| path.file_stem()?.to_str()?.parse::<i32>().ok())
                .flatten()
        })
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    if years.is_empty() {
        return Err(AnalyticsError::StoreMissing {
            path: base_dir.display().to_string(),
        });
    }

    let target_dir = data_root
        .join("runtime")
        .join(CHANGE_STORE_DIR_NAME)
        .join(days.to_string());
    let manifest_path = target_dir.join(CHANGE_STORE_MANIFEST_NAME);
    if let Ok(file) = File::open(&manifest_path) {
        if let Ok(manifest) = serde_json::from_reader::<_, ChangeStoreManifest>(file) {
            if manifest.days == days
                && manifest.algorithm_version == CHANGE_STORE_VERSION
                && manifest.base_store_version == base_store_version
                && manifest.years == years
                && years
                    .iter()
                    .all(|year| target_dir.join(format!("{year}.arrow")).is_file())
            {
                return Ok(());
            }
        }
    }

    let temporary_dir = target_dir.with_file_name(format!(".{days}.tmp"));
    if temporary_dir.is_dir() {
        fs::remove_dir_all(&temporary_dir)?;
    }
    fs::create_dir_all(&temporary_dir)?;
    let mut history = HashMap::<String, VecDeque<f64>>::new();
    for year in &years {
        let base_path = base_dir.join(format!("{year}.arrow"));
        let mut reader =
            IpcReader::new(File::open(&base_path)?).memory_mapped(Some(base_path.clone()));
        reader = reader.with_columns(Some(vec![
            "reference_date".to_owned(),
            "ticker".to_owned(),
            "close".to_owned(),
        ]));
        let frame = reader.finish()?;
        let dates = frame.column("reference_date")?;
        let tickers = frame.column("ticker")?.cast(&DataType::String)?;
        let closes = frame.column("close")?.cast(&DataType::Float64)?;
        let mut changes = Vec::with_capacity(frame.height());
        for index in 0..frame.height() {
            let ticker = tickers.str()?.get(index).unwrap_or("").to_owned();
            let close = closes.f64()?.get(index);
            let queue = history.entry(ticker).or_default();
            // The signal for session T must only use closes through T-1.
            // For an N-session lookback, compare T-1 with T-N-1 and attach
            // the resulting signal to T. This keeps the session being
            // analyzed out of the filter's lookback window.
            let change = (queue.len() >= days as usize + 1)
                .then(|| (queue.front().copied(), queue.back().copied()))
                .and_then(|(oldest, previous)| match (oldest, previous) {
                    (Some(oldest), Some(previous))
                        if oldest.is_finite() && previous.is_finite() && oldest != 0.0 =>
                    {
                        Some((previous / oldest - 1.0) * 100.0)
                    }
                    _ => None,
                });
            changes.push(change);
            if let Some(close) = close.filter(|value| value.is_finite()) {
                queue.push_back(close);
                while queue.len() > days as usize + 1 {
                    queue.pop_front();
                }
            }
        }
        let mut output = DataFrame::new(vec![dates.clone(), tickers.into_column()])?;
        output.with_column(
            Float64Chunked::from_iter(changes)
                .with_name("change_pct".into())
                .into_column(),
        )?;
        let output_path = temporary_dir.join(format!("{year}.arrow"));
        let mut writer = IpcWriter::new(File::create(output_path)?);
        writer.finish(&mut output)?;
    }
    let manifest = ChangeStoreManifest {
        algorithm_version: CHANGE_STORE_VERSION,
        days,
        base_store_version,
        years,
    };
    fs::write(
        temporary_dir.join(CHANGE_STORE_MANIFEST_NAME),
        serde_json::to_vec(&manifest)?,
    )?;
    if target_dir.is_dir() {
        fs::remove_dir_all(&target_dir)?;
    }
    if let Some(parent) = target_dir.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::rename(temporary_dir, target_dir)?;
    Ok(())
}

fn store_file_version(path: &Path) -> Result<String, AnalyticsError> {
    let bytes = fs::read(path)?;
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    bytes.hash(&mut hasher);
    Ok(format!("{:016x}", hasher.finish()))
}

fn attach_change_column(
    data_root: &Path,
    path: &Path,
    plan: &CompiledFilterPlan,
    frame: &mut DataFrame,
) -> Result<(), AnalyticsError> {
    let Some(days) = plan.rolling_change_days else {
        return Ok(());
    };
    ensure_change_store(data_root, days)?;
    let year = path
        .file_stem()
        .and_then(|value| value.to_str())
        .ok_or_else(|| AnalyticsError::InvalidFilter {
            message: format!("invalid session store path: {}", path.display()),
        })?;
    let change_path = data_root
        .join("runtime")
        .join(CHANGE_STORE_DIR_NAME)
        .join(days.to_string())
        .join(format!("{year}.arrow"));
    let mut reader =
        IpcReader::new(File::open(&change_path)?).memory_mapped(Some(change_path.clone()));
    reader = reader.with_columns(Some(vec!["change_pct".to_owned()]));
    let change_frame = reader.finish()?;
    if change_frame.height() != frame.height() {
        return Err(AnalyticsError::InvalidFilter {
            message: format!("change store row count does not match {}", path.display()),
        });
    }
    frame.with_column(change_frame.column("change_pct")?.clone())?;
    Ok(())
}

fn read_filtered_ipc(
    data_root: &Path,
    path: &Path,
    plan: &CompiledFilterPlan,
    keys_only: bool,
) -> Result<DataFrame, AnalyticsError> {
    let mut reader = IpcReader::new(File::open(path)?).memory_mapped(Some(path.to_owned()));
    if keys_only {
        reader = reader.with_columns(Some(plan.required_columns.clone()));
    }
    let mut frame = reader.finish()?;
    attach_change_column(data_root, path, plan, &mut frame)?;
    let filtered = frame.lazy().filter(plan.predicate.clone());
    let filtered = if keys_only {
        if plan.overnight_alignment {
            filtered.select([
                col("reference_date"),
                col("ticker"),
                col("overnight_next_reference_date"),
                col("rth_return_pct"),
                col("overnight_next_open_gap_pct"),
            ])
        } else {
            filtered.select([col("reference_date"), col("ticker")])
        }
    } else {
        filtered
    };
    let mut filtered = filtered.collect().map_err(AnalyticsError::from)?;
    apply_daily_ticker_cap(
        &mut filtered,
        plan.min_tickers_per_day,
        plan.max_tickers_per_day,
    )?;
    Ok(filtered)
}

fn read_market_day_dates(path: &Path) -> Result<HashSet<i32>, AnalyticsError> {
    let mut reader = IpcReader::new(File::open(path)?).memory_mapped(Some(path.to_owned()));
    reader = reader.with_columns(Some(vec!["reference_date".to_owned()]));
    let frame = reader.finish()?;
    Ok(frame
        .column("reference_date")?
        .date()?
        .physical()
        .into_iter()
        .flatten()
        .collect())
}

fn overview_output_exprs<F>(has_source: F, overnight_alignment: bool) -> Vec<Expr>
where
    F: Fn(&str) -> bool,
{
    OVERVIEW_SUMMARY_COLUMNS
        .iter()
        .filter_map(|name| {
            let source = overnight_output_field(name, overnight_alignment);
            has_source(&source).then_some(())?;
            if source == *name {
                Some(col(*name))
            } else {
                Some(col(source).alias(*name))
            }
        })
        .collect()
}

fn read_summary_ipc(
    data_root: &Path,
    path: &Path,
    plan: &CompiledFilterPlan,
) -> Result<DataFrame, AnalyticsError> {
    let mut reader = IpcReader::new(File::open(path)?).memory_mapped(Some(path.to_owned()));
    let schema = reader.schema()?;
    let mut columns = BTreeSet::new();
    for name in OVERVIEW_SUMMARY_COLUMNS {
        let source = overnight_output_field(name, plan.overnight_alignment);
        if schema.contains(&source) {
            columns.insert(source);
        }
    }
    columns.extend(
        plan.required_columns
            .iter()
            .filter(|name| schema.contains(name))
            .cloned(),
    );
    reader = reader.with_columns(Some(columns.into_iter().collect()));
    let mut frame = reader.finish()?;
    attach_change_column(data_root, path, plan, &mut frame)?;
    let available = overview_output_exprs(
        |name| {
            frame
                .get_column_names()
                .iter()
                .any(|column| column.as_str() == name)
        },
        plan.overnight_alignment,
    );
    let needs_daily_cap = plan.min_tickers_per_day.is_some() || plan.max_tickers_per_day.is_some();
    let mut output_columns = available;
    if needs_daily_cap {
        output_columns.push(col("reference_date"));
        output_columns.push(col("ticker"));
    }
    let filtered = frame.lazy().filter(plan.predicate.clone());
    let mut filtered = filtered
        .select(output_columns)
        .collect()
        .map_err(AnalyticsError::from)?;
    apply_daily_ticker_cap(
        &mut filtered,
        plan.min_tickers_per_day,
        plan.max_tickers_per_day,
    )?;
    if needs_daily_cap {
        filtered.drop_in_place("reference_date")?;
        filtered.drop_in_place("ticker")?;
    }
    Ok(filtered)
}

fn read_overview_ipc(
    data_root: &Path,
    path: &Path,
    plan: &CompiledFilterPlan,
    from: i32,
    to: i32,
) -> Result<(DataFrame, HashSet<i32>), AnalyticsError> {
    let mut reader = IpcReader::new(File::open(path)?).memory_mapped(Some(path.to_owned()));
    let schema = reader.schema()?;
    let needs_daily_cap = plan.min_tickers_per_day.is_some() || plan.max_tickers_per_day.is_some();
    let mut columns = BTreeSet::new();
    columns.insert("reference_date".to_owned());
    if needs_daily_cap {
        columns.insert("ticker".to_owned());
    }
    for name in OVERVIEW_SUMMARY_COLUMNS {
        let source = overnight_output_field(name, plan.overnight_alignment);
        if schema.contains(&source) {
            columns.insert(source);
        }
    }
    columns.extend(
        plan.required_columns
            .iter()
            .filter(|name| schema.contains(name))
            .cloned(),
    );
    reader = reader.with_columns(Some(columns.into_iter().collect()));
    let mut frame = reader.finish()?;
    let market_dates = frame
        .column("reference_date")?
        .date()?
        .physical()
        .into_iter()
        .flatten()
        .filter(|date| *date >= from && *date <= to)
        .collect::<HashSet<_>>();
    attach_change_column(data_root, path, plan, &mut frame)?;

    let available = overview_output_exprs(
        |name| {
            frame
                .get_column_names()
                .iter()
                .any(|column| column.as_str() == name)
        },
        plan.overnight_alignment,
    )
    .into_iter();
    let mut output_columns = vec![col("reference_date")];
    output_columns.extend(available);
    if needs_daily_cap {
        output_columns.push(col("ticker"));
    }
    let mut filtered = frame
        .lazy()
        .filter(plan.predicate.clone())
        .select(output_columns)
        .collect()
        .map_err(AnalyticsError::from)?;
    apply_daily_ticker_cap(
        &mut filtered,
        plan.min_tickers_per_day,
        plan.max_tickers_per_day,
    )?;
    if needs_daily_cap {
        filtered.drop_in_place("ticker")?;
    }
    Ok((filtered, market_dates))
}

fn read_trend_ipc(
    data_root: &Path,
    path: &Path,
    plan: &CompiledFilterPlan,
    return_field: &str,
) -> Result<DataFrame, AnalyticsError> {
    let source_field = overnight_output_field(return_field, plan.overnight_alignment);
    let mut reader = IpcReader::new(File::open(path)?).memory_mapped(Some(path.to_owned()));
    let schema = reader.schema()?;
    let mut columns = BTreeSet::new();
    columns.extend(
        plan.required_columns
            .iter()
            .filter(|name| schema.contains(name))
            .cloned(),
    );
    columns.insert("reference_date".to_owned());
    if schema.contains(&source_field) {
        columns.insert(source_field.clone());
    }
    reader = reader.with_columns(Some(columns.into_iter().collect()));
    let mut frame = reader.finish()?;
    attach_change_column(data_root, path, plan, &mut frame)?;
    if !frame
        .get_column_names()
        .iter()
        .any(|column| column.as_str() == source_field)
    {
        return Err(AnalyticsError::InvalidFilter {
            message: format!("return field '{return_field}' is not available in the session store"),
        });
    }
    let return_expr = if source_field == return_field {
        col(return_field)
    } else {
        col(source_field).alias(return_field)
    };
    let mut output_columns = vec![col("reference_date"), return_expr];
    if plan.min_tickers_per_day.is_some() || plan.max_tickers_per_day.is_some() {
        output_columns.push(col("ticker"));
    }
    let mut filtered = frame
        .lazy()
        .filter(plan.predicate.clone())
        .select(output_columns)
        .collect()
        .map_err(AnalyticsError::from)?;
    apply_daily_ticker_cap(
        &mut filtered,
        plan.min_tickers_per_day,
        plan.max_tickers_per_day,
    )?;
    if plan.min_tickers_per_day.is_some() || plan.max_tickers_per_day.is_some() {
        filtered.drop_in_place("ticker")?;
    }
    Ok(filtered)
}

fn read_ticker_return_ipc(
    data_root: &Path,
    path: &Path,
    plan: &CompiledFilterPlan,
    return_field: &str,
) -> Result<DataFrame, AnalyticsError> {
    let source_field = overnight_output_field(return_field, plan.overnight_alignment);
    let mut reader = IpcReader::new(File::open(path)?).memory_mapped(Some(path.to_owned()));
    let schema = reader.schema()?;
    let mut columns = BTreeSet::new();
    columns.extend(
        plan.required_columns
            .iter()
            .filter(|name| schema.contains(name))
            .cloned(),
    );
    columns.insert("reference_date".to_owned());
    columns.insert("ticker".to_owned());
    if schema.contains(&source_field) {
        columns.insert(source_field.clone());
    }
    reader = reader.with_columns(Some(columns.into_iter().collect()));
    let mut frame = reader.finish()?;
    attach_change_column(data_root, path, plan, &mut frame)?;
    if !frame
        .get_column_names()
        .iter()
        .any(|column| column.as_str() == source_field)
    {
        return Err(AnalyticsError::InvalidFilter {
            message: format!("return field '{return_field}' is not available in the session store"),
        });
    }
    let mut filtered = frame
        .lazy()
        .filter(plan.predicate.clone())
        .select([
            col("reference_date"),
            col("ticker"),
            if source_field == return_field {
                col(return_field)
            } else {
                col(source_field).alias(return_field)
            },
        ])
        .collect()
        .map_err(AnalyticsError::from)?;
    apply_daily_ticker_cap(
        &mut filtered,
        plan.min_tickers_per_day,
        plan.max_tickers_per_day,
    )?;
    Ok(filtered)
}

fn ticker_count_bucket(count: usize) -> usize {
    match count {
        0..=4 => 0,
        5..=9 => 1,
        10..=14 => 2,
        15..=19 => 3,
        20..=29 => 4,
        30..=39 => 5,
        _ => 6,
    }
}

fn mean(values: &[f64]) -> Option<f64> {
    (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
}

fn apply_daily_ticker_cap(
    frame: &mut DataFrame,
    min_tickers_per_day: Option<u32>,
    max_tickers_per_day: Option<u32>,
) -> Result<(), AnalyticsError> {
    if min_tickers_per_day.is_none() && max_tickers_per_day.is_none() {
        return Ok(());
    }
    if frame.height() == 0 {
        return Ok(());
    }
    let dates = frame.column("reference_date")?.date()?.physical();
    let tickers = frame.column("ticker")?.cast(&DataType::String)?;
    let ticker_values = tickers.str()?;
    let mut tickers_by_date = HashMap::<i32, HashSet<String>>::new();
    for (date, ticker) in dates.into_iter().zip(ticker_values.into_iter()) {
        if let (Some(date), Some(ticker)) = (date, ticker) {
            tickers_by_date
                .entry(date)
                .or_default()
                .insert(ticker.to_owned());
        }
    }
    let allowed_dates = tickers_by_date
        .into_iter()
        .filter_map(|(date, tickers)| {
            let count = tickers.len() as u32;
            let above_min = min_tickers_per_day.map_or(true, |min| count >= min);
            let below_max = max_tickers_per_day.map_or(true, |max| count <= max);
            (above_min && below_max).then_some(date)
        })
        .collect::<HashSet<_>>();
    let mut mask = BooleanChunkedBuilder::new("daily_ticker_cap".into(), frame.height());
    for date in dates.into_iter() {
        mask.append_value(date.is_some_and(|date| allowed_dates.contains(&date)));
    }
    *frame = frame.filter(&mask.finish())?;
    Ok(())
}

fn normalize_trend_granularity(value: &str) -> Result<&'static str, AnalyticsError> {
    match value.trim().to_ascii_lowercase().as_str() {
        "" | "year" | "years" | "annual" => Ok("year"),
        "month" | "months" => Ok("month"),
        "week" | "weeks" => Ok("week"),
        "day" | "days" | "daily" => Ok("day"),
        _ => Err(AnalyticsError::InvalidFilter {
            message: format!(
                "unsupported trend granularity '{value}'; use year, month, week, or day"
            ),
        }),
    }
}

fn trend_bucket(date: NaiveDate, granularity: &str) -> String {
    match granularity {
        "month" => date.format("%Y-%m").to_string(),
        "week" => {
            let week = date.iso_week();
            format!("{:04}-W{:02}", week.year(), week.week())
        }
        "day" => date.format("%Y-%m-%d").to_string(),
        _ => date.format("%Y").to_string(),
    }
}

fn intraday_minutes(overnight: bool) -> Vec<i32> {
    let mut minutes = Vec::new();
    if overnight {
        minutes.extend((975..=1200).step_by(15));
        minutes.extend((255..=555).step_by(15));
    } else {
        minutes.extend((570..=960).step_by(15));
    }
    minutes
}

fn intraday_phase(minute: i32, overnight: bool) -> &'static str {
    if !overnight {
        "RTH"
    } else if minute >= 975 {
        "AH"
    } else {
        "PM"
    }
}

fn overnight_return_from_rth_open(
    profile_return_pct: f64,
    rth_return_pct: f64,
    open_gap_pct: Option<f64>,
) -> Option<f64> {
    if !profile_return_pct.is_finite() || !rth_return_pct.is_finite() {
        return None;
    }
    let profile_factor = 1.0 + profile_return_pct / 100.0;
    let factor = if let Some(open_gap_pct) = open_gap_pct {
        if !open_gap_pct.is_finite() {
            return None;
        }
        profile_factor * (1.0 + open_gap_pct / 100.0)
    } else {
        let close_factor = 1.0 + rth_return_pct / 100.0;
        if close_factor == 0.0 {
            return None;
        }
        profile_factor / close_factor
    };
    factor.is_finite().then_some((factor - 1.0) * 100.0)
}

fn format_minutes(minute: i32) -> String {
    format!("{:02}:{:02}", minute.div_euclid(60), minute.rem_euclid(60))
}

fn collect_intraday_return_values_legacy(
    data_root: &Path,
    wanted: &BTreeMap<i32, BTreeSet<String>>,
    overnight: bool,
    values: &mut BTreeMap<i32, Vec<f64>>,
) -> Result<(), AnalyticsError> {
    for (date, selected_tickers) in wanted {
        let Some(date) = NaiveDate::from_num_days_from_ce_opt(*date + 719_163) else {
            continue;
        };
        let path = session_timeseries_path(data_root, date);
        if !path.is_file() {
            continue;
        }
        let timeseries = ParquetReader::new(File::open(path)?).finish()?;
        let ticker_column = timeseries.column("ticker")?.str()?;
        let mut ticker_rows = HashMap::new();
        for (index, ticker) in ticker_column.into_iter().enumerate() {
            if let Some(ticker) = ticker {
                ticker_rows.insert(ticker, index);
            }
        }
        let columns = timeseries.get_columns();
        let time_columns: Vec<(usize, i32)> = columns
            .iter()
            .enumerate()
            .skip(2)
            .filter_map(|(index, column)| {
                let (hour, minute) = column.name().split_once(':').and_then(|(hour, minute)| {
                    Some((hour.parse::<i32>().ok()?, minute.parse::<i32>().ok()?))
                })?;
                Some((index, hour * 60 + minute))
            })
            .collect();
        for ticker in selected_tickers {
            let Some(&row) = ticker_rows.get(ticker.as_str()) else {
                continue;
            };
            for (index, minute) in &time_columns {
                if let Some(value) = columns[*index]
                    .f64()?
                    .get(row)
                    .filter(|value| value.is_finite())
                {
                    let in_window = if overnight {
                        *minute < 570 || *minute >= 975
                    } else {
                        (570..=960).contains(minute)
                    };
                    if in_window {
                        values.entry(*minute).or_default().push(value);
                    }
                }
            }
        }
    }
    Ok(())
}

const SUMMARY_COLUMNS: &[&str] = &[
    "open",
    "close",
    "hod",
    "lod",
    "prev_day_close",
    "pm_open",
    "pmh",
    "pml",
    "vwap_at_open",
    "m15_high",
    "m30_high",
    "m60_high",
    "m120_high",
    "overnight_vol",
    "overnight_dollar_vol",
    "ah_prev_close_price",
    "ah_prev_high_price",
    "ah_prev_low_price",
    "ah_prev_vol",
    "ah_prev_dollar_vol",
    "ah_prev_hod_to_lod_minutes",
    "ah_close_price",
    "ah_open_to_close_return_pct",
    "ah_close_to_pm_open_return_pct",
    "ah_high_price",
    "ah_low_price",
    "ah_vol",
    "ah_dollar_vol",
    "ah_hod_to_lod_minutes",
    "overnight_high_price",
    "overnight_low_price",
    "overnight_hod_to_lod_minutes",
    "pm_close_price",
    "pm_high_price",
    "pm_low_price",
    "pm_low_spike_pct",
    "pm_hod_to_lod_minutes",
    "open_position_in_pm_range",
    "pmh_fade_to_open_pct",
    "pmh_fade_to_close_pct",
    "pm_vol",
    "pm_dollar_vol",
    "rth_vol",
    "rth_dollar_vol",
    "open_gap_pct",
    "pm_high_spike_pct",
    "pmh_gap_pct",
    "rth_high_spike_pct",
    "rth_low_spike_pct",
    "pmh_fade_pct",
    "overnight_fade_pct",
    "rth_fade_pct",
    "pm_return_pct",
    "pm_open_to_close_return_pct",
    "rth_return_pct",
    "overnight_return_pct",
    "ah_prev_return_pct",
    "ah_return_pct",
    "ah_prev_high_spike_pct",
    "ah_prev_low_spike_pct",
    "ah_prev_range_pct",
    "ah_high_spike_pct",
    "ah_low_spike_pct",
    "ah_range_pct",
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
    "previous_day_change_pct",
    "change_pct",
    "m1_return_pct",
    "m5_return_pct",
    "m15_return_pct",
    "m30_return_pct",
    "m60_return_pct",
    "m120_return_pct",
    "rth_range_pct",
];

// Only these fields are loaded and summarized by the active Overview. The
// broader SUMMARY_COLUMNS list remains available to the filter compiler and
// Data Explorer, but inactive Overview tabs no longer force their metrics into
// every Overview query.
const OVERVIEW_SUMMARY_COLUMNS: &[&str] = &[
    "open",
    "close",
    "hod",
    "lod",
    "prev_day_close",
    "pm_open",
    "pmh",
    "pml",
    "vwap_at_open",
    "m15_high",
    "m30_high",
    "m60_high",
    "m120_high",
    "pm_open_price",
    "ah_close_price",
    "pm_close_price",
    "ah_open_to_close_return_pct",
    "pm_open_to_close_return_pct",
    "ah_close_to_pm_open_return_pct",
    "pmh_gap_pct",
    "pmh_fade_to_open_pct",
    "pm_vol",
    "pm_dollar_vol",
    "rth_vol",
    "rth_dollar_vol",
    "open_gap_pct",
    "rth_high_spike_pct",
    "rth_low_spike_pct",
    "rth_fade_pct",
    "rth_return_pct",
    "rth_range_pct",
    "m15_return_pct",
    "m30_return_pct",
    "m60_return_pct",
    "m120_return_pct",
    "overnight_return_pct",
    "overnight_vol",
    "overnight_dollar_vol",
    "ah_prev_return_pct",
    "ah_prev_high_spike_pct",
    "ah_prev_low_spike_pct",
    "ah_prev_range_pct",
    "ah_prev_high_fade_to_pm_open_pct",
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
];

fn append_rows(
    rows: &mut Vec<BTreeMap<String, String>>,
    frame: &DataFrame,
    search: &str,
) -> Result<(), AnalyticsError> {
    let columns = frame.get_columns();
    let ticker_index = columns
        .iter()
        .position(|column| column.name().as_str() == "ticker");
    let date_index = columns
        .iter()
        .position(|column| column.name().as_str() == "reference_date");
    for index in 0..frame.height() {
        let ticker = ticker_index
            .and_then(|column| columns[column].get(index).ok())
            .map(any_value_text)
            .unwrap_or_default();
        let date = date_index
            .and_then(|column| columns[column].get(index).ok())
            .map(any_value_text)
            .unwrap_or_default();
        if !search.is_empty()
            && !ticker.to_ascii_lowercase().contains(search)
            && !date.to_ascii_lowercase().contains(search)
        {
            continue;
        }
        let mut row = BTreeMap::new();
        for column in columns {
            match column.get(index)? {
                AnyValue::Null => {}
                value => {
                    row.insert(column.name().to_string(), any_value_text(value));
                }
            }
        }
        if !date.is_empty() {
            row.insert("date".to_owned(), date);
        }
        rows.push(row);
    }
    Ok(())
}

fn any_value_text(value: AnyValue<'_>) -> String {
    value
        .get_str()
        .map(str::to_owned)
        .unwrap_or_else(|| value.to_string())
}

fn collect_numeric_values(
    frame: &DataFrame,
    values: &mut BTreeMap<String, Vec<f64>>,
) -> Result<(), AnalyticsError> {
    for column in frame.get_columns() {
        if !is_numeric(column.dtype()) {
            continue;
        }
        let name = column.name().to_string();
        let series = column.cast(&DataType::Float64)?;
        let target = values.entry(name).or_default();
        target.extend(series.f64()?.into_iter().flatten());
    }
    collect_derived_values(frame, values)?;
    Ok(())
}

fn collect_derived_values(
    frame: &DataFrame,
    values: &mut BTreeMap<String, Vec<f64>>,
) -> Result<(), AnalyticsError> {
    let required = [
        "open",
        "close",
        "vwap_at_open",
        "prev_day_close",
        "pm_open",
        "pmh",
        "pml",
        "hod",
        "lod",
        "m15_high",
        "m30_high",
        "m60_high",
        "m120_high",
    ];
    if required.iter().any(|name| {
        !frame
            .get_column_names()
            .iter()
            .any(|column| column.as_str() == *name)
    }) {
        return Ok(());
    }
    let open = frame.column("open")?.cast(&DataType::Float64)?;
    let close = frame.column("close")?.cast(&DataType::Float64)?;
    let vwap = frame.column("vwap_at_open")?.cast(&DataType::Float64)?;
    let prev_close = frame.column("prev_day_close")?.cast(&DataType::Float64)?;
    let pm_open = frame.column("pm_open")?.cast(&DataType::Float64)?;
    let pm_high = frame.column("pmh")?.cast(&DataType::Float64)?;
    let pm_low = frame.column("pml")?.cast(&DataType::Float64)?;
    let rth_high = frame.column("hod")?.cast(&DataType::Float64)?;
    let rth_low = frame.column("lod")?.cast(&DataType::Float64)?;
    let m15 = frame.column("m15_high")?.cast(&DataType::Float64)?;
    let m30 = frame.column("m30_high")?.cast(&DataType::Float64)?;
    let m60 = frame.column("m60_high")?.cast(&DataType::Float64)?;
    let m120 = frame.column("m120_high")?.cast(&DataType::Float64)?;
    let open = open.f64()?;
    let close = close.f64()?;
    let vwap = vwap.f64()?;
    let prev_close = prev_close.f64()?;
    let pm_open = pm_open.f64()?;
    let pm_high = pm_high.f64()?;
    let pm_low = pm_low.f64()?;
    let rth_high = rth_high.f64()?;
    let rth_low = rth_low.f64()?;
    let m15 = m15.f64()?;
    let m30 = m30.f64()?;
    let m60 = m60.f64()?;
    let m120 = m120.f64()?;
    for index in 0..frame.height() {
        let add_derived_pm_position = !values.contains_key("open_position_in_pm_range");
        let mut pair =
            |name: &str, value: f64| values.entry(name.to_owned()).or_default().push(value);
        if let (Some(o), Some(c)) = (open.get(index), close.get(index)) {
            pair("prob_close_red", if c < o { 100.0 } else { 0.0 });
        }
        if let (Some(o), Some(v)) = (open.get(index), vwap.get(index)) {
            pair("prob_open_lt_vwap", if o < v { 100.0 } else { 0.0 });
        }
        if let (Some(c), Some(p)) = (close.get(index), prev_close.get(index)) {
            pair("prob_prev_close_break_rth", if c > p { 100.0 } else { 0.0 });
        }
        if let (Some(o), Some(p)) = (pm_open.get(index), prev_close.get(index)) {
            pair(
                "prob_prev_close_break_overnight",
                if o > p { 100.0 } else { 0.0 },
            );
        }
        if let (Some(h), Some(p)) = (rth_high.get(index), pm_high.get(index)) {
            pair("prob_pm_high_break", if h > p { 100.0 } else { 0.0 });
        }
        if let (Some(c), Some(m)) = (close.get(index), m15.get(index)) {
            pair("prob_close_lt_m15", if c < m { 100.0 } else { 0.0 });
        }
        if let (Some(c), Some(m)) = (close.get(index), m30.get(index)) {
            pair("prob_close_lt_m30", if c < m { 100.0 } else { 0.0 });
        }
        if let (Some(c), Some(m)) = (close.get(index), m60.get(index)) {
            pair("prob_close_lt_m60", if c < m { 100.0 } else { 0.0 });
        }
        if let (Some(c), Some(m)) = (close.get(index), m120.get(index)) {
            pair("prob_close_lt_m120", if c < m { 100.0 } else { 0.0 });
        }
        if let (Some(c), Some(h), Some(l)) =
            (close.get(index), rth_high.get(index), rth_low.get(index))
        {
            if h > l {
                pair("close_position_in_rth_range", (c - l) / (h - l));
            }
        }
        if let (Some(o), Some(h), Some(l)) =
            (open.get(index), pm_high.get(index), pm_low.get(index))
        {
            if h > l && add_derived_pm_position {
                pair("open_position_in_pm_range", (o - l) / (h - l));
            }
        }
    }
    Ok(())
}

fn collect_overnight_timing_values(
    data_root: &Path,
    frame: &DataFrame,
    values: &mut BTreeMap<String, Vec<f64>>,
) -> Result<(), AnalyticsError> {
    let dates = frame.column("reference_date")?.date()?.physical();
    let next_dates = frame
        .column("overnight_next_reference_date")?
        .date()?
        .physical();
    let ticker_column = frame.column("ticker")?.cast(&DataType::String)?;
    let mut pairs = Vec::<(i32, i32, String)>::new();
    let mut wanted = BTreeMap::<i32, BTreeSet<String>>::new();
    let mut years = BTreeSet::new();

    for ((date, next_date), ticker) in dates
        .into_iter()
        .zip(next_dates.into_iter())
        .zip(ticker_column.str()?.into_iter())
    {
        let (Some(date), Some(next_date), Some(ticker)) = (date, next_date, ticker) else {
            continue;
        };
        let ticker = ticker.to_owned();
        pairs.push((date, next_date, ticker.clone()));
        wanted.entry(date).or_default().insert(ticker.clone());
        wanted.entry(next_date).or_default().insert(ticker);
        for value in [date, next_date] {
            if let Some(value) = NaiveDate::from_num_days_from_ce_opt(value + 719_163) {
                years.insert(value.year());
            }
        }
    }

    let profile_dir = data_root.join("runtime").join(PROFILE_STORE_DIR_NAME);
    let profile_available = !years.is_empty()
        && years.iter().all(|year| {
            profile_dir.join(format!("{year}.arrow")).is_file()
                && profile_dir
                    .join(format!("{year}.{PROFILE_VALUES_EXTENSION}"))
                    .is_file()
                && profile_dir
                    .join(format!("{year}.{PROFILE_KEYS_EXTENSION}"))
                    .is_file()
        });

    if profile_available {
        let mut profile_rows = HashMap::<(i32, String), Vec<(i32, f64)>>::new();
        let previous_wanted = BTreeMap::new();
        for year in years {
            collect_timing_profile_values(
                &profile_dir.join(format!("{year}.arrow")),
                &profile_dir.join(format!("{year}.{PROFILE_KEYS_EXTENSION}")),
                &profile_dir.join(format!("{year}.{PROFILE_VALUES_EXTENSION}")),
                &wanted,
                &previous_wanted,
                &mut profile_rows,
            )?;
        }
        for (date, next_date, ticker) in pairs {
            let Some(ah_points) = profile_rows.get(&(date, ticker.clone())) else {
                continue;
            };
            let Some(pm_points) = profile_rows.get(&(next_date, ticker)) else {
                continue;
            };
            append_overnight_timing_values(ah_points, pm_points, values);
        }
    } else {
        for (date, next_date, ticker) in pairs {
            let ah_points = read_legacy_profile_points(data_root, date, &ticker)?;
            let pm_points = read_legacy_profile_points(data_root, next_date, &ticker)?;
            if let (Some(ah_points), Some(pm_points)) = (ah_points, pm_points) {
                append_overnight_timing_values(&ah_points, &pm_points, values);
            }
        }
    }
    Ok(())
}

fn append_overnight_timing_values(
    ah_points: &[(i32, f64)],
    next_points: &[(i32, f64)],
    values: &mut BTreeMap<String, Vec<f64>>,
) {
    let mut overnight_points = ah_points
        .iter()
        .filter(|(minute, _)| *minute >= 975)
        .copied()
        .collect::<Vec<_>>();
    overnight_points.extend(
        next_points
            .iter()
            .filter(|(minute, _)| *minute < 570)
            .copied(),
    );

    let Some(overnight_high) = overnight_points
        .iter()
        .max_by(|left, right| left.1.total_cmp(&right.1))
    else {
        return;
    };
    let Some(overnight_low) = overnight_points
        .iter()
        .min_by(|left, right| left.1.total_cmp(&right.1))
    else {
        return;
    };
    values
        .entry("overnight_hod_time_minutes".to_owned())
        .or_default()
        .push(overnight_high.0 as f64);
    values
        .entry("overnight_lod_time_minutes".to_owned())
        .or_default()
        .push(overnight_low.0 as f64);

    let rth_high = next_points
        .iter()
        .filter(|(minute, _)| (570..=960).contains(minute))
        .max_by(|left, right| left.1.total_cmp(&right.1));
    let rth_low = next_points
        .iter()
        .filter(|(minute, _)| (570..=960).contains(minute))
        .min_by(|left, right| left.1.total_cmp(&right.1));
    let mut probability = |name: &str, matches: bool| {
        values
            .entry(name.to_owned())
            .or_default()
            .push(if matches { 100.0 } else { 0.0 });
    };
    probability(
        "prob_hod_overnight",
        rth_high.map_or(true, |(_, value)| overnight_high.1 >= *value),
    );
    probability(
        "prob_lod_overnight",
        rth_low.map_or(true, |(_, value)| overnight_low.1 <= *value),
    );
}

fn read_legacy_profile_points(
    data_root: &Path,
    date: i32,
    ticker: &str,
) -> Result<Option<Vec<(i32, f64)>>, AnalyticsError> {
    let Some(date) = NaiveDate::from_num_days_from_ce_opt(date + 719_163) else {
        return Ok(None);
    };
    let path = session_timeseries_path(data_root, date);
    if !path.is_file() {
        return Ok(None);
    }
    let timeseries = ParquetReader::new(File::open(path)?).finish()?;
    let ticker_column = timeseries.column("ticker")?.str()?;
    let Some(row) = ticker_column
        .into_iter()
        .position(|value| value == Some(ticker))
    else {
        return Ok(None);
    };
    let columns = timeseries.get_columns();
    let time_columns = columns
        .iter()
        .enumerate()
        .skip(2)
        .filter_map(|(index, column)| {
            let (hour, minute) = column.name().split_once(':').and_then(|(hour, minute)| {
                Some((hour.parse::<i32>().ok()?, minute.parse::<i32>().ok()?))
            })?;
            Some((index, hour * 60 + minute))
        })
        .collect::<Vec<_>>();
    let mut points = Vec::new();
    for (index, minute) in time_columns {
        if let Some(value) = columns[index]
            .f64()?
            .get(row)
            .filter(|value| value.is_finite())
        {
            points.push((minute, value));
        }
    }
    Ok(Some(points))
}

fn collect_timing_values(
    data_root: &Path,
    frame: &DataFrame,
    values: &mut BTreeMap<String, Vec<f64>>,
) -> Result<(), AnalyticsError> {
    if frame.column("overnight_next_reference_date").is_ok() {
        return collect_overnight_timing_values(data_root, frame, values);
    }
    let dates = frame.column("reference_date")?.date()?.physical();
    let next_dates = frame
        .column("overnight_next_reference_date")
        .ok()
        .and_then(|column| column.date().ok());
    let ticker_column = frame.column("ticker")?.cast(&DataType::String)?;
    let mut wanted = BTreeMap::<i32, BTreeSet<String>>::new();
    let mut previous_wanted = BTreeMap::<i32, BTreeSet<String>>::new();
    let mut previous_dates = BTreeMap::<(i32, String), i32>::new();
    let mut years = BTreeSet::new();
    for (index, (date, ticker)) in dates
        .into_iter()
        .zip(ticker_column.str()?.into_iter())
        .enumerate()
    {
        if let (Some(date), Some(ticker)) = (date, ticker) {
            let date = next_dates
                .and_then(|values| values.physical().get(index))
                .unwrap_or(date);
            wanted.entry(date).or_default().insert(ticker.to_owned());
            if let Some(date) = NaiveDate::from_num_days_from_ce_opt(date + 719_163) {
                years.insert(date.year());
                let mut previous = date - Duration::days(1);
                let mut previous_path = session_timeseries_path(data_root, previous);
                for _ in 0..7 {
                    if previous_path.is_file() {
                        break;
                    }
                    previous -= Duration::days(1);
                    previous_path = session_timeseries_path(data_root, previous);
                }
                if previous_path.is_file() {
                    let previous_day = previous.num_days_from_ce() - 719_163;
                    previous_wanted
                        .entry(previous_day)
                        .or_default()
                        .insert(ticker.to_owned());
                    previous_dates.insert(
                        (date.num_days_from_ce() - 719_163, ticker.to_owned()),
                        previous_day,
                    );
                    years.insert(previous.year());
                }
            }
        }
    }
    let profile_dir = data_root.join("runtime").join(PROFILE_STORE_DIR_NAME);
    let mut used_profile = false;
    let mut profile_rows = HashMap::<(i32, String), Vec<(i32, f64)>>::new();
    for year in years {
        let path = profile_dir.join(format!("{year}.arrow"));
        let values_path = profile_dir.join(format!("{year}.{PROFILE_VALUES_EXTENSION}"));
        let keys_path = profile_dir.join(format!("{year}.{PROFILE_KEYS_EXTENSION}"));
        if !path.is_file() || !values_path.is_file() || !keys_path.is_file() {
            continue;
        }
        used_profile = true;
        collect_timing_profile_values(
            &path,
            &keys_path,
            &values_path,
            &wanted,
            &previous_wanted,
            &mut profile_rows,
        )?;
    }
    if used_profile {
        for (date, tickers) in wanted {
            for ticker in tickers {
                let current_key = (date, ticker.clone());
                let Some(current) = profile_rows.get(&current_key) else {
                    continue;
                };
                let previous = previous_dates
                    .get(&current_key)
                    .and_then(|day| profile_rows.get(&(*day, ticker)));
                append_timing_point_values_with_previous(current, previous, values);
            }
        }
        Ok(())
    } else {
        collect_timing_values_legacy(data_root, frame, values)
    }
}

fn collect_timing_profile_values(
    profile_path: &Path,
    keys_path: &Path,
    values_path: &Path,
    wanted: &BTreeMap<i32, BTreeSet<String>>,
    previous_wanted: &BTreeMap<i32, BTreeSet<String>>,
    profile_rows: &mut HashMap<(i32, String), Vec<(i32, f64)>>,
) -> Result<(), AnalyticsError> {
    let mut reader =
        IpcReader::new(File::open(profile_path)?).memory_mapped(Some(profile_path.to_owned()));
    let schema = reader.schema()?;
    let time_columns = (2..schema.len())
        .filter_map(|index| {
            let (name, _) = schema.get_at_index(index)?;
            let (hour, minute) = name.split_once(':')?;
            Some(hour.parse::<i32>().ok()? * 60 + minute.parse::<i32>().ok()?)
        })
        .collect::<Vec<_>>();
    drop(reader);
    let mut keys_file = BufReader::new(File::open(keys_path)?);
    let key_count = read_profile_key_header(&mut keys_file, keys_path)?;
    let column_count = profile_values_column_count(values_path, time_columns.len(), key_count)?;
    let row_size = column_count * std::mem::size_of::<f64>();
    let mut key = [0_u8; 32];
    let mut selected_rows = Vec::<(usize, (i32, String))>::new();
    for row in 0..key_count {
        keys_file.read_exact(&mut key)?;
        let date = i32::from_le_bytes(key[..4].try_into().unwrap());
        let ticker_len = u16::from_le_bytes(key[4..6].try_into().unwrap()) as usize;
        let ticker = std::str::from_utf8(&key[6..6 + ticker_len]).unwrap_or("");
        if date == i32::MIN || ticker.is_empty() {
            continue;
        }
        let key = (date, ticker.to_owned());
        if wanted.get(&date).is_some_and(|set| set.contains(ticker))
            || previous_wanted
                .get(&date)
                .is_some_and(|set| set.contains(ticker))
        {
            selected_rows.push((row, key));
        }
    }
    if selected_rows.is_empty() {
        return Ok(());
    }
    let values_file = File::open(values_path)?;
    let mapped_values = unsafe { MmapOptions::new().map(&values_file)? };
    for (row, key) in selected_rows {
        let start = PROFILE_VALUES_HEADER_SIZE + row * row_size;
        let end = start + row_size;
        let points = profile_points(
            mapped_values
                .get(start..end)
                .ok_or_else(|| AnalyticsError::InvalidFilter {
                    message: format!("invalid profile values row: {}", values_path.display()),
                })?,
            &time_columns,
        );
        profile_rows.insert(key, points);
    }
    Ok(())
}

fn append_timing_point_values_with_previous(
    points: &[(i32, f64)],
    previous_points: Option<&Vec<(i32, f64)>>,
    values: &mut BTreeMap<String, Vec<f64>>,
) {
    let collect_extreme = |name: &str,
                           lower: i32,
                           upper: Option<i32>,
                           highest: bool,
                           values: &mut BTreeMap<String, Vec<f64>>| {
        let selected = points
            .iter()
            .filter(|(minute, _)| *minute >= lower && upper.map_or(true, |end| *minute < end))
            .max_by(|left, right| {
                if highest {
                    left.1.total_cmp(&right.1)
                } else {
                    right.1.total_cmp(&left.1)
                }
            });
        if let Some((minute, _)) = selected {
            values
                .entry(name.to_owned())
                .or_default()
                .push(*minute as f64);
        }
    };
    collect_extreme("hod_time_minutes", 570, Some(960), true, values);
    collect_extreme("lod_time_minutes", 570, Some(960), false, values);
    let overnight_extreme = |name: &str, highest: bool, values: &mut BTreeMap<String, Vec<f64>>| {
        let selected = points
            .iter()
            .filter(|(minute, _)| *minute < 570 || *minute >= 975)
            .max_by(|left, right| {
                if highest {
                    left.1.total_cmp(&right.1)
                } else {
                    right.1.total_cmp(&left.1)
                }
            });
        if let Some((minute, _)) = selected {
            values
                .entry(name.to_owned())
                .or_default()
                .push(*minute as f64);
        }
    };
    overnight_extreme("overnight_hod_time_minutes", true, values);
    overnight_extreme("overnight_lod_time_minutes", false, values);
    let full_high = points
        .iter()
        .max_by(|left, right| left.1.total_cmp(&right.1));
    let previous_high = previous_points.and_then(|previous| {
        previous
            .iter()
            .filter(|(minute, _)| *minute >= 975)
            .max_by(|left, right| left.1.total_cmp(&right.1))
    });
    let full_low = points
        .iter()
        .min_by(|left, right| left.1.total_cmp(&right.1));
    let previous_low = previous_points.and_then(|previous| {
        previous
            .iter()
            .filter(|(minute, _)| *minute >= 975)
            .min_by(|left, right| left.1.total_cmp(&right.1))
    });
    let mut probability = |name: &str, matches: bool| {
        values
            .entry(name.to_owned())
            .or_default()
            .push(if matches { 100.0 } else { 0.0 })
    };
    if let Some((minute, high)) = full_high {
        let previous_wins = previous_high.is_some_and(|(_, previous_high)| *previous_high > *high);
        probability(
            "prob_hod_overnight",
            !previous_wins && (*minute < 570 || *minute >= 975),
        );
    }
    if let Some((minute, low)) = full_low {
        let previous_wins = previous_low.is_some_and(|(_, previous_low)| *previous_low < *low);
        probability(
            "prob_lod_overnight",
            !previous_wins && (*minute < 570 || *minute >= 975),
        );
    }
}

fn collect_timing_values_legacy(
    data_root: &Path,
    frame: &DataFrame,
    values: &mut BTreeMap<String, Vec<f64>>,
) -> Result<(), AnalyticsError> {
    let dates = frame.column("reference_date")?.date()?.physical();
    let next_dates = frame
        .column("overnight_next_reference_date")
        .ok()
        .and_then(|column| column.date().ok());
    let ticker_column = frame.column("ticker")?.cast(&DataType::String)?;
    let tickers = ticker_column.str()?;
    let mut wanted = BTreeMap::<String, BTreeSet<String>>::new();
    for (index, (date, ticker)) in dates.into_iter().zip(tickers.into_iter()).enumerate() {
        let (Some(date), Some(ticker)) = (date, ticker) else {
            continue;
        };
        let date = next_dates
            .and_then(|values| values.physical().get(index))
            .unwrap_or(date);
        let date = NaiveDate::from_num_days_from_ce_opt(date + 719_163)
            .map(|value| value.format("%Y-%m-%d").to_string());
        if let Some(date) = date {
            wanted.entry(date).or_default().insert(ticker.to_owned());
        }
    }
    for (date, selected_tickers) in wanted {
        let path = data_root
            .join("features/session_timeseries")
            .join(format!("year={}", &date[0..4]))
            .join(format!("month={}", &date[5..7]))
            .join(format!("{date}.parquet"));
        if !path.is_file() {
            continue;
        }
        let timeseries = ParquetReader::new(File::open(path)?).finish()?;
        let ticker_column = timeseries.column("ticker")?.str()?;
        let mut ticker_rows = HashMap::new();
        for (index, ticker) in ticker_column.into_iter().enumerate() {
            if let Some(ticker) = ticker {
                ticker_rows.insert(ticker, index);
            }
        }
        let columns = timeseries.get_columns();
        let time_columns: Vec<(usize, i32)> = columns
            .iter()
            .enumerate()
            .skip(2)
            .filter_map(|(index, column)| {
                let (hour, minute) = column.name().split_once(':').and_then(|(hour, minute)| {
                    Some((hour.parse::<i32>().ok()?, minute.parse::<i32>().ok()?))
                })?;
                Some((index, hour * 60 + minute))
            })
            .collect();
        for ticker in selected_tickers {
            let Some(&row) = ticker_rows.get(ticker.as_str()) else {
                continue;
            };
            let mut points = Vec::<(i32, f64)>::new();
            for (index, minute) in &time_columns {
                if let Some(value) = columns[*index]
                    .f64()?
                    .get(row)
                    .filter(|value| value.is_finite())
                {
                    points.push((*minute, value));
                }
            }
            let collect_extreme =
                |name: &str,
                 lower: i32,
                 upper: Option<i32>,
                 highest: bool,
                 values: &mut BTreeMap<String, Vec<f64>>| {
                    let selected = points
                        .iter()
                        .filter(|(minute, _)| {
                            *minute >= lower && upper.map_or(true, |end| *minute < end)
                        })
                        .max_by(|left, right| {
                            if highest {
                                left.1.total_cmp(&right.1)
                            } else {
                                right.1.total_cmp(&left.1)
                            }
                        });
                    if let Some((minute, _)) = selected {
                        values
                            .entry(name.to_owned())
                            .or_default()
                            .push(*minute as f64);
                    }
                };
            collect_extreme("hod_time_minutes", 570, Some(960), true, values);
            collect_extreme("lod_time_minutes", 570, Some(960), false, values);
            let overnight_extreme =
                |name: &str, highest: bool, values: &mut BTreeMap<String, Vec<f64>>| {
                    let selected = points
                        .iter()
                        .filter(|(minute, _)| *minute < 570 || *minute >= 975)
                        .max_by(|left, right| {
                            if highest {
                                left.1.total_cmp(&right.1)
                            } else {
                                right.1.total_cmp(&left.1)
                            }
                        });
                    if let Some((minute, _)) = selected {
                        values
                            .entry(name.to_owned())
                            .or_default()
                            .push(*minute as f64);
                    }
                };
            overnight_extreme("overnight_hod_time_minutes", true, values);
            overnight_extreme("overnight_lod_time_minutes", false, values);

            let full_high = points
                .iter()
                .max_by(|left, right| left.1.total_cmp(&right.1));
            let full_low = points
                .iter()
                .min_by(|left, right| left.1.total_cmp(&right.1));
            let mut probability = |name: &str, matches: bool| {
                values
                    .entry(name.to_owned())
                    .or_default()
                    .push(if matches { 100.0 } else { 0.0 })
            };
            if let Some((minute, _)) = full_high {
                probability("prob_hod_overnight", *minute < 570 || *minute >= 975);
            }
            if let Some((minute, _)) = full_low {
                probability("prob_lod_overnight", *minute < 570 || *minute >= 975);
            }
        }
    }
    Ok(())
}

fn is_numeric(dtype: &DataType) -> bool {
    matches!(
        dtype,
        DataType::UInt8
            | DataType::UInt16
            | DataType::UInt32
            | DataType::UInt64
            | DataType::Int8
            | DataType::Int16
            | DataType::Int32
            | DataType::Int64
            | DataType::Float32
            | DataType::Float64
    )
}

fn summarize_values(count: u64, mut values: BTreeMap<String, Vec<f64>>) -> SessionAnalyticsSummary {
    let mut avg = BTreeMap::new();
    let mut p25 = BTreeMap::new();
    let mut median = BTreeMap::new();
    let mut p75 = BTreeMap::new();
    for (name, series) in values.iter_mut() {
        if series.is_empty() {
            continue;
        }
        let mean = series.iter().sum::<f64>() / series.len() as f64;
        avg.insert(name.clone(), mean);
        p25.insert(name.clone(), quantile(series, 0.25));
        median.insert(name.clone(), quantile(series, 0.50));
        p75.insert(name.clone(), quantile(series, 0.75));
    }
    let mut distribution_buckets = BTreeMap::new();
    let mut distribution_averages = BTreeMap::new();
    let distribution_sources = [
        ("high_spike", "rth_high_spike_pct"),
        ("low_spike", "rth_low_spike_pct"),
        ("day_return", "rth_return_pct"),
        ("overnight_return", "overnight_return_pct"),
    ];
    for (name, source) in distribution_sources {
        if let Some(series) = values.get(source) {
            let (buckets, mean) = histogram(series);
            distribution_buckets.insert(name.to_owned(), buckets);
            distribution_averages.insert(format!("{name}_avg"), mean);
        }
    }
    for (name, source) in [
        ("overnight_vol", "overnight_vol"),
        ("overnight_dollar_vol", "overnight_dollar_vol"),
    ] {
        if let Some(series) = values.get(source) {
            let (buckets, mean) = histogram(series);
            distribution_buckets.insert(name.to_owned(), buckets);
            distribution_averages.insert(format!("{name}_avg"), mean);
        }
    }
    for (name, prefix) in [
        ("hod_time", ""),
        ("lod_time", ""),
        ("overnight_hod_time", ""),
        ("overnight_lod_time", ""),
    ] {
        let source = format!("{name}_minutes");
        if let Some(series) = values.get(&source) {
            let (buckets, mean) = if name == "overnight_hod_time" || name == "overnight_lod_time" {
                overnight_time_histogram(series)
            } else {
                time_histogram(series, prefix)
            };
            distribution_buckets.insert(name.to_owned(), buckets);
            distribution_averages.insert(format!("{name}_avg"), mean);
        }
    }
    SessionAnalyticsSummary {
        count,
        avg,
        p25,
        median,
        p75,
        distribution_buckets,
        distribution_averages,
    }
}

fn histogram(values: &[f64]) -> (Vec<SessionDistributionBucket>, f64) {
    let min = values.iter().copied().fold(f64::INFINITY, f64::min);
    let max = values.iter().copied().fold(f64::NEG_INFINITY, f64::max);
    let mean = values.iter().sum::<f64>() / values.len() as f64;
    if (max - min).abs() < f64::EPSILON {
        return (
            vec![SessionDistributionBucket {
                label: format!("{min:.2}"),
                count: values.len() as u64,
            }],
            mean,
        );
    }
    let bucket_count = 12_usize;
    let width = (max - min) / bucket_count as f64;
    let mut counts = vec![0_u64; bucket_count];
    for value in values {
        let index = (((*value - min) / width).floor() as usize).min(bucket_count - 1);
        counts[index] += 1;
    }
    let buckets = counts
        .into_iter()
        .enumerate()
        .map(|(index, count)| {
            let start = min + width * index as f64;
            SessionDistributionBucket {
                label: format!("{start:.2}"),
                count,
            }
        })
        .collect();
    (buckets, mean)
}

fn time_histogram(values: &[f64], prefix: &str) -> (Vec<SessionDistributionBucket>, f64) {
    let mut counts = BTreeMap::<i32, u64>::new();
    for value in values {
        *counts.entry(*value as i32).or_default() += 1;
    }
    let buckets = counts
        .into_iter()
        .map(|(minute, count)| SessionDistributionBucket {
            label: format!("{prefix}{:02}:{:02}", minute / 60, minute % 60),
            count,
        })
        .collect();
    (
        buckets,
        values.iter().sum::<f64>() / values.len().max(1) as f64,
    )
}

fn overnight_time_histogram(values: &[f64]) -> (Vec<SessionDistributionBucket>, f64) {
    let mut counts = BTreeMap::<i32, u64>::new();
    for value in values {
        *counts.entry(*value as i32).or_default() += 1;
    }
    let buckets = counts
        .into_iter()
        .map(|(minute, count)| {
            let prefix = if minute >= 975 { "Prev " } else { "" };
            SessionDistributionBucket {
                label: format!("{prefix}{:02}:{:02}", minute / 60, minute % 60),
                count,
            }
        })
        .collect();
    (
        buckets,
        values.iter().sum::<f64>() / values.len().max(1) as f64,
    )
}

fn quantile(values: &mut [f64], probability: f64) -> f64 {
    let position = (values.len() - 1) as f64 * probability;
    let lower_index = position.floor() as usize;
    let upper_index = position.ceil() as usize;
    let lower = {
        let (_, value, _) = values.select_nth_unstable_by(lower_index, f64::total_cmp);
        *value
    };
    if lower_index == upper_index {
        return lower;
    }
    let upper = {
        let (_, value, _) = values[lower_index + 1..]
            .select_nth_unstable_by(upper_index - lower_index - 1, f64::total_cmp);
        *value
    };
    lower + (upper - lower) * (position - lower_index as f64)
}

fn append_keys(keys: &mut Vec<SessionKey>, frame: &DataFrame) -> Result<(), AnalyticsError> {
    let dates = frame.column("reference_date")?.date()?.physical();
    let ticker_column = frame.column("ticker")?.cast(&DataType::String)?;
    let tickers = ticker_column.str()?;
    for (date, ticker) in dates.into_iter().zip(tickers.into_iter()) {
        let date = date.ok_or_else(|| AnalyticsError::InvalidFilter {
            message: "session store contains a null reference_date".to_owned(),
        })?;
        let ticker = ticker.ok_or_else(|| AnalyticsError::InvalidFilter {
            message: "session store contains a null ticker".to_owned(),
        })?;
        let date = NaiveDate::from_num_days_from_ce_opt(date + 719_163).ok_or_else(|| {
            AnalyticsError::InvalidFilter {
                message: format!("invalid date value in session store: {date}"),
            }
        })?;
        keys.push(SessionKey {
            reference_date: date.format("%Y-%m-%d").to_string(),
            ticker: ticker.to_owned(),
        });
    }
    Ok(())
}

fn overnight_predicate_field(field: &str, enabled: bool) -> String {
    if !enabled {
        return field.to_owned();
    }

    // Filters are evaluated at the reference session (D), before the
    // overnight outcome is known.  They must therefore stay on D.  The
    // output layer below intentionally aligns overnight outcome columns to
    // D+1, but reusing that mapping for predicates makes fields such as
    // open_gap_pct read the next RTH open and introduces look-ahead bias.
    field.to_owned()
}

fn overnight_output_field(field: &str, enabled: bool) -> String {
    if !enabled {
        return field.to_owned();
    }

    // An overnight observation anchored on session D is AH(D) followed by
    // PM/open(D+1).  AH-specific fields therefore stay on D, while PM,
    // overnight aggregate, and opening-context fields come from D+1.
    if field == "overnight_return_pct" {
        return "overnight_next_overnight_session_return_pct".to_owned();
    }
    if field == "ah_close_to_pm_open_return_pct" {
        return "overnight_next_ah_close_to_pm_open_return_pct".to_owned();
    }
    if field == "open_gap_pct"
        || field == "prev_day_close"
        || field.starts_with("pm_")
        || field.starts_with("pmh_")
        || field.starts_with("overnight_")
    {
        return format!("overnight_next_{field}");
    }
    field.to_owned()
}

fn compile_condition(
    field: &str,
    condition: &SessionCondition,
) -> Result<(Expr, String), AnalyticsError> {
    let operator =
        normalize_operator(&condition.operator).ok_or_else(|| AnalyticsError::InvalidFilter {
            message: format!(
                "unsupported operator '{}'; use eq, neq, gt, gte, lt, or lte",
                condition.operator
            ),
        })?;
    let expression = if field == "ticker" {
        let FilterValue::Text(value) = &condition.value else {
            return Err(AnalyticsError::InvalidFilter {
                message: format!("field '{field}' requires a text value"),
            });
        };
        match operator {
            "=" => col(field).eq(lit(value.clone())),
            "!=" => col(field).neq(lit(value.clone())),
            _ => {
                return Err(AnalyticsError::InvalidFilter {
                    message: "ticker supports only eq and neq".to_owned(),
                })
            }
        }
    } else if field == "reference_date" {
        let FilterValue::Text(value) = &condition.value else {
            return Err(AnalyticsError::InvalidFilter {
                message: "reference_date requires a YYYY-MM-DD text value".to_owned(),
            });
        };
        date_predicate(value, operator)?
    } else if FILTERABLE_TEXT_FIELDS.contains(&field) {
        let FilterValue::Text(value) = &condition.value else {
            return Err(AnalyticsError::InvalidFilter {
                message: format!("field '{field}' requires a text value"),
            });
        };
        match operator {
            "=" => col(field).eq(lit(value.clone())),
            "!=" => col(field).neq(lit(value.clone())),
            _ => {
                return Err(AnalyticsError::InvalidFilter {
                    message: format!("field '{field}' supports only eq and neq"),
                })
            }
        }
    } else {
        let FilterValue::Number(value) = &condition.value else {
            return Err(AnalyticsError::InvalidFilter {
                message: format!("field '{field}' requires a numeric value"),
            });
        };
        numeric_predicate(field, operator, *value)?
    };
    Ok((
        expression,
        format!("{field} {operator} {:?}", condition.value),
    ))
}

fn numeric_predicate(field: &str, operator: &str, value: f64) -> Result<Expr, AnalyticsError> {
    let right = lit(value);
    Ok(match operator {
        "=" => col(field).eq(right),
        "!=" => col(field).neq(right),
        ">" => col(field).gt(right),
        ">=" => col(field).gt_eq(right),
        "<" => col(field).lt(right),
        "<=" => col(field).lt_eq(right),
        _ => unreachable!("operator normalized before predicate"),
    })
}

fn date_predicate(value: &str, operator: &str) -> Result<Expr, AnalyticsError> {
    parse_date(value)?;
    let right = lit(value.to_owned()).str().strptime(
        DataType::Date,
        StrptimeOptions {
            format: Some("%Y-%m-%d".into()),
            strict: true,
            exact: true,
            cache: true,
        },
        lit("raise"),
    );
    Ok(match operator {
        "=" => col("reference_date").eq(right),
        "!=" => col("reference_date").neq(right),
        ">" => col("reference_date").gt(right),
        ">=" => col("reference_date").gt_eq(right),
        "<" => col("reference_date").lt(right),
        "<=" => col("reference_date").lt_eq(right),
        _ => {
            return Err(AnalyticsError::InvalidFilter {
                message: format!("unsupported date operator '{operator}'"),
            })
        }
    })
}

fn normalize_operator(operator: &str) -> Option<&'static str> {
    match operator.to_ascii_lowercase().as_str() {
        "eq" | "=" | "==" => Some("="),
        "neq" | "ne" | "!=" => Some("!="),
        "gt" | ">" => Some(">"),
        "gte" | ">=" => Some(">="),
        "lt" | "<" => Some("<"),
        "lte" | "<=" => Some("<="),
        _ => None,
    }
}

fn canonical_field(field: &str) -> Option<&'static str> {
    let field = field.trim();
    let aliases = [
        ("date", "reference_date"),
        ("prev_close", "prev_day_close"),
        ("previous_close", "prev_day_close"),
        ("previous_close_price", "prev_day_close"),
        ("full_hod_price", "hod"),
        ("full_lod_price", "lod"),
        ("session_vol", "rth_vol"),
        ("session_dollar_vol", "rth_dollar_vol"),
        ("eod_vol", "rth_vol"),
        ("eod_dollar_vol", "rth_dollar_vol"),
        ("session_return_pct", "rth_return_pct"),
        ("session_high_spike_pct", "rth_high_spike_pct"),
        ("session_low_spike_pct", "rth_low_spike_pct"),
        ("session_range_pct", "rth_range_pct"),
        ("full_hod_time_ny", "hod_time"),
        ("full_lod_time_ny", "lod_time"),
        ("full_hod_to_lod_minutes", "rth_range_pct"),
        ("prev_day_close_price", "prev_day_close"),
        ("ah_prev_close_price", "ah_prev_close_price"),
        ("ah_prev_high_price", "ah_prev_high_price"),
        ("ah_prev_low_price", "ah_prev_low_price"),
        ("ah_prev_vol", "ah_prev_vol"),
        ("ah_prev_dollar_vol", "ah_prev_dollar_vol"),
        ("ah_prev_range_pct", "ah_prev_range_pct"),
        ("ah_prev_return_pct", "ah_prev_return_pct"),
        ("ah_prev_high_spike_pct", "ah_prev_high_spike_pct"),
        ("ah_prev_low_spike_pct", "ah_prev_low_spike_pct"),
        (
            "ah_prev_high_fade_to_pm_open_pct",
            "ah_prev_high_fade_to_pm_open_pct",
        ),
        ("ah_prev_high_time_ny", "ah_prev_high_time"),
        ("ah_prev_low_time_ny", "ah_prev_low_time"),
        ("ah_prev_hod_to_lod_minutes", "ah_prev_hod_to_lod_minutes"),
        ("overnight_high_price", "overnight_high_price"),
        ("overnight_low_price", "overnight_low_price"),
        ("overnight_range_pct", "overnight_range_pct"),
        ("overnight_return_pct", "overnight_return_pct"),
        ("overnight_high_spike_pct", "overnight_high_spike_pct"),
        ("overnight_low_spike_pct", "overnight_low_spike_pct"),
        ("overnight_high_time_ny", "overnight_high_time"),
        ("overnight_low_time_ny", "overnight_low_time"),
        (
            "overnight_hod_to_lod_minutes",
            "overnight_hod_to_lod_minutes",
        ),
        ("pm_open_price", "pm_open_price"),
        ("pm_close_price", "pm_close_price"),
        ("pm_high_price", "pm_high_price"),
        ("pm_low_price", "pm_low_price"),
        ("pm_range_pct", "pmh_gap_pct"),
        ("pm_high_spike_pct", "pm_high_spike_pct"),
        ("pm_low_spike_pct", "pm_low_spike_pct"),
        ("open_position_in_pm_range", "open_position_in_pm_range"),
        ("pmh_fade_to_open_pct", "pmh_fade_to_open_pct"),
        ("pmh_fade_to_close_pct", "pmh_fade_to_close_pct"),
        ("pmh_fade_to_m1_pct", "pmh_fade_pct"),
        ("pmh_fade_to_m5_pct", "pmh_fade_pct"),
        ("pmh_fade_to_m15_pct", "pmh_fade_pct"),
        ("pmh_fade_to_m30_pct", "pmh_fade_pct"),
        ("pmh_fade_to_m60_pct", "pmh_fade_pct"),
        ("pmh_fade_to_m90_pct", "pmh_fade_pct"),
        ("pmh_fade_to_m120_pct", "pmh_fade_pct"),
        ("pmh_fade_to_m180_pct", "pmh_fade_pct"),
        ("pm_high_time_ny", "pm_high_time"),
        ("pm_low_time_ny", "pm_low_time"),
        ("pm_hod_to_lod_minutes", "pmh_gap_pct"),
        ("open_price", "open"),
        ("close_price", "close"),
        ("hod_price", "hod"),
        ("lod_price", "lod"),
        ("rth_fade_to_close_pct", "rth_fade_pct"),
        ("close_position_in_rth_range", "rth_range_pct"),
        ("close_direction", "rth_return_pct"),
        ("m1_price", "m1_high"),
        ("m5_price", "m5_high"),
        ("m15_price", "m15_high"),
        ("m30_price", "m30_high"),
        ("m60_price", "m60_high"),
        ("m90_price", "m120_high"),
        ("m120_price", "m120_high"),
        ("m180_price", "m120_high"),
        ("m90_return_pct", "m120_return_pct"),
        ("m180_return_pct", "m120_return_pct"),
        ("ret_m1_to_close_pct", "rth_return_pct"),
        ("ret_m5_to_close_pct", "rth_return_pct"),
        ("ret_m15_to_close_pct", "rth_return_pct"),
        ("ret_m30_to_close_pct", "rth_return_pct"),
        ("ret_m60_to_close_pct", "rth_return_pct"),
        ("ret_m90_to_close_pct", "rth_return_pct"),
        ("ret_m120_to_close_pct", "rth_return_pct"),
        ("ret_m180_to_close_pct", "rth_return_pct"),
        ("m90_high_spike_pct", "m120_high_spike_pct"),
        ("m180_high_spike_pct", "m120_high_spike_pct"),
        ("m90_low_spike_pct", "m120_low_spike_pct"),
        ("m180_low_spike_pct", "m120_low_spike_pct"),
        ("m1_high_spike_price", "m1_high"),
        ("m5_high_spike_price", "m5_high"),
        ("m15_high_spike_price", "m15_high"),
        ("m30_high_spike_price", "m30_high"),
        ("m60_high_spike_price", "m60_high"),
        ("m90_high_spike_price", "m120_high"),
        ("m120_high_spike_price", "m120_high"),
        ("m180_high_spike_price", "m120_high"),
        ("m1_low_spike_price", "m1_low"),
        ("m5_low_spike_price", "m5_low"),
        ("m15_low_spike_price", "m15_low"),
        ("m30_low_spike_price", "m30_low"),
        ("m60_low_spike_price", "m60_low"),
        ("m90_low_spike_price", "m120_low"),
        ("m120_low_spike_price", "m120_low"),
        ("m180_low_spike_price", "m120_low"),
        ("vwap_open", "vwap_at_open"),
        ("vwap_m1", "vwap_at_open"),
        ("vwap_m5", "vwap_at_open"),
        ("vwap_m15", "vwap_at_open"),
        ("vwap_m30", "vwap_at_open"),
        ("vwap_m60", "vwap_at_open"),
        ("vwap_m90", "vwap_at_open"),
        ("vwap_m120", "vwap_at_open"),
        ("vwap_m180", "vwap_at_open"),
        ("hod_time_ny", "hod_time"),
        ("lod_time_ny", "lod_time"),
        ("rth_hod_to_lod_minutes", "rth_range_pct"),
        ("ah_close_price", "ah_close_price"),
        ("ah_high_price", "ah_high_price"),
        ("ah_low_price", "ah_low_price"),
        ("ah_vol", "ah_vol"),
        ("ah_dollar_vol", "ah_dollar_vol"),
        ("ah_range_pct", "ah_range_pct"),
        ("ah_return_pct", "ah_return_pct"),
        ("ah_high_spike_pct", "ah_high_spike_pct"),
        ("ah_low_spike_pct", "ah_low_spike_pct"),
        ("close_position_in_ah_range", "ah_range_pct"),
        ("ah_high_time_ny", "ah_high_time"),
        ("ah_low_time_ny", "ah_low_time"),
        ("ah_hod_to_lod_minutes", "ah_hod_to_lod_minutes"),
    ];
    if let Some((_, canonical)) = aliases.iter().find(|(alias, _)| *alias == field) {
        return Some(canonical);
    }
    match field {
        "ticker" => return Some("ticker"),
        "reference_date" => return Some("reference_date"),
        "liquidity_rank" => return Some("liquidity_rank"),
        _ => {}
    }
    FILTERABLE_NUMERIC_FIELDS
        .iter()
        .copied()
        .find(|candidate| *candidate == field)
}

const FILTERABLE_TEXT_FIELDS: &[&str] = &[
    "pm_high_time",
    "pm_low_time",
    "overnight_high_time",
    "overnight_low_time",
    "hod_time",
    "lod_time",
    "ah_prev_high_time",
    "ah_prev_low_time",
    "ah_high_time",
    "ah_low_time",
];

const FILTERABLE_NUMERIC_FIELDS: &[&str] = &[
    "open",
    "close",
    "hod",
    "lod",
    "prev_day_close",
    "pm_open",
    "pmh",
    "pml",
    "vwap_at_open",
    "m1_high",
    "m3_high",
    "m5_high",
    "m15_high",
    "m30_high",
    "m60_high",
    "m120_high",
    "m1_low",
    "m3_low",
    "m5_low",
    "m15_low",
    "m30_low",
    "m60_low",
    "m120_low",
    "overnight_vol",
    "overnight_dollar_vol",
    "pm_vol",
    "pm_dollar_vol",
    "rth_vol",
    "rth_dollar_vol",
    "open_gap_pct",
    "pm_high_spike_pct",
    "pmh_gap_pct",
    "rth_high_spike_pct",
    "rth_low_spike_pct",
    "pmh_fade_pct",
    "overnight_fade_pct",
    "overnight_return_pct",
    "ah_prev_return_pct",
    "ah_return_pct",
    "ah_prev_high_spike_pct",
    "ah_prev_low_spike_pct",
    "ah_prev_range_pct",
    "ah_high_spike_pct",
    "ah_low_spike_pct",
    "ah_range_pct",
    "rth_fade_pct",
    "m1_high_spike_pct",
    "m3_high_spike_pct",
    "m5_high_spike_pct",
    "m15_high_spike_pct",
    "m30_high_spike_pct",
    "m60_high_spike_pct",
    "m120_high_spike_pct",
    "m1_low_spike_pct",
    "m3_low_spike_pct",
    "m5_low_spike_pct",
    "m15_low_spike_pct",
    "m30_low_spike_pct",
    "m60_low_spike_pct",
    "m120_low_spike_pct",
    "pm_return_pct",
    "rth_return_pct",
    "previous_day_change_pct",
    "change_pct",
    "m1_return_pct",
    "m3_return_pct",
    "m5_return_pct",
    "m15_return_pct",
    "m30_return_pct",
    "m60_return_pct",
    "m120_return_pct",
    "rth_range_pct",
    "return_3y_pct",
    "return_2y_pct",
    "return_1y_pct",
    "return_6m_pct",
    "return_3m_pct",
    "return_1m_pct",
    "return_2w_pct",
    "return_1w_pct",
];

fn parse_date(value: &str) -> Result<NaiveDate, AnalyticsError> {
    NaiveDate::parse_from_str(value, "%Y-%m-%d").map_err(|_| AnalyticsError::InvalidDate {
        value: value.to_owned(),
    })
}

fn years_between(date_from: &str, date_to: &str) -> Result<Vec<i32>, AnalyticsError> {
    let from = parse_date(date_from)?.year();
    let to = parse_date(date_to)?.year();
    Ok((from..=to).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overnight_filters_use_reference_session_data() {
        assert_eq!(
            overnight_predicate_field("open_gap_pct", true),
            "open_gap_pct"
        );
        assert_eq!(overnight_predicate_field("change_pct", true), "change_pct");
        assert_eq!(
            overnight_output_field("open_gap_pct", true),
            "overnight_next_open_gap_pct"
        );
    }

    #[test]
    fn overnight_open_gap_filter_is_rendered_without_next_day_alignment() {
        let config = SessionFilterConfig {
            date_from: "2024-01-01".to_owned(),
            date_to: "2024-01-31".to_owned(),
            liquidity_top: None,
            ticker: None,
            analysis_mode: Some("overnight".to_owned()),
            max_tickers_per_day: None,
            min_tickers_per_day: None,
            conditions: vec![SessionCondition {
                field_id: "open_gap_pct".to_owned(),
                operator: "gte".to_owned(),
                value: FilterValue::Number(2.0),
                lookback_days: None,
            }],
        };

        let plan = SessionSelector::compile(&config).expect("overnight plan should compile");
        assert!(plan.description.contains("open_gap_pct"));
        assert!(!plan.description.contains("overnight_next_open_gap_pct"));
        assert!(plan
            .required_columns
            .iter()
            .any(|column| column == "open_gap_pct"));
    }
}
