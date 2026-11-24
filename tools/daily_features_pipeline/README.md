# Daily feature pipeline

Run `python -m tools.data_pipeline update` for normal updates. To regenerate
only the daily features from local inputs, use
`python -m tools.daily_features_pipeline.run --data-root <dataset> --overwrite`.
The inputs are the monthly unadjusted daily bars and the split register.
The full feature build preserves existing market cap values by date and ticker.

Core features include split-aware moving averages, momentum rankings and
price extremes. The forward stage adds returns through D+10 and then every
five market sessions through D+40. See [the data guide](../../docs/data.md)
for the dataset layout and update options.
