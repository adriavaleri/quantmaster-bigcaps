mod candles;
mod daily;
mod error;
mod selector;
mod splits;
mod store;

pub use candles::{load_daily_ticker_candles, load_m1, SessionCandle};
pub use daily::{
    count_daily_stocks, daily_feature_catalog, market_breadth_history, query_daily_analytics,
    summarize_daily_stocks,
    DailyAnalyticsFilter, DailyAnalyticsResult, DailyAnalyticsRow, DailyAnalyticsSummary,
    DailyCumulativeReturnPoint, DailyFeatureCondition, DailyFeatureInfo, DailyReturnPoint,
    DailyStockFilterSummary, MarketBreadthPoint,
};
pub use error::AnalyticsError;
pub use selector::{
    CompiledFilterPlan, FilterValue, SessionAnalyticsSummary, SessionCondition, SessionCountResult,
    SessionFilterConfig, SessionHeatmapCell, SessionHeatmapResult, SessionIntradayReturnPoint,
    SessionIntradayReturnResult, SessionKey, SessionOverviewResult, SessionReturnTrendPoint,
    SessionReturnTrendResult, SessionRowsResult, SessionSelectionResult, SessionSelector,
    SessionTickerReturnBucket, SessionTickerReturnResult, SessionTimingSummary,
};
pub use splits::SplitIndex;
pub use store::{
    SessionFilterStoreBuilder, StoreBuildReport, PROFILE_KEYS_EXTENSION, PROFILE_STORE_DIR_NAME,
    PROFILE_VALUES_EXTENSION, STORE_DIR_NAME,
};

pub fn status() -> &'static str {
    "ready"
}
