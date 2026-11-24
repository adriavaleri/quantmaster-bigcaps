from __future__ import annotations

import unittest

import numpy as np
import pandas as pd

from tools.daily_features_pipeline.build_features import (
    add_momentum_rankings,
    features_ticker,
    split_adjusted_running_extremes,
    wilder_rma,
)


def make_bars(dates, highs, lows, closes, opens=None) -> pd.DataFrame:
    return pd.DataFrame(
        {
            "date": dates,
            "ticker": "TEST",
            "open": closes if opens is None else opens,
            "high": highs,
            "low": lows,
            "close": closes,
            "volume": np.full(len(dates), 100_000.0),
        }
    )


def session_index_for(dates) -> dict[np.datetime64, int]:
    return {pd.Timestamp(date).to_datetime64(): index for index, date in enumerate(dates)}


class WilderRmaTests(unittest.TestCase):
    def test_seeds_from_full_period_then_applies_wilder_recurrence(self) -> None:
        values = np.array([np.nan, 1.0, 2.0, 3.0, 4.0, 8.0])

        result = wilder_rma(values, 3)

        self.assertTrue(np.isnan(result[:3]).all())
        self.assertEqual(result[3], 2.0)
        self.assertAlmostEqual(result[4], 8.0 / 3.0)
        self.assertAlmostEqual(result[5], 40.0 / 9.0)

    def test_requires_a_full_seed_window_and_restarts_after_missing_values(self) -> None:
        values = np.array([np.nan, 1.0, 2.0, np.nan, 3.0, 4.0, 5.0])

        result = wilder_rma(values, 3)

        self.assertTrue(np.isnan(result[:6]).all())
        self.assertEqual(result[6], 4.0)


class MomentumRankingTests(unittest.TestCase):
    def test_adds_ranks_for_all_stage_one_momenta_and_removes_percentiles(self) -> None:
        data = pd.DataFrame(
            {
                "date": pd.to_datetime(["2024-01-02"] * 3),
                "ticker": ["AAA", "BBB", "CCC"],
                "price_prev_close": [10.0, 20.0, 30.0],
                "momentum_1d": [2.0, 5.0, 5.0],
                "momentum_1w": [-1.0, 1.0, 0.0],
                "momentum_1m": [1.0, 2.0, 3.0],
                "momentum_3m": [3.0, 2.0, 1.0],
                "momentum_6m": [2.0, 2.0, 1.0],
                "pct_rank_1m": [33.0, 67.0, 100.0],
            }
        )

        result = add_momentum_rankings(data)

        for period in ("1d", "1w", "1m", "3m", "6m"):
            self.assertIn(f"rank_{period}", result.columns)
        self.assertEqual(result["rank_1d"].tolist(), [3.0, 1.0, 1.0])
        self.assertEqual(result["rank_1w"].tolist(), [3.0, 1.0, 2.0])
        self.assertFalse(any(name.startswith("pct_rank_") for name in result.columns))


class PointInTimeFeatureTests(unittest.TestCase):
    def test_daily_feature_schema_keeps_ema_10_20_but_omits_ema_50(self) -> None:
        dates = pd.bdate_range("2024-01-02", periods=3)
        bars = make_bars(
            dates,
            highs=[11.0, 12.0, 13.0],
            lows=[9.0, 10.0, 11.0],
            closes=[10.0, 11.0, 12.0],
        )

        result = features_ticker(bars, {}, session_index_for(dates))

        self.assertIn("ema_10", result.columns)
        self.assertIn("ema_20", result.columns)
        self.assertNotIn("ema_50", result.columns)

    def test_previous_day_returns_and_candle_streaks_use_only_completed_sessions(self) -> None:
        dates = pd.bdate_range("2024-01-02", periods=7)
        opens = np.array([9.0, 12.0, 13.0, 10.0, 15.0, 13.0, 14.0])
        closes = np.array([10.0, 12.6, 11.0, 14.0, 13.0, 13.0, 15.0])
        highs = np.maximum(opens, closes) + 1.0
        lows = np.minimum(opens, closes) - 1.0
        bars = make_bars(dates, highs, lows, closes, opens=opens)

        result = features_ticker(bars, {}, session_index_for(dates))

        self.assertTrue(np.isnan(result.loc[0, "momentum_1d"]))
        self.assertTrue(np.isnan(result.loc[0, "prev_day_return_pct"]))
        # Row 2 uses row 1's completed return, never row 2's own candle.
        self.assertAlmostEqual(result.loc[2, "momentum_1d"], 26.0)
        self.assertAlmostEqual(result.loc[2, "prev_day_return_pct"], 5.0)
        self.assertAlmostEqual(result.loc[2, "price_prev_close"], 12.6)
        self.assertEqual(result.loc[1, "consecutive_green_bars"], 1)
        self.assertEqual(result.loc[2, "consecutive_green_bars"], 2)
        self.assertEqual(result.loc[2, "consecutive_red_bars"], 0)
        self.assertEqual(result.loc[3, "consecutive_red_bars"], 1)
        self.assertEqual(result.loc[4, "consecutive_green_bars"], 1)
        # A doji on row 5 resets both streaks for the next feature row.
        self.assertEqual(result.loc[6, "consecutive_green_bars"], 0)
        self.assertEqual(result.loc[6, "consecutive_red_bars"], 0)

    def test_previous_day_return_is_split_adjusted(self) -> None:
        dates = pd.bdate_range("2024-01-02", periods=4)
        opens = [90.0, 100.0, 50.0, 55.0]
        closes = [100.0, 120.0, 55.0, 60.0]
        highs = [105.0, 125.0, 58.0, 62.0]
        lows = [88.0, 98.0, 49.0, 53.0]
        bars = make_bars(dates, highs, lows, closes, opens=opens)
        split_date = dates[2].to_datetime64()
        splits = {"TEST": (np.array([split_date]), np.array([np.log(2.0)]))}

        result = features_ticker(bars, splits, session_index_for(dates))

        self.assertAlmostEqual(result.loc[2, "price_prev_close"], 60.0)
        # On feature row 3, row 2's close is compared with row 1's close
        # expressed on the post-split share basis: 55 / (120 / 2) - 1.
        self.assertAlmostEqual(result.loc[3, "momentum_1d"], (55.0 / 60.0 - 1.0) * 100.0)
        self.assertAlmostEqual(result.loc[3, "prev_day_return_pct"], 10.0)

    def test_daily_streak_restarts_after_a_missing_market_session(self) -> None:
        calendar = pd.bdate_range("2024-01-02", periods=5)
        observed = calendar[[0, 1, 3, 4]]
        opens = np.array([9.0, 10.0, 12.0, 13.0])
        closes = np.array([10.0, 11.0, 13.0, 14.0])
        bars = make_bars(
            observed,
            np.maximum(opens, closes) + 1.0,
            np.minimum(opens, closes) - 1.0,
            closes,
            opens=opens,
        )

        result = features_ticker(bars, {}, session_index_for(calendar))

        self.assertTrue(np.isnan(result.loc[2, "prev_day_return_pct"]))
        self.assertTrue(pd.isna(result.loc[2, "consecutive_green_bars"]))
        self.assertEqual(result.loc[3, "consecutive_green_bars"], 1)

    def test_52_week_low_needs_252_prior_sessions_and_excludes_feature_day(self) -> None:
        dates = pd.bdate_range("2024-01-02", periods=253)
        highs = np.full(253, 20.0)
        lows = np.full(253, 10.0)
        closes = np.full(253, 15.0)
        # This is the feature date itself and must not enter its calculation.
        highs[-1], lows[-1], closes[-1] = 30.0, 1.0, 15.0
        bars = make_bars(dates, highs, lows, closes)

        result = features_ticker(bars, {}, session_index_for(dates))

        self.assertTrue(np.isnan(result.loc[251, "distance_52w_low_pct"]))
        self.assertAlmostEqual(result.loc[252, "distance_52w_low_pct"], 50.0)

    def test_ath_uses_prior_session_and_atl_uses_current_open_with_split_adjustment(self) -> None:
        dates = pd.bdate_range("2024-01-02", periods=4)
        bars = make_bars(
            dates,
            highs=[110.0, 120.0, 60.0, 65.0],
            lows=[90.0, 80.0, 40.0, 35.0],
            closes=[100.0, 110.0, 55.0, 60.0],
        )
        split_date = dates[2].to_datetime64()
        splits = {"TEST": (np.array([split_date]), np.array([np.log(2.0)]))}

        result = features_ticker(bars, splits, session_index_for(dates))

        self.assertTrue(np.isnan(result.loc[0, "distance_ath_high_pct"]))
        # ATH remains prior-session based; ATL uses the current open versus prior lows.
        self.assertAlmostEqual(result.loc[1, "distance_ath_high_pct"], (100.0 / 110.0 - 1.0) * 100.0)
        self.assertAlmostEqual(result.loc[1, "distance_atl_low_pct"], (110.0 / 90.0 - 1.0) * 100.0)
        # The split on day 2 rescales the prior extremes into day 3's price basis.
        self.assertAlmostEqual(result.loc[3, "distance_ath_high_pct"], (55.0 / 60.0 - 1.0) * 100.0)
        self.assertAlmostEqual(result.loc[3, "distance_atl_low_pct"], (60.0 / 40.0 - 1.0) * 100.0)

    def test_running_all_time_extremes_are_in_each_session_split_basis(self) -> None:
        highs = np.array([110.0, 120.0, 60.0])
        lows = np.array([90.0, 80.0, 40.0])
        split_logs = np.array([0.0, 0.0, np.log(2.0)])

        all_time_high, all_time_low = split_adjusted_running_extremes(highs, lows, split_logs)

        np.testing.assert_allclose(all_time_high, [110.0, 120.0, 60.0])
        np.testing.assert_allclose(all_time_low, [90.0, 80.0, 40.0])

    def test_atr_uses_14_complete_true_ranges_wilder_seed_and_feature_date_basis(self) -> None:
        dates = pd.bdate_range("2024-01-02", periods=17)
        highs = np.full(17, 102.0)
        lows = np.full(17, 98.0)
        closes = np.full(17, 100.0)
        # A 2-for-1 split takes effect on feature row 15. That row's ATR must
        # use data only through row 14, then express the result in row 15 units.
        highs[15:] = 51.0
        lows[15:] = 49.0
        closes[15:] = 50.0
        # Large range and close on D itself must not enter D's feature values.
        highs[15], lows[15], closes[15] = 101.0, 49.0, 80.0
        bars = make_bars(dates, highs, lows, closes)
        split_date = dates[15].to_datetime64()
        splits = {"TEST": (np.array([split_date]), np.array([np.log(2.0)]))}

        result = features_ticker(bars, splits, session_index_for(dates))

        self.assertTrue(np.isnan(result.loc[14, "atr_14d"]))
        self.assertTrue(np.isnan(result.loc[14, "atr_14d_pct"]))
        self.assertAlmostEqual(result.loc[15, "atr_14d"], 2.0)
        self.assertAlmostEqual(result.loc[15, "price_prev_close"], 50.0)
        self.assertAlmostEqual(result.loc[15, "atr_14d_pct"], 4.0)


if __name__ == "__main__":
    unittest.main()
