use std::io;

use thiserror::Error;

#[derive(Debug, Error)]
pub enum AnalyticsError {
    #[error("I/O error while accessing analytics data: {0}")]
    Io(#[from] io::Error),

    #[error("JSON metadata operation failed: {0}")]
    Json(#[from] serde_json::Error),

    #[error("columnar operation failed: {0}")]
    Polars(String),

    #[error("invalid date '{value}'; expected YYYY-MM-DD")]
    InvalidDate { value: String },

    #[error("invalid filter configuration: {message}")]
    InvalidFilter { message: String },

    #[error("missing required column '{column}' in {dataset}")]
    MissingColumn { dataset: String, column: String },

    #[error("missing liquidity_daily file for session file '{session_file}'")]
    MissingLiquidityFile { session_file: String },

    #[error("ticker '{ticker}' from session_index is missing from liquidity_daily for {date}")]
    MissingLiquidityRank { date: String, ticker: String },

    #[error("liquidity rank {rank} for '{ticker}' on {date} does not fit uint16")]
    LiquidityRankOutOfRange {
        date: String,
        ticker: String,
        rank: i64,
    },

    #[error("runtime session filter store is missing: {path}")]
    StoreMissing { path: String },
}

impl From<polars::error::PolarsError> for AnalyticsError {
    fn from(error: polars::error::PolarsError) -> Self {
        Self::Polars(error.to_string())
    }
}

impl AnalyticsError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Io(_) => "IO_ERROR",
            Self::Json(_) => "JSON_ERROR",
            Self::Polars(_) => "COLUMNAR_ERROR",
            Self::InvalidDate { .. } => "INVALID_DATE",
            Self::InvalidFilter { .. } => "INVALID_FILTER",
            Self::MissingColumn { .. } => "MISSING_COLUMN",
            Self::MissingLiquidityFile { .. } => "MISSING_LIQUIDITY_FILE",
            Self::MissingLiquidityRank { .. } => "MISSING_LIQUIDITY_RANK",
            Self::LiquidityRankOutOfRange { .. } => "LIQUIDITY_RANK_OUT_OF_RANGE",
            Self::StoreMissing { .. } => "STORE_MISSING",
        }
    }
}
