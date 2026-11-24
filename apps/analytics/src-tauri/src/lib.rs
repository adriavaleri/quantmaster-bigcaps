use analytics_commands as analytics_api;
use analytics_engine::{
    DailyAnalyticsFilter, DailyAnalyticsResult, DailyFeatureInfo, DailyStockFilterSummary,
    SessionCandle,
};
mod data_update;

#[tauri::command]
fn analytics_engine_status() -> &'static str {
    analytics_api::analytics_engine_status()
}

#[tauri::command]
async fn market_breadth_history(
    data_root: String,
) -> Result<Vec<analytics_engine::MarketBreadthPoint>, analytics_api::CommandError> {
    analytics_api::market_breadth_history(data_root).await
}

#[tauri::command]
async fn daily_feature_catalog(
    data_root: String,
) -> Result<Vec<DailyFeatureInfo>, analytics_api::CommandError> {
    analytics_api::daily_feature_catalog(data_root).await
}

#[tauri::command]
async fn query_daily_analytics(
    data_root: String,
    filters: DailyAnalyticsFilter,
    page: u32,
    page_size: u32,
    sort_col: String,
    sort_desc: bool,
) -> Result<DailyAnalyticsResult, analytics_api::CommandError> {
    analytics_api::query_daily_analytics(data_root, filters, page, page_size, sort_col, sort_desc).await
}

#[tauri::command]
async fn count_daily_stocks(
    data_root: String,
    filters: DailyAnalyticsFilter,
) -> Result<u64, analytics_api::CommandError> {
    analytics_api::count_daily_stocks(data_root, filters).await
}

#[tauri::command]
async fn summarize_daily_stocks(
    data_root: String,
    filters: DailyAnalyticsFilter,
) -> Result<DailyStockFilterSummary, analytics_api::CommandError> {
    analytics_api::summarize_daily_stocks(data_root, filters).await
}

#[tauri::command]
async fn daily_ticker_candles(
    ticker: String,
    date_to: String,
    data_root: String,
) -> Result<Vec<SessionCandle>, analytics_api::CommandError> {
    analytics_api::daily_ticker_candles(ticker, date_to, data_root).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            analytics_engine_status,
            daily_feature_catalog,
            market_breadth_history,
            query_daily_analytics,
            count_daily_stocks,
            summarize_daily_stocks,
            daily_ticker_candles,
            data_update::update_dataset
        ])
        .run(tauri::generate_context!())
        .expect("error while running Analytics Tauri application");
}
