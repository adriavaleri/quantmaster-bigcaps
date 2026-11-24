from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

from tools.daily_features_pipeline.add_forward_features import compute_partition


class ThreeDayMomentumRankingTests(unittest.TestCase):
    def test_rank_3d_is_cross_sectional_eligible_and_uses_only_prior_sessions(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory) / "research" / "daily_features"
            partition = root / "year=2024" / "month=01.parquet"
            partition.parent.mkdir(parents=True)
            staging_root = Path(temporary_directory) / "staging"

            dates = pd.bdate_range("2024-01-02", periods=5)
            close_by_ticker = {
                # Jan 8 closes are deliberately extreme. Momentum for Jan 8
                # must use Jan 5 and Jan 2 closes, never the Jan 8 close.
                "AAA": [100.0, 105.0, 110.0, 130.0, 500.0],
                "BBB": [100.0, 102.0, 104.0, 108.0, 200.0],
                "PENNY": [0.5, 0.55, 0.6, 0.9, 2.0],
            }
            rows = []
            for ticker, closes in close_by_ticker.items():
                for index, (date, close) in enumerate(zip(dates, closes)):
                    rows.append(
                        {
                            "date": date,
                            "ticker": ticker,
                            "close": close,
                            "rth_return_pct": 0.0,
                            "price_prev_close": np.nan if index == 0 else closes[index - 1],
                            "momentum_1w": np.nan,
                            "rank_3d": 999.0,
                            "pct_rank_1m": 50.0,
                        }
                    )
            pd.DataFrame(rows).to_parquet(partition, index=False)

            staged_path, *_ = compute_partition(partition, staging_root, {})
            result = pd.read_parquet(staged_path)

            jan_8 = result[pd.to_datetime(result["date"]) == pd.Timestamp("2024-01-08")].set_index("ticker")
            self.assertAlmostEqual(jan_8.loc["AAA", "momentum_3d"], 30.0)
            self.assertAlmostEqual(jan_8.loc["BBB", "momentum_3d"], 8.0)
            self.assertEqual(jan_8.loc["AAA", "rank_3d"], 1.0)
            self.assertEqual(jan_8.loc["BBB", "rank_3d"], 2.0)
            self.assertTrue(pd.isna(jan_8.loc["PENNY", "rank_3d"]))
            self.assertFalse(any(name.startswith("pct_rank_") for name in result.columns))


if __name__ == "__main__":
    unittest.main()
