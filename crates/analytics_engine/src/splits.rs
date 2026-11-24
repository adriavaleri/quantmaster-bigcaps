use std::{collections::BTreeMap, fs::File, path::Path};

use chrono::NaiveDate;
use polars::prelude::*;

use crate::error::AnalyticsError;

/// Point-in-time corporate-action factors for the unadjusted market files.
///
/// A value from `session_date` is converted to the price scale of
/// `reference_date` with the product of events where
/// `session_date < execution_date <= reference_date`.
#[derive(Clone, Debug, Default)]
pub struct SplitIndex {
    events: BTreeMap<String, Vec<(NaiveDate, f64)>>,
}

impl SplitIndex {
    pub fn load(data_root: &Path) -> Result<Self, AnalyticsError> {
        let canonical_path = data_root
            .join("reference")
            .join("corporate_actions")
            .join("splits")
            .join("latest_splits.parquet");
        let metadata_path = data_root.join("metadata").join("splits.parquet");
        let path = if canonical_path.is_file() {
            canonical_path
        } else {
            metadata_path
        };
        if !path.is_file() {
            return Ok(Self::default());
        }

        let frame = ParquetReader::new(File::open(&path)?).finish()?;
        for required in ["ticker", "execution_date"] {
            if frame.column(required).is_err() {
                return Err(AnalyticsError::MissingColumn {
                    dataset: path.display().to_string(),
                    column: required.to_owned(),
                });
            }
        }

        let tickers = frame.column("ticker")?.cast(&DataType::String)?;
        let dates = frame.column("execution_date")?.cast(&DataType::String)?;
        let tickers = tickers.str()?;
        let dates = dates.str()?;
        let direct_factor_series = frame
            .column("factor")
            .ok()
            .and_then(|column| column.cast(&DataType::Float64).ok());
        let split_from_series = frame
            .column("split_from")
            .ok()
            .and_then(|column| column.cast(&DataType::Float64).ok());
        let split_to_series = frame
            .column("split_to")
            .ok()
            .and_then(|column| column.cast(&DataType::Float64).ok());
        let historical_adjustment_series = frame
            .column("historical_adjustment_factor")
            .ok()
            .and_then(|column| column.cast(&DataType::Float64).ok());
        if direct_factor_series.is_none()
            && (split_from_series.is_none() || split_to_series.is_none())
            && historical_adjustment_series.is_none()
        {
            return Err(AnalyticsError::MissingColumn {
                dataset: path.display().to_string(),
                column: "factor or split_from/split_to".to_owned(),
            });
        }
        let direct_factors = direct_factor_series
            .as_ref()
            .and_then(|column| column.f64().ok());
        let split_from = split_from_series
            .as_ref()
            .and_then(|column| column.f64().ok());
        let split_to = split_to_series
            .as_ref()
            .and_then(|column| column.f64().ok());
        let historical_adjustment = historical_adjustment_series
            .as_ref()
            .and_then(|column| column.f64().ok());
        let mut grouped = BTreeMap::<String, BTreeMap<NaiveDate, f64>>::new();

        for index in 0..frame.height() {
            let Some(ticker) = tickers.get(index) else {
                continue;
            };
            let Some(date_text) = dates.get(index) else {
                continue;
            };
            let factor = direct_factors
                .and_then(|values| values.get(index))
                .or_else(|| {
                    let from = split_from.and_then(|values| values.get(index))?;
                    let to = split_to.and_then(|values| values.get(index))?;
                    (from != 0.0).then_some(to / from)
                })
                .or_else(|| {
                    let adjustment = historical_adjustment.and_then(|values| values.get(index))?;
                    (adjustment != 0.0).then_some(1.0 / adjustment)
                });
            let Some(factor) = factor else {
                continue;
            };
            let date_text = date_text
                .trim()
                .strip_prefix("Date(")
                .and_then(|value| value.strip_suffix(')'))
                .unwrap_or(date_text);
            let date_text = date_text.get(..10).unwrap_or(date_text);
            let execution_date =
                NaiveDate::parse_from_str(date_text, "%Y-%m-%d").map_err(|_| {
                    AnalyticsError::InvalidDate {
                        value: date_text.to_owned(),
                    }
                })?;
            let ticker = ticker.trim().to_ascii_uppercase();
            if ticker.is_empty() || !factor.is_finite() || factor <= 0.0 {
                return Err(AnalyticsError::InvalidFilter {
                    message: format!(
                        "invalid split record for {ticker} on {execution_date}: factor={factor}"
                    ),
                });
            }
            grouped
                .entry(ticker)
                .or_default()
                .entry(execution_date)
                .and_modify(|value| *value *= factor)
                .or_insert(factor);
        }

        let events = grouped
            .into_iter()
            .map(|(ticker, dates)| (ticker, dates.into_iter().collect()))
            .collect();
        Ok(Self { events })
    }

    pub fn factor(&self, ticker: &str, session_date: NaiveDate, reference_date: NaiveDate) -> f64 {
        if reference_date <= session_date {
            return 1.0;
        }
        let Some(events) = self.events.get(&ticker.trim().to_ascii_uppercase()) else {
            return 1.0;
        };
        events
            .iter()
            .filter(|(date, _)| *date > session_date && *date <= reference_date)
            .fold(1.0, |product, (_, factor)| product * factor)
    }

    #[cfg(test)]
    fn from_records(records: &[(&str, &str, f64)]) -> Self {
        let mut grouped = BTreeMap::<String, BTreeMap<NaiveDate, f64>>::new();
        for (ticker, date, factor) in records {
            let date = NaiveDate::parse_from_str(date, "%Y-%m-%d").unwrap();
            grouped
                .entry((*ticker).to_owned())
                .or_default()
                .entry(date)
                .and_modify(|value| *value *= *factor)
                .or_insert(*factor);
        }
        Self {
            events: grouped
                .into_iter()
                .map(|(ticker, dates)| (ticker, dates.into_iter().collect()))
                .collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::SplitIndex;
    use chrono::NaiveDate;

    #[test]
    fn applies_forward_split_only_after_execution_date() {
        let index = SplitIndex::from_records(&[("TEST", "2020-01-10", 2.0)]);
        let before = NaiveDate::from_ymd_opt(2020, 1, 9).unwrap();
        let event = NaiveDate::from_ymd_opt(2020, 1, 10).unwrap();
        let after = NaiveDate::from_ymd_opt(2020, 1, 13).unwrap();
        assert_eq!(index.factor("TEST", before, before), 1.0);
        assert_eq!(index.factor("TEST", before, event), 2.0);
        assert_eq!(index.factor("TEST", before, after), 2.0);
        assert_eq!(index.factor("TEST", event, after), 1.0);
    }

    #[test]
    fn multiplies_forward_and_reverse_events() {
        let index =
            SplitIndex::from_records(&[("TEST", "2020-01-10", 2.0), ("TEST", "2020-02-10", 0.5)]);
        let before = NaiveDate::from_ymd_opt(2020, 1, 9).unwrap();
        let after = NaiveDate::from_ymd_opt(2020, 2, 11).unwrap();
        assert_eq!(index.factor("TEST", before, after), 1.0);
    }
}
