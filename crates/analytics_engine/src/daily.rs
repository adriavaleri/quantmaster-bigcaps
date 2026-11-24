use std::{
    cmp::Ordering,
    collections::{BTreeMap, BinaryHeap, HashMap, HashSet},
    fs::{self, File},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, OnceLock},
    time::Instant,
};

use chrono::NaiveDate;
use polars::prelude::*;
use serde::{Deserialize, Serialize};

use crate::AnalyticsError;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyAnalyticsFilter {
    #[serde(default)]
    pub date_from: Option<String>,
    #[serde(default)]
    pub date_to: Option<String>,
    #[serde(default)]
    pub ticker: Option<String>,
    #[serde(default)]
    pub search: Option<String>,
    #[serde(default)]
    pub max_events_per_day: Option<u32>,
    #[serde(default)]
    pub conditions: Vec<DailyFeatureCondition>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyFeatureCondition {
    pub field: String,
    pub operator: String,
    #[serde(default)]
    pub value: Option<f64>,
    #[serde(default)]
    pub upper_value: Option<f64>,
    #[serde(default)]
    pub compare_to: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyFeatureInfo {
    pub name: String,
    pub data_type: String,
    pub filterable: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyAnalyticsRow {
    pub date: String,
    pub ticker: String,
    pub open: f64,
    pub high: Option<f64>,
    pub low: Option<f64>,
    pub close: f64,
    pub volume: Option<f64>,
    pub return_pct: f64,
    pub features: BTreeMap<String, Option<f64>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyAnalyticsSummary {
    pub observations: u64,
    pub tickers: u64,
    pub days: u64,
    pub mean_return_pct: Option<f64>,
    pub median_return_pct: Option<f64>,
    pub positive_return_pct: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyStockFilterSummary {
    pub total_results: u64,
    pub events_per_day: Vec<DailyEventCount>,
    pub average_rth_return_pct: Option<f64>,
    pub p25_rth_return_pct: Option<f64>,
    pub median_rth_return_pct: Option<f64>,
    pub p75_rth_return_pct: Option<f64>,
    pub average_next_day_rth_return_pct: Option<f64>,
    pub p25_next_day_rth_return_pct: Option<f64>,
    pub median_next_day_rth_return_pct: Option<f64>,
    pub p75_next_day_rth_return_pct: Option<f64>,
    pub forward_rth_returns: Vec<DailyForwardReturnSummary>,
    pub forward_from_close_returns: Vec<DailyForwardReturnSummary>,
    pub cumulative_returns: Vec<DailyCumulativeReturnPoint>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyEventCount {
    pub date: String,
    pub count: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyForwardReturnSummary {
    pub market_sessions_after: u8,
    pub observations: u64,
    pub positive_return_pct: Option<f64>,
    pub average_return_pct: Option<f64>,
    pub p25_return_pct: Option<f64>,
    pub median_return_pct: Option<f64>,
    pub p75_return_pct: Option<f64>,
    pub cumulative_returns: Vec<DailyCumulativeReturnPoint>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyCumulativeReturnPoint {
    pub date: String,
    pub observations: u64,
    pub daily_return_sum_pct: f64,
    pub cumulative_return_pct: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyReturnPoint {
    pub date: String,
    pub observations: u64,
    pub mean_return_pct: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DailyAnalyticsResult {
    pub summary: DailyAnalyticsSummary,
    pub daily_returns: Vec<DailyReturnPoint>,
    pub rows: Vec<DailyAnalyticsRow>,
    pub total_rows: u64,
    pub page: u32,
    pub page_size: u32,
    pub months_scanned: u32,
    pub elapsed_ms: u64,
}

#[derive(Clone)]
struct DailyExplorerCache {
    key: String,
    frame: Arc<DataFrame>,
    summary: DailyStockFilterSummary,
    analytics_summary: DailyAnalyticsSummary,
    daily_returns: Vec<DailyReturnPoint>,
    feature_names: HashSet<String>,
    months_scanned: u32,
}

static DAILY_EXPLORER_CACHE: OnceLock<Mutex<Option<DailyExplorerCache>>> = OnceLock::new();
const DAILY_EXPLORER_CACHE_MAX_ROWS: usize = 250_000;

const MARKET_BREADTH_FIELDS: [&str; 6] = [
    "ad_line",
    "adn",
    "rasi",
    "rasi_percentile_252d",
    "above_sma40",
    "ratio10d",
];

fn market_breadth_path(data_root: &Path) -> PathBuf {
    data_root.join("market-breath/indicators/combined/combined.parquet")
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MarketBreadthPoint {
    pub date: String,
    pub ad_line: Option<f64>,
    pub adn: Option<f64>,
    pub rasi: Option<f64>,
    pub rasi_percentile_252d: Option<f64>,
    pub above_sma40: Option<f64>,
    pub ratio10d: Option<f64>,
}

fn market_breadth_frame(data_root: &Path) -> Result<Option<DataFrame>, AnalyticsError> {
    let path = market_breadth_path(data_root);
    if !path.is_file() {
        return Ok(None);
    }
    let frame = read_frame(&path)?
        .lazy()
        .with_column(col("date").cast(DataType::Date))
        .sort(["date"], SortMultipleOptions::default())
        .collect()?;
    let dates = frame.column("date")?.date()?.physical();
    if dates.into_iter().flatten().collect::<HashSet<_>>().len() != frame.height() {
        return Err(invalid_filter("Market breadth requires one row per market date"));
    }
    Ok(Some(frame))
}

pub fn market_breadth_history(data_root: &Path) -> Result<Vec<MarketBreadthPoint>, AnalyticsError> {
    let Some(frame) = market_breadth_frame(data_root)? else {
        return Ok(Vec::new());
    };
    let dates = frame.column("date")?.cast(&DataType::String)?;
    let dates = dates.str()?;
    let ad_line = float_column(&frame, "ad_line")?;
    let adn = float_column(&frame, "adn")?;
    let rasi = float_column(&frame, "rasi")?;
    let rasi_percentile_252d = float_column(&frame, "rasi_percentile_252d")?;
    let above_sma40 = float_column(&frame, "above_sma40")?;
    let ratio10d = float_column(&frame, "ratio10d")?;
    Ok(dates.into_iter().enumerate().filter_map(|(row, date)| {
        Some(MarketBreadthPoint {
            date: date?.to_owned(),
            ad_line: finite(ad_line.get(row)),
            adn: finite(adn.get(row)),
            rasi: finite(rasi.get(row)),
            rasi_percentile_252d: finite(rasi_percentile_252d.get(row)),
            above_sma40: finite(above_sma40.get(row)),
            ratio10d: finite(ratio10d.get(row)),
        })
    }).collect())
}

fn read_market_breadth(data_root: &Path) -> Result<Option<DataFrame>, AnalyticsError> {
    let Some(frame) = market_breadth_frame(data_root)? else {
        return Ok(None);
    };
    let mut columns = vec![col("date").alias("__breadth_date")];
    // Daily breadth uses closing prices. Put each value on the next
    // published market session so an at-open filter cannot see its own close.
    columns.extend(MARKET_BREADTH_FIELDS.iter().map(|field| {
        col(*field)
            .cast(DataType::Float64)
            .shift(lit(1))
            .alias(format!("breadth_{field}"))
    }));
    Ok(Some(frame.lazy().select(columns).collect()?))
}

fn with_market_breadth(
    features: LazyFrame,
    date_field: &str,
    breadth: Option<&DataFrame>,
) -> LazyFrame {
    match breadth {
        Some(frame) => features.left_join(
            frame.clone().lazy(),
            col(date_field).cast(DataType::Date),
            col("__breadth_date"),
        ),
        None => features,
    }
}

fn daily_numeric_feature_names(
    features: &DataFrame,
    breadth: Option<&DataFrame>,
) -> HashSet<String> {
    features
        .get_columns()
        .iter()
        .chain(breadth.into_iter().flat_map(|frame| frame.get_columns()))
        .filter(|column| is_filterable_numeric(column.name().as_str(), column.dtype()))
        .map(|column| column.name().to_string())
        .collect()
}

fn daily_explorer_cache_key(data_root: &Path, filters: &DailyAnalyticsFilter) -> String {
    let mut filters = filters.clone();
    filters.search = None;
    let root = data_root.canonicalize().unwrap_or_else(|_| data_root.to_path_buf());
    let breadth_version = fs::metadata(market_breadth_path(&root))
        .ok()
        .map(|metadata| (metadata.len(), metadata.modified().ok()));
    format!("{}|{filters:?}|{breadth_version:?}", root.display())
}

fn cached_daily_explorer(key: &str) -> Option<DailyExplorerCache> {
    DAILY_EXPLORER_CACHE
        .get_or_init(|| Mutex::new(None))
        .lock()
        .ok()?
        .as_ref()
        .filter(|cache| cache.key == key)
        .cloned()
}

fn store_daily_explorer(cache: DailyExplorerCache) {
    if let Ok(mut current) = DAILY_EXPLORER_CACHE.get_or_init(|| Mutex::new(None)).lock() {
        *current = Some(cache);
    }
}

fn clear_daily_explorer_cache() {
    if let Ok(mut current) = DAILY_EXPLORER_CACHE.get_or_init(|| Mutex::new(None)).lock() {
        *current = None;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DailyExplorerSortColumn {
    Date,
    Ticker,
    Numeric,
}

fn daily_explorer_sort_column(
    sort_col: &str,
    feature_names: &HashSet<String>,
) -> DailyExplorerSortColumn {
    match sort_col {
        "date" => DailyExplorerSortColumn::Date,
        "ticker" => DailyExplorerSortColumn::Ticker,
        name if feature_names.contains(name) => DailyExplorerSortColumn::Numeric,
        _ => DailyExplorerSortColumn::Date,
    }
}

fn compare_optional_number(left: Option<f64>, right: Option<f64>, descending: bool) -> Ordering {
    match (left, right) {
        (Some(left), Some(right)) => {
            let ordering = left.total_cmp(&right);
            if descending { ordering.reverse() } else { ordering }
        }
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => Ordering::Equal,
    }
}

fn compare_daily_explorer_values(
    sort_column: DailyExplorerSortColumn,
    descending: bool,
    left_date: &str,
    left_ticker: &str,
    left_value: Option<f64>,
    right_date: &str,
    right_ticker: &str,
    right_value: Option<f64>,
) -> Ordering {
    let primary = match sort_column {
        DailyExplorerSortColumn::Date => {
            let ordering = left_date.cmp(right_date);
            if descending { ordering.reverse() } else { ordering }
        }
        DailyExplorerSortColumn::Ticker => {
            let ordering = left_ticker.cmp(right_ticker);
            if descending { ordering.reverse() } else { ordering }
        }
        DailyExplorerSortColumn::Numeric => {
            compare_optional_number(left_value, right_value, descending)
        }
    };

    primary
        .then_with(|| left_ticker.cmp(right_ticker))
        .then_with(|| right_date.cmp(left_date))
}

#[derive(Debug, Clone)]
struct DailyExplorerHeapKey {
    sort_column: DailyExplorerSortColumn,
    descending: bool,
    date: String,
    ticker: String,
    sort_value: Option<f64>,
    sequence: u64,
}

impl PartialEq for DailyExplorerHeapKey {
    fn eq(&self, other: &Self) -> bool {
        self.cmp(other) == Ordering::Equal
    }
}

impl Eq for DailyExplorerHeapKey {}

impl PartialOrd for DailyExplorerHeapKey {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for DailyExplorerHeapKey {
    fn cmp(&self, other: &Self) -> Ordering {
        compare_daily_explorer_values(
            self.sort_column,
            self.descending,
            &self.date,
            &self.ticker,
            self.sort_value,
            &other.date,
            &other.ticker,
            other.sort_value,
        )
        .then_with(|| self.sequence.cmp(&other.sequence))
    }
}

#[derive(Debug, Clone)]
struct DailyExplorerHeapRow {
    key: DailyExplorerHeapKey,
    row: DailyAnalyticsRow,
}

impl PartialEq for DailyExplorerHeapRow {
    fn eq(&self, other: &Self) -> bool {
        self.key == other.key
    }
}

impl Eq for DailyExplorerHeapRow {}

impl PartialOrd for DailyExplorerHeapRow {
    fn partial_cmp(&self, other: &Self) -> Option<Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for DailyExplorerHeapRow {
    fn cmp(&self, other: &Self) -> Ordering {
        self.key.cmp(&other.key)
    }
}

#[derive(Debug, Clone, Copy)]
struct DailyBar {
    open: f64,
    high: Option<f64>,
    low: Option<f64>,
    close: f64,
    volume: Option<f64>,
}

#[derive(Debug, Clone, Copy, Default)]
struct DailyAccumulation {
    count: u64,
    return_sum: f64,
}

#[derive(Debug, Clone, Copy)]
enum FilterOperator {
    Eq,
    Ne,
    Gt,
    Gte,
    Lt,
    Lte,
    Between,
    IsNull,
    IsNotNull,
}

#[derive(Debug, Clone)]
struct CompiledCondition {
    field: String,
    operator: FilterOperator,
    value: Option<f64>,
    upper_value: Option<f64>,
    compare_to: Option<String>,
}

struct MonthlySource {
    year: i32,
    month: u32,
    daily_path: PathBuf,
    features_path: PathBuf,
}

struct DailyFeatureSource {
    year: i32,
    month: u32,
    features_path: PathBuf,
}

impl DailyAnalyticsFilter {
    fn validate(
        &self,
        feature_names: &HashSet<String>,
    ) -> Result<(Option<String>, Option<String>, Vec<CompiledCondition>), AnalyticsError> {
        if self.max_events_per_day == Some(0) {
            return Err(invalid_filter("maxEventsPerDay must be at least 1"));
        }
        if self.max_events_per_day.is_some() && !feature_names.contains("market_cap_estimated") {
            return Err(invalid_filter(
                "maxEventsPerDay requires market_cap_estimated in daily_features",
            ));
        }
        let date_from = parse_optional_date(self.date_from.as_deref())?;
        let date_to = parse_optional_date(self.date_to.as_deref())?;
        if let (Some(from), Some(to)) = (&date_from, &date_to) {
            if from > to {
                return Err(invalid_filter("dateFrom must be on or before dateTo"));
            }
        }

        let mut compiled = Vec::with_capacity(self.conditions.len());
        for condition in &self.conditions {
            let field = condition.field.trim();
            if !feature_names.contains(field) {
                return Err(invalid_filter(format!(
                    "'{field}' is not a numeric column in daily_features"
                )));
            }
            let operator = parse_operator(&condition.operator)?;
            let compare_to = condition
                .compare_to
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned);
            if let Some(other_field) = &compare_to {
                if !feature_names.contains(other_field) {
                    return Err(invalid_filter(format!(
                        "'{other_field}' is not a numeric column in daily_features"
                    )));
                }
                if matches!(
                    operator,
                    FilterOperator::Between | FilterOperator::IsNull | FilterOperator::IsNotNull
                ) {
                    return Err(invalid_filter(
                        "between and null operators cannot compare two feature columns",
                    ));
                }
                if condition.value.is_some() || condition.upper_value.is_some() {
                    return Err(invalid_filter(
                        "value and upperValue must be empty when compareTo is set",
                    ));
                }
            }

            match operator {
                FilterOperator::IsNull | FilterOperator::IsNotNull => {
                    if condition.value.is_some()
                        || condition.upper_value.is_some()
                        || compare_to.is_some()
                    {
                        return Err(invalid_filter(
                            "null operators do not accept value, upperValue, or compareTo",
                        ));
                    }
                }
                FilterOperator::Between => {
                    let (Some(lower), Some(upper)) = (condition.value, condition.upper_value)
                    else {
                        return Err(invalid_filter("between requires value and upperValue"));
                    };
                    if !lower.is_finite() || !upper.is_finite() || lower > upper {
                        return Err(invalid_filter(
                            "between bounds must be finite and value must not exceed upperValue",
                        ));
                    }
                }
                _ if compare_to.is_none() => {
                    if condition.upper_value.is_some() {
                        return Err(invalid_filter("upperValue is only valid for between"));
                    }
                    if !condition.value.is_some_and(f64::is_finite) {
                        return Err(invalid_filter("this operator requires a finite value"));
                    }
                }
                _ => {}
            }

            compiled.push(CompiledCondition {
                field: field.to_owned(),
                operator,
                value: condition.value,
                upper_value: condition.upper_value,
                compare_to,
            });
        }
        Ok((date_from, date_to, compiled))
    }
}

pub fn daily_feature_catalog(data_root: &Path) -> Result<Vec<DailyFeatureInfo>, AnalyticsError> {
    let months = daily_feature_sources(data_root, None, None)?;
    let source = months.first().ok_or_else(|| {
        invalid_filter(format!(
            "No daily_features partitions were found under {}",
            data_root.display()
        ))
    })?;
    let mut reader = ParquetReader::new(File::open(&source.features_path)?);
    let schema = reader.schema()?;
    let mut catalog: Vec<_> = schema
        .iter()
        .map(|(name, field)| {
            let dtype = DataType::from_arrow_field(field);
            DailyFeatureInfo {
                name: name.to_string(),
                data_type: format!("{dtype:?}"),
                filterable: is_filterable_numeric(name, &dtype),
            }
        })
        .collect();
    if let Some(breadth) = read_market_breadth(data_root)? {
        catalog.extend(
            breadth.get_columns().iter()
                .filter(|column| is_numeric(column.dtype()))
                .map(|column| DailyFeatureInfo {
                    name: column.name().to_string(),
                    data_type: format!("{:?}", column.dtype()),
                    filterable: true,
                }),
        );
    }
    Ok(catalog)
}

/// Counts matching daily stock observations using only `daily_features`.
/// It reads only fields referenced by filters and never reads daily bars or
/// computes returns/statistics.
pub fn count_daily_stocks(
    data_root: &Path,
    filters: DailyAnalyticsFilter,
) -> Result<u64, AnalyticsError> {
    let all_months = daily_feature_sources(data_root, None, None)?;
    let sample = all_months.first().ok_or_else(|| {
        invalid_filter(format!(
            "No daily_features partitions were found under {}",
            data_root.display()
        ))
    })?;
    let sample_frame = read_frame(&sample.features_path)?;
    let date_field = daily_date_field(&sample_frame)?;
    let ticker_field = daily_ticker_field(&sample_frame)?;
    let breadth = read_market_breadth(data_root)?;
    let feature_names = daily_numeric_feature_names(&sample_frame, breadth.as_ref());
    let (date_from, date_to, conditions) = filters.validate(&feature_names)?;
    let months = daily_feature_sources(data_root, date_from.as_deref(), date_to.as_deref())?;
    let ticker_filter = filters
        .ticker
        .as_deref()
        .map(str::trim)
        .filter(|ticker| !ticker.is_empty())
        .map(str::to_ascii_uppercase);

    if months.is_empty() {
        return Ok(0);
    }

    let mut predicate = conditions_predicate(&conditions)
        .and(col(date_field).is_not_null())
        .and(col(ticker_field).is_not_null());
    if let Some(from) = date_from.as_deref().filter(|value| &value[8..10] != "01") {
        predicate = predicate.and(
            col(date_field)
                .cast(DataType::Date)
                .cast(DataType::String)
                .gt_eq(lit(from.to_owned())),
        );
    }
    if let Some(to) = date_to
        .as_deref()
        .filter(|value| date_needs_upper_filter(value))
    {
        predicate = predicate.and(
            col(date_field)
                .cast(DataType::Date)
                .cast(DataType::String)
                .lt_eq(lit(to.to_owned())),
        );
    }
    if let Some(filter) = ticker_filter {
        predicate = predicate.and(
            col(ticker_field)
                .cast(DataType::String)
                .str()
                .to_uppercase()
                .str()
                .contains_literal(lit(filter)),
        );
    }

    let parquet_paths: Arc<[PlPath]> = months
        .iter()
        .map(|source| PlPath::new(&source.features_path.to_string_lossy()))
        .collect::<Vec<_>>()
        .into();
    let source = LazyFrame::scan_parquet_files(parquet_paths, ScanArgsParquet::default())?;
    let needs_breadth = conditions.iter().any(|condition| {
        condition.field.starts_with("breadth_")
            || condition.compare_to.as_deref().is_some_and(|field| field.starts_with("breadth_"))
    });
    let mut query = with_market_breadth(source, date_field, breadth.as_ref().filter(|_| needs_breadth))
        .filter(predicate);
    query = apply_market_cap_daily_limit(query, filters.max_events_per_day);
    let counts = query
        .select([len().alias("total_results")])
        .collect()
        .map_err(AnalyticsError::from)?;

    let total_results = counts.column("total_results")?.cast(&DataType::UInt64)?;
    Ok(total_results.u64()?.get(0).unwrap_or(0))
}

/// Returns the matching ticker-days and their average regular-session return.
/// Both values are aggregated directly from daily_features in one parquet scan.
pub fn summarize_daily_stocks(
    data_root: &Path,
    filters: DailyAnalyticsFilter,
) -> Result<DailyStockFilterSummary, AnalyticsError> {
    let cache_key = daily_explorer_cache_key(data_root, &filters);
    if let Some(cache) = cached_daily_explorer(&cache_key) {
        return Ok(cache.summary);
    }

    let all_months = daily_feature_sources(data_root, None, None)?;
    let sample = all_months.first().ok_or_else(|| {
        invalid_filter(format!(
            "No daily_features partitions were found under {}",
            data_root.display()
        ))
    })?;
    let sample_frame = read_frame(&sample.features_path)?;
    let date_field = daily_date_field(&sample_frame)?;
    let ticker_field = daily_ticker_field(&sample_frame)?;
    let breadth = read_market_breadth(data_root)?;
    let feature_names = daily_numeric_feature_names(&sample_frame, breadth.as_ref());
    if !feature_names.contains("rth_return_pct") {
        return Err(invalid_filter("daily_features must contain rth_return_pct"));
    }
    let (return_horizons, return_fields) = {
        let mut horizons = vec![0, 1];
        let mut fields = vec![
            "rth_return_pct".to_owned(),
            "next_day_rth_return_pct".to_owned(),
        ];
        for days in (2..=10).chain((15..=40).step_by(5)) {
            let field = format!("forward_rth_return_{days}d_pct");
            // Older datasets can still provide the horizons they contain.
            if sample_frame.column(&field).is_ok() {
                horizons.push(days);
                fields.push(field);
            }
        }
        (horizons, fields)
    };
    let (date_from, date_to, conditions) = filters.validate(&feature_names)?;
    let months = daily_feature_sources(data_root, date_from.as_deref(), date_to.as_deref())?;
    if months.is_empty() {
        return Ok(DailyStockFilterSummary {
            total_results: 0,
            events_per_day: Vec::new(),
            average_rth_return_pct: None,
            p25_rth_return_pct: None,
            median_rth_return_pct: None,
            p75_rth_return_pct: None,
            average_next_day_rth_return_pct: None,
            p25_next_day_rth_return_pct: None,
            median_next_day_rth_return_pct: None,
            p75_next_day_rth_return_pct: None,
            forward_rth_returns: Vec::new(),
            forward_from_close_returns: Vec::new(),
            cumulative_returns: Vec::new(),
        });
    }

    let ticker_filter = filters
        .ticker
        .as_deref()
        .map(str::trim)
        .filter(|ticker| !ticker.is_empty())
        .map(str::to_ascii_uppercase);
    let mut predicate = conditions_predicate(&conditions)
        .and(col(date_field).is_not_null())
        .and(col(ticker_field).is_not_null());
    if let Some(from) = date_from.as_deref().filter(|value| &value[8..10] != "01") {
        predicate = predicate.and(
            col(date_field)
                .cast(DataType::Date)
                .cast(DataType::String)
                .gt_eq(lit(from.to_owned())),
        );
    }
    if let Some(to) = date_to
        .as_deref()
        .filter(|value| date_needs_upper_filter(value))
    {
        predicate = predicate.and(
            col(date_field)
                .cast(DataType::Date)
                .cast(DataType::String)
                .lt_eq(lit(to.to_owned())),
        );
    }
    if let Some(filter) = ticker_filter {
        predicate = predicate.and(
            col(ticker_field)
                .cast(DataType::String)
                .str()
                .to_uppercase()
                .str()
                .contains_literal(lit(filter)),
        );
    }

    let feature_paths: Arc<[PlPath]> = months
        .iter()
        .map(|source| PlPath::new(&source.features_path.to_string_lossy()))
        .collect::<Vec<_>>()
        .into();
    let return_field = &return_fields[0];
    let current_return = col(return_field).cast(DataType::Float64);
    let source = LazyFrame::scan_parquet_files(feature_paths, ScanArgsParquet::default())?;
    let market_days = source.clone().select([
        col(date_field).cast(DataType::Date).drop_nulls().unique().alias("market_date"),
    ]).collect()?;
    let mut query = with_market_breadth(source, date_field, breadth.as_ref()).filter(predicate);
    query = apply_market_cap_daily_limit(query, filters.max_events_per_day);
    let mut selected_columns = vec![
        col(date_field).cast(DataType::Date).alias("session_date"),
        col(ticker_field).cast(DataType::String).alias("ticker"),
    ];
    selected_columns.extend(return_fields.iter().enumerate().map(|(index, field)| {
        let alias = match index {
            0 => "return_pct".to_owned(),
            1 => "next_day_return_pct".to_owned(),
            _ => format!("forward_return_{index}d_pct"),
        };
        col(field).cast(DataType::Float64).alias(alias)
    }));
    let mut sorted_feature_names = feature_names.iter().cloned().collect::<Vec<_>>();
    sorted_feature_names.sort();
    selected_columns.extend(sorted_feature_names.iter().map(|name| col(name)));
    let matched_returns = query
        .filter(current_return.is_finite())
        .select(selected_columns)
        .collect()
        .map_err(AnalyticsError::from)?;
    let explorer_frame = Arc::new(matched_returns.clone());
    let matched_tickers = string_values(&matched_returns, "ticker")?
        .into_iter()
        .flatten()
        .collect::<HashSet<_>>();

    let dates = matched_returns.column("session_date")?.date()?.physical();
    let forward_return_columns = (0..return_fields.len())
        .map(|index| {
            let name = match index {
                0 => "return_pct".to_owned(),
                1 => "next_day_return_pct".to_owned(),
                _ => format!("forward_return_{index}d_pct"),
            };
            matched_returns.column(&name)?.f64()
        })
        .collect::<PolarsResult<Vec<_>>>()?;
    let mut grouped_returns = BTreeMap::<i32, (u64, f64)>::new();
    let initial_return_capacity = matched_returns.height().min(250_000);
    let current_returns = forward_return_columns[0];
    let mut positive_return_count = 0_u64;
    for (index, date) in dates.into_iter().enumerate() {
        let (Some(date), Some(value)) = (date, finite(current_returns.get(index))) else {
            continue;
        };
        positive_return_count += u64::from(value > 0.0);
        let daily = grouped_returns.entry(date).or_insert((0, 0.0));
        daily.0 = daily.0.saturating_add(1);
        daily.1 += value;
    }

    let daily_dates: Vec<i32> = grouped_returns.keys().copied().collect();
    let daily_index: HashMap<i32, usize> = daily_dates
        .iter().copied().enumerate().map(|(index, date)| (date, index)).collect();
    let daily_slots: Vec<Option<usize>> = dates
        .into_iter()
        .map(|date| daily_index.get(&date?).copied())
        .collect();

    // Keep only one horizon's samples in memory at a time.
    let mut forward_rth_returns = Vec::with_capacity(return_horizons.len());
    let mut forward_from_close_returns = Vec::new();
    for (days, column) in return_horizons.into_iter().zip(forward_return_columns) {
        let mut open_values = Vec::with_capacity(initial_return_capacity);
        let mut close_values = Vec::new();
        let mut open_daily = vec![(0_u64, 0.0); daily_dates.len()];
        let mut close_daily = vec![(0_u64, 0.0); daily_dates.len()];
        for ((&slot, base), exit) in daily_slots.iter().zip(current_returns).zip(column) {
            let (Some(slot), Some(base), Some(exit)) = (slot, finite(base), finite(exit)) else {
                continue;
            };
            open_values.push(exit);
            open_daily[slot].0 += 1;
            open_daily[slot].1 += exit;
            // Divide the two D0-open price ratios to preserve the split adjustment.
            let close_factor = 1.0 + base / 100.0;
            if close_factor > 0.0 {
                if let Some(rebased) = finite(Some(100.0 * ((1.0 + exit / 100.0) / close_factor - 1.0))) {
                    close_values.push(rebased);
                    close_daily[slot].0 += 1;
                    close_daily[slot].1 += rebased;
                }
            }
        }
        let cumulative = |daily: Vec<(u64, f64)>| {
            cumulative_return_points(daily_dates.iter().copied().zip(daily).filter(|(_, (count, _))| *count > 0))
        };
        let mut open = summarize_forward_returns(days, open_values);
        open.cumulative_returns = cumulative(open_daily)?;
        let mut close = summarize_forward_returns(days, close_values);
        close.cumulative_returns = cumulative(close_daily)?;
        forward_from_close_returns.push(close);
        forward_rth_returns.push(open);
    }
    drop(matched_returns);
    let current = &forward_rth_returns[0];
    let next_day = &forward_rth_returns[1];
    let total_results = grouped_returns
        .values()
        .map(|(count, _)| *count)
        .sum::<u64>();
    let total_days = grouped_returns.len() as u64;
    let daily_returns = grouped_returns
        .iter()
        .map(|(date_days, (observations, daily_return_sum_pct))| {
            let date = NaiveDate::from_num_days_from_ce_opt(*date_days + 719_163)
                .ok_or_else(|| invalid_filter(format!("Invalid date value {date_days}")))?;
            Ok(DailyReturnPoint {
                date: date.format("%Y-%m-%d").to_string(),
                observations: *observations,
                mean_return_pct: *daily_return_sum_pct / *observations as f64,
            })
        })
        .collect::<Result<Vec<_>, AnalyticsError>>()?;
    let mut events_per_day = Vec::new();
    for day in market_days.column("market_date")?.date()?.physical().into_iter().flatten() {
        let date = NaiveDate::from_num_days_from_ce_opt(day + 719_163)
            .ok_or_else(|| invalid_filter(format!("Invalid date value {day}")))?
            .format("%Y-%m-%d").to_string();
        if date_from.as_ref().is_some_and(|from| &date < from)
            || date_to.as_ref().is_some_and(|to| &date > to)
        {
            continue;
        }
        let count = grouped_returns.get(&day).map_or(0, |(count, _)| *count);
        events_per_day.push(DailyEventCount { date, count });
    }
    events_per_day.sort_unstable_by(|a, b| a.date.cmp(&b.date));
    let cumulative_returns = cumulative_return_points(grouped_returns)?;
    let analytics_summary = DailyAnalyticsSummary {
        observations: total_results,
        tickers: matched_tickers.len() as u64,
        days: total_days,
        mean_return_pct: current.average_return_pct,
        median_return_pct: current.median_return_pct,
        positive_return_pct: mean(positive_return_count as f64 * 100.0, total_results),
    };
    let summary = DailyStockFilterSummary {
        total_results,
        events_per_day,
        average_rth_return_pct: current.average_return_pct,
        p25_rth_return_pct: current.p25_return_pct,
        median_rth_return_pct: current.median_return_pct,
        p75_rth_return_pct: current.p75_return_pct,
        average_next_day_rth_return_pct: next_day.average_return_pct,
        p25_next_day_rth_return_pct: next_day.p25_return_pct,
        median_next_day_rth_return_pct: next_day.median_return_pct,
        p75_next_day_rth_return_pct: next_day.p75_return_pct,
        forward_rth_returns,
        forward_from_close_returns,
        cumulative_returns,
    };
    // Reuse the filtered feature frame for Data Explorer pagination instead
    // of reopening every monthly Parquet partition for each table request.
    if explorer_frame.height() <= DAILY_EXPLORER_CACHE_MAX_ROWS {
        store_daily_explorer(DailyExplorerCache {
            key: cache_key,
            frame: explorer_frame,
            summary: summary.clone(),
            analytics_summary,
            daily_returns,
            feature_names: sorted_feature_names.into_iter().collect(),
            months_scanned: months.len() as u32,
        });
    } else {
        clear_daily_explorer_cache();
    }
    Ok(summary)
}

fn query_cached_daily_explorer(
    cache: &DailyExplorerCache,
    filters: &DailyAnalyticsFilter,
    page: u32,
    page_size: u32,
    requested_sort_col: &str,
    sort_desc: bool,
    started: Instant,
) -> Result<DailyAnalyticsResult, AnalyticsError> {
    let dates = string_values(&cache.frame, "session_date")?;
    let tickers = string_values(&cache.frame, "ticker")?;
    let mut feature_columns = numeric_columns(&cache.frame)?;
    feature_columns.retain(|name, _| cache.feature_names.contains(name));
    let sort_col = if requested_sort_col == "date"
        || requested_sort_col == "ticker"
        || cache.feature_names.contains(requested_sort_col)
    {
        requested_sort_col
    } else {
        "date"
    };
    let sort_column = daily_explorer_sort_column(sort_col, &cache.feature_names);
    let search = filters
        .search
        .as_deref()
        .map(str::trim)
        .filter(|search| !search.is_empty())
        .map(str::to_ascii_lowercase);
    let mut matching_indices = (0..cache.frame.height())
        .filter(|index| {
            let Some(ticker) = tickers[*index].as_deref() else {
                return false;
            };
            let Some(search) = search.as_deref() else {
                return true;
            };
            ticker.to_ascii_lowercase().contains(search)
                || dates[*index]
                    .as_deref()
                    .is_some_and(|date| date.contains(search))
        })
        .collect::<Vec<_>>();
    matching_indices.sort_by(|left, right| {
        compare_daily_explorer_values(
            sort_column,
            sort_desc,
            dates[*left].as_deref().unwrap_or_default(),
            tickers[*left].as_deref().unwrap_or_default(),
            feature_columns
                .get(sort_col)
                .and_then(|column| finite(column.get(*left))),
            dates[*right].as_deref().unwrap_or_default(),
            tickers[*right].as_deref().unwrap_or_default(),
            feature_columns
                .get(sort_col)
                .and_then(|column| finite(column.get(*right))),
        )
    });

    let total_rows = matching_indices.len() as u64;
    let offset = u64::from(page.saturating_sub(1)).saturating_mul(u64::from(page_size));
    let rows = matching_indices
        .into_iter()
        .skip(offset.min(usize::MAX as u64) as usize)
        .take(page_size as usize)
        .map(|index| {
            let features = feature_row(index, &feature_columns);
            let date = dates[index].clone().unwrap_or_default();
            let ticker = tickers[index].clone().unwrap_or_default();
            let open = feature_columns
                .get("open")
                .and_then(|column| finite(column.get(index)))
                .unwrap_or_default();
            let close = feature_columns
                .get("close")
                .and_then(|column| finite(column.get(index)))
                .unwrap_or_default();
            let return_pct = feature_columns
                .get("rth_return_pct")
                .and_then(|column| finite(column.get(index)))
                .unwrap_or_default();
            DailyAnalyticsRow {
                date,
                ticker,
                open,
                high: None,
                low: None,
                close,
                volume: None,
                return_pct,
                features,
            }
        })
        .collect();

    Ok(DailyAnalyticsResult {
        summary: cache.analytics_summary.clone(),
        daily_returns: cache.daily_returns.clone(),
        rows,
        total_rows,
        page,
        page_size,
        months_scanned: cache.months_scanned,
        elapsed_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
    })
}

pub fn query_daily_analytics(
    data_root: &Path,
    filters: DailyAnalyticsFilter,
    page: u32,
    page_size: u32,
    requested_sort_col: &str,
    sort_desc: bool,
) -> Result<DailyAnalyticsResult, AnalyticsError> {
    let started = Instant::now();
    let page_size = page_size.clamp(1, 5_000);
    let cache_key = daily_explorer_cache_key(data_root, &filters);
    if let Some(cache) = cached_daily_explorer(&cache_key) {
        return query_cached_daily_explorer(
            &cache,
            &filters,
            page,
            page_size,
            requested_sort_col,
            sort_desc,
            started,
        );
    }

    let available_months = monthly_sources(data_root, None, None)?;
    if available_months.is_empty() {
        return Err(invalid_filter(format!(
            "No matching daily and daily_features partitions were found under {}",
            data_root.display()
        )));
    }

    let sample = read_frame(&available_months[0].features_path)?;
    let breadth = read_market_breadth(data_root)?;
    let feature_names = daily_numeric_feature_names(&sample, breadth.as_ref());
    let (date_from, date_to, conditions) = filters.validate(&feature_names)?;
    let sort_col = if requested_sort_col == "date"
        || requested_sort_col == "ticker"
        || feature_names.contains(requested_sort_col)
    {
        requested_sort_col
    } else {
        "date"
    };
    let sort_column = daily_explorer_sort_column(sort_col, &feature_names);
    let months = monthly_sources(data_root, date_from.as_deref(), date_to.as_deref())?;
    let ticker_filter = filters
        .ticker
        .as_deref()
        .map(str::trim)
        .filter(|ticker| !ticker.is_empty())
        .map(str::to_ascii_uppercase);
    let text_search = filters
        .search
        .as_deref()
        .map(str::trim)
        .filter(|search| !search.is_empty())
        .map(str::to_ascii_lowercase);
    if months.is_empty() {
        return Ok(DailyAnalyticsResult {
            summary: DailyAnalyticsSummary {
                observations: 0,
                tickers: 0,
                days: 0,
                mean_return_pct: None,
                median_return_pct: None,
                positive_return_pct: None,
            },
            daily_returns: Vec::new(),
            rows: Vec::new(),
            total_rows: 0,
            page,
            page_size,
            months_scanned: 0,
            elapsed_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
        });
    }
    let offset = u64::from(page.saturating_sub(1)).saturating_mul(u64::from(page_size));
    let page_end = offset.saturating_add(u64::from(page_size));
    let result_limit = usize::try_from(page_end).unwrap_or(usize::MAX);

    let mut returns = Vec::<f64>::new();
    let mut return_sum = 0.0;
    let mut positive_returns = 0_u64;
    let mut tickers = HashSet::<String>::new();
    let mut by_day = BTreeMap::<String, DailyAccumulation>::new();
    let mut ranked_rows = BinaryHeap::<DailyExplorerHeapRow>::new();
    let mut sequence = 0_u64;
    let mut total_rows = 0_u64;

    for source in &months {
        let feature_frame = read_frame(&source.features_path)?;
        let daily_frame = read_frame(&source.daily_path)?;
        let date_field = daily_date_field(&feature_frame)?;
        let feature_frame = if breadth.is_some() {
            with_market_breadth(feature_frame.lazy(), date_field, breadth.as_ref()).collect()?
        } else {
            feature_frame
        };
        let ticker_field = daily_ticker_field(&feature_frame)?;
        let dates = string_values(&feature_frame, date_field)?;
        let symbols = string_values(&feature_frame, ticker_field)?;
        let numeric_columns = numeric_columns(&feature_frame)?;
        let bars = bar_map(&daily_frame)?;
        let mut candidates = Vec::<usize>::new();

        for index in 0..feature_frame.height() {
            let Some(date) = dates[index].as_deref() else {
                continue;
            };
            if date_from.as_deref().is_some_and(|from| date < from)
                || date_to.as_deref().is_some_and(|to| date > to)
            {
                continue;
            }
            let Some(ticker) = symbols[index].as_deref() else {
                continue;
            };
            if ticker_filter
                .as_deref()
                .is_some_and(|filter| !ticker.to_ascii_uppercase().contains(filter))
            {
                continue;
            }
            if !conditions_match(index, &conditions, &numeric_columns) {
                continue;
            }
            if filters.max_events_per_day.is_some()
                && numeric_columns
                    .get("market_cap_estimated")
                    .and_then(|column| finite(column.get(index)))
                    .is_none()
            {
                continue;
            }
            candidates.push(index);
        }

        if let Some(limit) = filters.max_events_per_day {
            let market_caps = numeric_columns
                .get("market_cap_estimated")
                .ok_or_else(|| invalid_filter("daily_features is missing market_cap_estimated"))?;
            candidates.sort_by(|left, right| {
                dates[*left]
                    .cmp(&dates[*right])
                    .then_with(|| {
                        let left_cap = finite(market_caps.get(*left)).unwrap_or(f64::NEG_INFINITY);
                        let right_cap =
                            finite(market_caps.get(*right)).unwrap_or(f64::NEG_INFINITY);
                        right_cap.total_cmp(&left_cap)
                    })
                    .then_with(|| symbols[*left].cmp(&symbols[*right]))
            });
            let mut selected_per_day = HashMap::<&str, u32>::new();
            candidates.retain(|index| {
                let date = dates[*index].as_deref().unwrap_or_default();
                let selected = selected_per_day.entry(date).or_default();
                if *selected < limit {
                    *selected += 1;
                    true
                } else {
                    false
                }
            });
        }

        if let Some(search) = text_search.as_deref() {
            candidates.retain(|index| {
                let ticker_matches = symbols[*index]
                    .as_deref()
                    .is_some_and(|ticker| ticker.to_ascii_lowercase().contains(search));
                let date_matches = dates[*index]
                    .as_deref()
                    .is_some_and(|date| date.contains(search));
                ticker_matches || date_matches
            });
        }

        let mut matched = Vec::<(usize, f64)>::with_capacity(candidates.len());
        for feature_index in candidates {
            let date = dates[feature_index].as_deref().unwrap_or_default();
            let ticker = symbols[feature_index].as_deref().unwrap_or_default();
            let Some(bar) = bars
                .get(date)
                .and_then(|by_ticker| by_ticker.get(ticker))
                .copied()
            else {
                continue;
            };
            let return_pct = 100.0 * (bar.close / bar.open - 1.0);
            if !return_pct.is_finite() {
                continue;
            }
            matched.push((feature_index, return_pct));
        }

        for (feature_index, return_pct) in &matched {
            return_sum += return_pct;
            returns.push(*return_pct);
            positive_returns += u64::from(*return_pct > 0.0);
            let ticker = symbols[*feature_index].as_deref().unwrap_or_default();
            let date = dates[*feature_index].as_deref().unwrap_or_default();
            tickers.insert(ticker.to_owned());
            let daily = by_day.entry(date.to_owned()).or_default();
            daily.count += 1;
            daily.return_sum += return_pct;
        }

        total_rows = total_rows.saturating_add(matched.len() as u64);
        for (feature_index, return_pct) in matched {
            let date = dates[feature_index].as_deref().unwrap_or_default();
            let ticker = symbols[feature_index].as_deref().unwrap_or_default();
            let sort_value = numeric_columns
                .get(sort_col)
                .and_then(|column| finite(column.get(feature_index)));
            let candidate_sequence = sequence;
            sequence = sequence.saturating_add(1);

            let candidate_is_better = ranked_rows.peek().is_none_or(|worst| {
                let ordering = compare_daily_explorer_values(
                    sort_column,
                    sort_desc,
                    date,
                    ticker,
                    sort_value,
                    &worst.key.date,
                    &worst.key.ticker,
                    worst.key.sort_value,
                );
                ordering == Ordering::Less
                    || (ordering == Ordering::Equal && candidate_sequence < worst.key.sequence)
            });
            if result_limit == 0 || (ranked_rows.len() >= result_limit && !candidate_is_better) {
                continue;
            }

            let key = DailyExplorerHeapKey {
                sort_column,
                descending: sort_desc,
                date: date.to_owned(),
                ticker: ticker.to_owned(),
                sort_value,
                sequence: candidate_sequence,
            };

            let bar = bars
                .get(date)
                .and_then(|by_ticker| by_ticker.get(ticker))
                .copied()
                .expect("matched daily bar remains in month index");
            let row = DailyAnalyticsRow {
                date: date.to_owned(),
                ticker: ticker.to_owned(),
                open: bar.open,
                high: bar.high,
                low: bar.low,
                close: bar.close,
                volume: bar.volume,
                return_pct,
                features: feature_row(feature_index, &numeric_columns),
            };

            if ranked_rows.len() >= result_limit {
                ranked_rows.pop();
            }
            ranked_rows.push(DailyExplorerHeapRow { key, row });
        }
    }

    let mut ranked_rows = ranked_rows.into_vec();
    ranked_rows.sort_by(|left, right| left.key.cmp(&right.key));
    let start_index = offset.min(usize::MAX as u64) as usize;
    let rows = ranked_rows
        .into_iter()
        .skip(start_index)
        .take(page_size as usize)
        .map(|ranked| ranked.row)
        .collect();

    let median = median_in_place(&mut returns);
    let summary = DailyAnalyticsSummary {
        observations: total_rows,
        tickers: tickers.len() as u64,
        days: by_day.len() as u64,
        mean_return_pct: mean(return_sum, total_rows),
        median_return_pct: median,
        positive_return_pct: mean(positive_returns as f64 * 100.0, total_rows),
    };
    let daily_returns = by_day
        .into_iter()
        .map(|(date, value)| DailyReturnPoint {
            date,
            observations: value.count,
            mean_return_pct: value.return_sum / value.count as f64,
        })
        .collect();

    Ok(DailyAnalyticsResult {
        summary,
        daily_returns,
        rows,
        total_rows,
        page,
        page_size,
        months_scanned: months.len() as u32,
        elapsed_ms: started.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
    })
}

fn monthly_sources(
    data_root: &Path,
    date_from: Option<&str>,
    date_to: Option<&str>,
) -> Result<Vec<MonthlySource>, AnalyticsError> {
    let daily_root = data_root.join("daily");
    let features_root = data_root.join("research").join("daily_features");
    let mut sources = Vec::new();
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
        for month in 1..=12 {
            let first_date = format!("{year}-{month:02}-01");
            let next_date = if month == 12 {
                format!("{}-01-01", year + 1)
            } else {
                format!("{year}-{:02}-01", month + 1)
            };
            if date_to.is_some_and(|end| first_date.as_str() > end)
                || date_from.is_some_and(|start| next_date.as_str() <= start)
            {
                continue;
            }
            let daily_path = year_entry.path().join(format!("month={month:02}.parquet"));
            let features_path = features_root
                .join(format!("year={year}"))
                .join(format!("month={month:02}.parquet"));
            match (daily_path.is_file(), features_path.is_file()) {
                (true, true) => sources.push(MonthlySource {
                    year,
                    month,
                    daily_path,
                    features_path,
                }),
                (false, false) => {}
                _ => {
                    return Err(invalid_filter(format!(
                        "daily bars and daily_features must both exist for {year}-{month:02}"
                    )));
                }
            }
        }
    }
    sources.sort_by(|left, right| {
        right
            .year
            .cmp(&left.year)
            .then_with(|| right.month.cmp(&left.month))
    });
    Ok(sources)
}

fn daily_feature_sources(
    data_root: &Path,
    date_from: Option<&str>,
    date_to: Option<&str>,
) -> Result<Vec<DailyFeatureSource>, AnalyticsError> {
    let features_root = data_root.join("research").join("daily_features");
    let mut sources = Vec::new();
    for year_entry in fs::read_dir(&features_root)? {
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
        for month in 1..=12 {
            let first_date = format!("{year}-{month:02}-01");
            let next_date = if month == 12 {
                format!("{}-01-01", year + 1)
            } else {
                format!("{year}-{:02}-01", month + 1)
            };
            if date_to.is_some_and(|end| first_date.as_str() > end)
                || date_from.is_some_and(|start| next_date.as_str() <= start)
            {
                continue;
            }
            let features_path = year_entry.path().join(format!("month={month:02}.parquet"));
            if features_path.is_file() {
                sources.push(DailyFeatureSource {
                    year,
                    month,
                    features_path,
                });
            }
        }
    }
    sources.sort_by(|left, right| {
        right
            .year
            .cmp(&left.year)
            .then_with(|| right.month.cmp(&left.month))
    });
    Ok(sources)
}

fn read_frame(path: &Path) -> Result<DataFrame, AnalyticsError> {
    ParquetReader::new(File::open(path)?)
        .finish()
        .map_err(AnalyticsError::from)
}

fn daily_date_field(frame: &DataFrame) -> Result<&'static str, AnalyticsError> {
    if frame.get_column_names().iter().any(|name| name.as_str() == "date") {
        Ok("date")
    } else if frame.get_column_names().iter().any(|name| name.as_str() == "timestamp") {
        Ok("timestamp")
    } else {
        Err(invalid_filter("daily_features must contain date or timestamp"))
    }
}

fn daily_ticker_field(frame: &DataFrame) -> Result<&'static str, AnalyticsError> {
    if frame.get_column_names().iter().any(|name| name.as_str() == "ticker") {
        Ok("ticker")
    } else if frame.get_column_names().iter().any(|name| name.as_str() == "symbol") {
        Ok("symbol")
    } else {
        Err(invalid_filter("daily_features must contain ticker or symbol"))
    }
}

fn string_values(frame: &DataFrame, name: &str) -> Result<Vec<Option<String>>, AnalyticsError> {
    let source = frame.column(name)?;
    let casted = if matches!(source.dtype(), DataType::Datetime(_, _)) {
        source.cast(&DataType::Date)?.cast(&DataType::String)?
    } else {
        source.cast(&DataType::String)?
    };
    let values = casted.str()?;
    Ok((0..frame.height())
        .map(|index| values.get(index).map(date_or_text))
        .collect())
}

fn date_or_text(value: &str) -> String {
    if value.len() >= 10 && value.as_bytes().get(4) == Some(&b'-') {
        value[..10].to_owned()
    } else {
        value.to_owned()
    }
}

fn numeric_columns(frame: &DataFrame) -> Result<HashMap<String, Float64Chunked>, AnalyticsError> {
    let mut result = HashMap::new();
    for column in frame.get_columns() {
        let name = column.name().as_str();
        if !is_filterable_numeric(name, column.dtype()) {
            continue;
        }
        let casted = column.cast(&DataType::Float64)?;
        result.insert(name.to_owned(), casted.f64()?.clone());
    }
    Ok(result)
}

fn bar_map(
    frame: &DataFrame,
) -> Result<HashMap<String, HashMap<String, DailyBar>>, AnalyticsError> {
    let dates = string_values(frame, daily_date_field(frame)?)?;
    let tickers = string_values(frame, daily_ticker_field(frame)?)?;
    let open = float_column(frame, "open")?;
    let high = float_column(frame, "high")?;
    let low = float_column(frame, "low")?;
    let close = float_column(frame, "close")?;
    let volume = float_column(frame, "volume")?;
    let mut result = HashMap::<String, HashMap<String, DailyBar>>::new();
    for index in 0..frame.height() {
        let (Some(date), Some(ticker), Some(open), Some(close)) = (
            dates[index].as_deref(),
            tickers[index].as_deref(),
            finite(open.get(index)),
            finite(close.get(index)),
        ) else {
            continue;
        };
        if open <= 0.0 {
            continue;
        }
        result.entry(date.to_owned()).or_default().insert(
            ticker.to_owned(),
            DailyBar {
                open,
                high: finite(high.get(index)),
                low: finite(low.get(index)),
                close,
                volume: finite(volume.get(index)),
            },
        );
    }
    Ok(result)
}

fn float_column(frame: &DataFrame, name: &str) -> Result<Float64Chunked, AnalyticsError> {
    let casted = frame.column(name)?.cast(&DataType::Float64)?;
    Ok(casted.f64()?.clone())
}

fn conditions_match(
    index: usize,
    conditions: &[CompiledCondition],
    columns: &HashMap<String, Float64Chunked>,
) -> bool {
    conditions.iter().all(|condition| {
        let actual = columns
            .get(&condition.field)
            .and_then(|column| finite(column.get(index)));
        match condition.operator {
            FilterOperator::IsNull => actual.is_none(),
            FilterOperator::IsNotNull => actual.is_some(),
            _ => {
                let Some(actual) = actual else { return false };
                let target = if let Some(other_field) = &condition.compare_to {
                    let Some(value) = columns
                        .get(other_field)
                        .and_then(|column| finite(column.get(index)))
                    else {
                        return false;
                    };
                    value
                } else {
                    condition.value.unwrap_or_default()
                };
                match condition.operator {
                    FilterOperator::Eq => actual == target,
                    FilterOperator::Ne => actual != target,
                    FilterOperator::Gt => actual > target,
                    FilterOperator::Gte => actual >= target,
                    FilterOperator::Lt => actual < target,
                    FilterOperator::Lte => actual <= target,
                    FilterOperator::Between => {
                        actual >= target && actual <= condition.upper_value.unwrap_or(target)
                    }
                    FilterOperator::IsNull | FilterOperator::IsNotNull => unreachable!(),
                }
            }
        }
    })
}

fn conditions_predicate(conditions: &[CompiledCondition]) -> Expr {
    conditions
        .iter()
        .map(|condition| {
            let column = col(condition.field.as_str());
            match condition.operator {
                FilterOperator::IsNull => column
                    .clone()
                    .is_null()
                    .or(column.cast(DataType::Float64).is_finite().not()),
                FilterOperator::IsNotNull => column.cast(DataType::Float64).is_finite(),
                operator => {
                    let left = column.cast(DataType::Float64);
                    let finite_left = left.clone().is_finite();
                    let right = if let Some(other_field) = &condition.compare_to {
                        col(other_field.as_str()).cast(DataType::Float64)
                    } else {
                        lit(condition.value.unwrap_or_default())
                    };
                    let comparison = match operator {
                        FilterOperator::Eq => left.eq(right),
                        FilterOperator::Ne => left.neq(right),
                        FilterOperator::Gt => left.gt(right),
                        FilterOperator::Gte => left.gt_eq(right),
                        FilterOperator::Lt => left.lt(right),
                        FilterOperator::Lte => left.lt_eq(right),
                        FilterOperator::Between => left
                            .clone()
                            .gt_eq(right.clone())
                            .and(left.lt_eq(lit(condition.upper_value.unwrap_or_default()))),
                        FilterOperator::IsNull | FilterOperator::IsNotNull => unreachable!(),
                    };
                    if let Some(other_field) = &condition.compare_to {
                        finite_left.and(
                            col(other_field.as_str())
                                .cast(DataType::Float64)
                                .is_finite()
                                .and(comparison),
                        )
                    } else {
                        finite_left.and(comparison)
                    }
                }
            }
        })
        .reduce(|left, right| left.and(right))
        .unwrap_or_else(|| lit(true))
}

fn feature_row(
    index: usize,
    columns: &HashMap<String, Float64Chunked>,
) -> BTreeMap<String, Option<f64>> {
    columns
        .iter()
        .map(|(name, column)| (name.clone(), finite(column.get(index))))
        .collect()
}

fn apply_market_cap_daily_limit(frame: LazyFrame, max_events_per_day: Option<u32>) -> LazyFrame {
    let Some(limit) = max_events_per_day else {
        return frame;
    };
    let market_cap = col("market_cap_estimated").cast(DataType::Float64);
    frame
        .filter(market_cap.clone().is_finite())
        .with_columns([market_cap
            .rank(
                RankOptions {
                    method: RankMethod::Ordinal,
                    descending: true,
                },
                None,
            )
            .over([col("date")])
            .alias("__market_cap_daily_rank")])
        .filter(col("__market_cap_daily_rank").lt_eq(lit(limit)))
}

fn parse_operator(value: &str) -> Result<FilterOperator, AnalyticsError> {
    match value.trim().to_ascii_lowercase().as_str() {
        "eq" => Ok(FilterOperator::Eq),
        "ne" => Ok(FilterOperator::Ne),
        "gt" => Ok(FilterOperator::Gt),
        "gte" => Ok(FilterOperator::Gte),
        "lt" => Ok(FilterOperator::Lt),
        "lte" => Ok(FilterOperator::Lte),
        "between" => Ok(FilterOperator::Between),
        "is_null" => Ok(FilterOperator::IsNull),
        "is_not_null" => Ok(FilterOperator::IsNotNull),
        other => Err(invalid_filter(format!(
            "unsupported feature filter operator '{other}'"
        ))),
    }
}

fn parse_optional_date(value: Option<&str>) -> Result<Option<String>, AnalyticsError> {
    value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| {
            NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .map(|date| date.format("%Y-%m-%d").to_string())
                .map_err(|_| AnalyticsError::InvalidDate {
                    value: value.to_owned(),
                })
        })
        .transpose()
}

fn date_needs_upper_filter(value: &str) -> bool {
    let Ok(date) = NaiveDate::parse_from_str(value, "%Y-%m-%d") else {
        return true;
    };
    let Some(next_day) = date.succ_opt() else {
        return true;
    };
    date.format("%Y-%m").to_string() == next_day.format("%Y-%m").to_string()
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

fn is_filterable_numeric(name: &str, dtype: &DataType) -> bool {
    is_numeric(dtype)
        && !matches!(name, "date" | "ticker" | "next_day_rth_return_pct")
        && !name.starts_with("forward_rth_return_")
}

fn finite(value: Option<f64>) -> Option<f64> {
    value.filter(|value| value.is_finite())
}

fn mean(sum: f64, count: u64) -> Option<f64> {
    (count > 0).then_some(sum / count as f64)
}

fn cumulative_return_points(
    daily_returns: impl IntoIterator<Item = (i32, (u64, f64))>,
) -> Result<Vec<DailyCumulativeReturnPoint>, AnalyticsError> {
    let mut cumulative_return_pct = 0.0;
    daily_returns
        .into_iter()
        .map(|(date_days, (observations, daily_return_sum_pct))| {
            cumulative_return_pct += daily_return_sum_pct;
            let date = NaiveDate::from_num_days_from_ce_opt(date_days + 719_163)
                .ok_or_else(|| invalid_filter(format!("Invalid date value {date_days}")))?;
            Ok(DailyCumulativeReturnPoint {
                date: date.format("%Y-%m-%d").to_string(),
                observations,
                daily_return_sum_pct,
                cumulative_return_pct,
            })
        })
        .collect()
}

fn summarize_forward_returns(
    market_sessions_after: u8,
    mut values: Vec<f64>,
) -> DailyForwardReturnSummary {
    let observations = values.len() as u64;
    let (sum, positive_count) = values.iter().fold((0.0, 0_u64), |(sum, count), &value| {
        (sum + value, count + u64::from(value > 0.0))
    });
    let average_return_pct = mean(sum, observations);
    let positive_return_pct = mean(positive_count as f64 * 100.0, observations);
    let p25_return_pct = percentile_in_place(&mut values, 0.25);
    let median_return_pct = median_in_place(&mut values);
    let p75_return_pct = percentile_in_place(&mut values, 0.75);
    DailyForwardReturnSummary {
        market_sessions_after,
        observations,
        positive_return_pct,
        average_return_pct,
        p25_return_pct,
        median_return_pct,
        p75_return_pct,
        cumulative_returns: Vec::new(),
    }
}

fn median_in_place(values: &mut [f64]) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let middle = values.len() / 2;
    let median_value = {
        let (_, median, _) = values.select_nth_unstable_by(middle, f64::total_cmp);
        *median
    };
    if values.len() % 2 == 1 {
        Some(median_value)
    } else {
        let lower = values[..middle].iter().copied().max_by(f64::total_cmp)?;
        Some((lower + median_value) / 2.0)
    }
}

fn percentile_in_place(values: &mut [f64], probability: f64) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    let position = (values.len() - 1) as f64 * probability;
    let lower_index = position.floor() as usize;
    let upper_index = position.ceil() as usize;
    let lower = {
        let (_, value, _) = values.select_nth_unstable_by(lower_index, f64::total_cmp);
        *value
    };
    if lower_index == upper_index {
        return Some(lower);
    }
    let upper = {
        let (_, value, _) = values[lower_index + 1..]
            .select_nth_unstable_by(upper_index - lower_index - 1, f64::total_cmp);
        *value
    };
    Some(lower + (upper - lower) * (position - lower_index as f64))
}

fn invalid_filter(message: impl Into<String>) -> AnalyticsError {
    AnalyticsError::InvalidFilter {
        message: message.into(),
    }
}
