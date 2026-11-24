use std::{
    collections::HashSet,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
};

use analytics_engine::{
    count_daily_stocks as run_daily_stock_count,
    daily_feature_catalog as load_daily_feature_catalog,
    load_daily_ticker_candles as load_daily_candles, load_m1,
    query_daily_analytics as run_daily_analytics,
    summarize_daily_stocks as run_daily_stock_summary, AnalyticsError, DailyAnalyticsFilter,
    DailyAnalyticsResult, DailyFeatureInfo, DailyStockFilterSummary, SessionAnalyticsSummary,
    SessionCandle, SessionCountResult, SessionFilterConfig, SessionFilterStoreBuilder,
    SessionHeatmapResult, SessionIntradayReturnResult, SessionOverviewResult,
    SessionReturnTrendResult, SessionRowsResult, SessionSelectionResult, SessionSelector,
    SessionTickerReturnResult, SessionTimingSummary, StoreBuildReport,
};
use serde::Serialize;

static VALIDATED_STORES: OnceLock<Mutex<HashSet<(PathBuf, bool)>>> = OnceLock::new();

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CommandError {
    code: &'static str,
    message: String,
}

impl From<AnalyticsError> for CommandError {
    fn from(error: AnalyticsError) -> Self {
        Self {
            code: error.code(),
            message: error.to_string(),
        }
    }
}

pub fn analytics_engine_status() -> &'static str {
    analytics_engine::status()
}

pub async fn market_breadth_history(
    data_root: String,
) -> Result<Vec<analytics_engine::MarketBreadthPoint>, CommandError> {
    let data_root = resolve_data_root(&data_root);
    tauri::async_runtime::spawn_blocking(move || analytics_engine::market_breadth_history(&data_root))
        .await
        .map_err(|error| CommandError {
            code: "MARKET_BREADTH_HISTORY_ERROR",
            message: format!("market breadth history task failed: {error}"),
        })?
        .map_err(CommandError::from)
}

pub async fn daily_feature_catalog(
    data_root: String,
) -> Result<Vec<DailyFeatureInfo>, CommandError> {
    let data_root = resolve_data_root(&data_root);
    tauri::async_runtime::spawn_blocking(move || load_daily_feature_catalog(&data_root))
        .await
        .map_err(|error| CommandError {
            code: "DAILY_FEATURE_CATALOG_ERROR",
            message: format!("daily feature catalog task failed: {error}"),
        })?
        .map_err(CommandError::from)
}

pub async fn query_daily_analytics(
    data_root: String,
    filters: DailyAnalyticsFilter,
    page: u32,
    page_size: u32,
    sort_col: String,
    sort_desc: bool,
) -> Result<DailyAnalyticsResult, CommandError> {
    let data_root = resolve_data_root(&data_root);
    tauri::async_runtime::spawn_blocking(move || {
        run_daily_analytics(&data_root, filters, page, page_size, &sort_col, sort_desc)
    })
    .await
    .map_err(|error| CommandError {
        code: "DAILY_ANALYTICS_QUERY_ERROR",
        message: format!("daily analytics query task failed: {error}"),
    })?
    .map_err(CommandError::from)
}

pub async fn count_daily_stocks(
    data_root: String,
    filters: DailyAnalyticsFilter,
) -> Result<u64, CommandError> {
    let data_root = resolve_data_root(&data_root);
    tauri::async_runtime::spawn_blocking(move || run_daily_stock_count(&data_root, filters))
        .await
        .map_err(|error| CommandError {
            code: "DAILY_STOCK_COUNT_ERROR",
            message: format!("daily stock count task failed: {error}"),
        })?
        .map_err(CommandError::from)
}

pub async fn summarize_daily_stocks(
    data_root: String,
    filters: DailyAnalyticsFilter,
) -> Result<DailyStockFilterSummary, CommandError> {
    let data_root = resolve_data_root(&data_root);
    tauri::async_runtime::spawn_blocking(move || run_daily_stock_summary(&data_root, filters))
        .await
        .map_err(|error| CommandError {
            code: "DAILY_STOCK_SUMMARY_ERROR",
            message: format!("daily stock summary task failed: {error}"),
        })?
        .map_err(CommandError::from)
}

pub async fn daily_ticker_candles(
    ticker: String,
    date_to: String,
    data_root: String,
) -> Result<Vec<SessionCandle>, CommandError> {
    let data_root = resolve_data_root(&data_root);
    tauri::async_runtime::spawn_blocking(move || load_daily_candles(&data_root, &ticker, &date_to))
        .await
        .map_err(|error| CommandError {
            code: "DAILY_CANDLES_ERROR",
            message: format!("daily candle task failed: {error}"),
        })?
        .map_err(CommandError::from)
}

pub async fn build_session_filter_store(
    data_root: String,
    output_dir: Option<String>,
) -> Result<StoreBuildReport, CommandError> {
    let data_root = resolve_data_root(&data_root);
    invalidate_store_cache(&data_root);
    let output_dir = output_dir.map(PathBuf::from);
    tauri::async_runtime::spawn_blocking(move || {
        SessionFilterStoreBuilder::build(&data_root, output_dir.as_deref())
    })
    .await
    .map_err(|error| CommandError {
        code: "STORE_BUILD_ERROR",
        message: format!("session filter store task failed: {error}"),
    })?
    .map_err(CommandError::from)
}

pub async fn preview_sessions(
    data_root: String,
    config: SessionFilterConfig,
) -> Result<SessionSelectionResult, CommandError> {
    let data_root = resolve_data_root(&data_root);
    tauri::async_runtime::spawn_blocking(move || {
        ensure_session_filter_store(&data_root, &config)?;
        SessionSelector::preview(&data_root, &config)
    })
    .await
    .map_err(|error| CommandError {
        code: "SESSION_PREVIEW_ERROR",
        message: format!("session preview task failed: {error}"),
    })?
    .map_err(CommandError::from)
}

pub async fn count_sessions(
    data_root: String,
    config: SessionFilterConfig,
) -> Result<SessionCountResult, CommandError> {
    let data_root = resolve_data_root(&data_root);
    tauri::async_runtime::spawn_blocking(move || {
        ensure_session_filter_store(&data_root, &config)?;
        SessionSelector::count_matches(&data_root, &config)
    })
    .await
    .map_err(|error| CommandError {
        code: "SESSION_COUNT_ERROR",
        message: format!("session count task failed: {error}"),
    })?
    .map_err(CommandError::from)
}

pub async fn session_summary(
    data_root: String,
    config: SessionFilterConfig,
) -> Result<SessionAnalyticsSummary, CommandError> {
    let data_root = resolve_data_root(&data_root);
    tauri::async_runtime::spawn_blocking(move || {
        ensure_session_filter_store(&data_root, &config)?;
        SessionSelector::summary(&data_root, &config)
    })
    .await
    .map_err(|error| CommandError {
        code: "SESSION_SUMMARY_ERROR",
        message: format!("session summary task failed: {error}"),
    })?
    .map_err(CommandError::from)
}

pub async fn session_overview(
    data_root: String,
    config: SessionFilterConfig,
) -> Result<SessionOverviewResult, CommandError> {
    let data_root = resolve_data_root(&data_root);
    tauri::async_runtime::spawn_blocking(move || {
        ensure_session_filter_store(&data_root, &config)?;
        SessionSelector::overview(&data_root, &config)
    })
    .await
    .map_err(|error| CommandError {
        code: "SESSION_OVERVIEW_ERROR",
        message: format!("session overview task failed: {error}"),
    })?
    .map_err(CommandError::from)
}

pub async fn session_return_trend(
    data_root: String,
    config: SessionFilterConfig,
    return_field: String,
    granularity: String,
) -> Result<SessionReturnTrendResult, CommandError> {
    let data_root = resolve_data_root(&data_root);
    tauri::async_runtime::spawn_blocking(move || {
        ensure_session_filter_store(&data_root, &config)?;
        SessionSelector::return_trend(&data_root, &config, &return_field, &granularity)
    })
    .await
    .map_err(|error| CommandError {
        code: "SESSION_RETURN_TREND_ERROR",
        message: format!("return trend task failed: {error}"),
    })?
    .map_err(CommandError::from)
}

pub async fn session_intraday_return_profile(
    data_root: String,
    config: SessionFilterConfig,
) -> Result<SessionIntradayReturnResult, CommandError> {
    let data_root = resolve_data_root(&data_root);
    tauri::async_runtime::spawn_blocking(move || {
        ensure_session_filter_store(&data_root, &config)?;
        SessionSelector::intraday_return_profile(&data_root, &config)
    })
    .await
    .map_err(|error| CommandError {
        code: "SESSION_INTRADAY_RETURN_ERROR",
        message: format!("intraday return profile task failed: {error}"),
    })?
    .map_err(CommandError::from)
}

pub async fn session_ticker_return_distribution(
    data_root: String,
    config: SessionFilterConfig,
    return_field: String,
) -> Result<SessionTickerReturnResult, CommandError> {
    let data_root = resolve_data_root(&data_root);
    tauri::async_runtime::spawn_blocking(move || {
        ensure_session_filter_store(&data_root, &config)?;
        SessionSelector::ticker_return_distribution(&data_root, &config, &return_field)
    })
    .await
    .map_err(|error| CommandError {
        code: "SESSION_TICKER_RETURN_ERROR",
        message: format!("ticker return distribution task failed: {error}"),
    })?
    .map_err(CommandError::from)
}

pub async fn select_sessions(
    data_root: String,
    config: SessionFilterConfig,
) -> Result<SessionSelectionResult, CommandError> {
    let data_root = resolve_data_root(&data_root);
    tauri::async_runtime::spawn_blocking(move || {
        ensure_session_filter_store(&data_root, &config)?;
        SessionSelector::select_keys(&data_root, &config)
    })
    .await
    .map_err(|error| CommandError {
        code: "SESSION_SELECTION_ERROR",
        message: format!("session selection task failed: {error}"),
    })?
    .map_err(CommandError::from)
}

pub async fn session_rows(
    data_root: String,
    config: SessionFilterConfig,
    search: String,
    sort_col: String,
    sort_desc: bool,
    page: u32,
    page_size: u32,
) -> Result<SessionRowsResult, CommandError> {
    let data_root = resolve_data_root(&data_root);
    tauri::async_runtime::spawn_blocking(move || {
        ensure_session_filter_store(&data_root, &config)?;
        SessionSelector::rows(
            &data_root, &config, &search, &sort_col, sort_desc, page, page_size,
        )
    })
    .await
    .map_err(|error| CommandError {
        code: "SESSION_ROWS_ERROR",
        message: format!("session rows task failed: {error}"),
    })?
    .map_err(CommandError::from)
}

pub async fn session_timing_distributions(
    data_root: String,
    config: SessionFilterConfig,
) -> Result<SessionTimingSummary, CommandError> {
    let data_root = resolve_data_root(&data_root);
    tauri::async_runtime::spawn_blocking(move || {
        ensure_session_filter_store(&data_root, &config)?;
        SessionSelector::timing_distributions(&data_root, &config)
    })
    .await
    .map_err(|error| CommandError {
        code: "TIMING_DISTRIBUTIONS_ERROR",
        message: format!("timing distributions task failed: {error}"),
    })?
    .map_err(CommandError::from)
}

pub async fn session_heatmap(
    data_root: String,
    config: SessionFilterConfig,
    bucket_field: String,
    direction: String,
) -> Result<SessionHeatmapResult, CommandError> {
    let data_root = resolve_data_root(&data_root);
    tauri::async_runtime::spawn_blocking(move || {
        ensure_session_filter_store(&data_root, &config)?;
        SessionSelector::heatmap(&data_root, &config, &bucket_field, &direction)
    })
    .await
    .map_err(|error| CommandError {
        code: "SESSION_HEATMAP_ERROR",
        message: format!("session heatmap task failed: {error}"),
    })?
    .map_err(CommandError::from)
}

pub async fn session_candles(
    ticker: String,
    date: String,
    data_dir: String,
    _timeframe: String,
) -> Result<Vec<SessionCandle>, CommandError> {
    load_candles(ticker, date, data_dir).await
}

pub async fn session_subminute_candles(
    ticker: String,
    date: String,
    data_dir: String,
    _timeframe: String,
) -> Result<Vec<SessionCandle>, CommandError> {
    load_candles(ticker, date, data_dir).await
}

async fn load_candles(
    ticker: String,
    date: String,
    data_dir: String,
) -> Result<Vec<SessionCandle>, CommandError> {
    let data_root = resolve_data_root(&data_dir);
    tauri::async_runtime::spawn_blocking(move || load_m1(&data_root, &ticker, &date))
        .await
        .map_err(|error| CommandError {
            code: "M1_LOAD_ERROR",
            message: format!("M1 loader task failed: {error}"),
        })?
        .map_err(CommandError::from)
}

fn resolve_data_root(input: &str) -> PathBuf {
    let path = PathBuf::from(input.trim());
    if path.is_absolute() {
        return path;
    }
    if path.exists() {
        return path;
    }
    if let Ok(current) = std::env::current_dir() {
        for ancestor in current.ancestors() {
            let candidate = ancestor.join(&path);
            if candidate.exists() {
                return candidate;
            }
        }
    }
    path
}

fn ensure_session_filter_store(
    data_root: &Path,
    config: &SessionFilterConfig,
) -> Result<(), AnalyticsError> {
    let requires_overnight_store = config
        .analysis_mode
        .as_deref()
        .is_some_and(|mode| mode.eq_ignore_ascii_case("overnight"));
    let cache = VALIDATED_STORES.get_or_init(|| Mutex::new(HashSet::new()));
    let mut validated = cache.lock().map_err(|_| AnalyticsError::InvalidFilter {
        message: "session filter store validation cache is unavailable".to_owned(),
    })?;
    let key = (data_root.to_owned(), requires_overnight_store);
    if validated.contains(&key) {
        return Ok(());
    }
    if requires_overnight_store {
        SessionFilterStoreBuilder::ensure(data_root)?;
    } else if SessionFilterStoreBuilder::current_report_compatible(
        data_root,
        &data_root
            .join("runtime")
            .join(analytics_engine::STORE_DIR_NAME),
    )?
    .is_none()
    {
        SessionFilterStoreBuilder::ensure(data_root)?;
    }
    validated.insert(key);
    Ok(())
}

fn invalidate_store_cache(data_root: &Path) {
    if let Some(cache) = VALIDATED_STORES.get() {
        if let Ok(mut validated) = cache.lock() {
            validated.retain(|(path, _)| path != data_root);
        }
    }
}
