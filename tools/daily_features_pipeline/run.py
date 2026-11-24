#!/usr/bin/env python3
"""Run the complete BigCaps daily_features pipeline in order.

Stage 1 builds the core pre-market features and rankings from daily OHLCV and
split history. Stage 2 adds split-adjusted 3-session momentum and forward RTH
outcomes measured from the event session's open through the selected
closes up to D+40.
"""

from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path


def main() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--data-root",
        type=Path,
        default=repo_root / "data",
        help="Dataset root with daily/, metadata/splits.parquet and research/",
    )
    parser.add_argument(
        "--input",
        type=Path,
        default=None,
        help="Monthly source OHLCV (default: <data-root>/daily)",
    )
    parser.add_argument(
        "--buckets",
        type=int,
        default=32,
        help="Temporary ticker buckets used to bound memory (16-128)",
    )
    parser.add_argument(
        "--overwrite",
        action="store_true",
        help="Allow replacing existing daily_features partitions",
    )
    parser.add_argument("--from-month", help="First month of core features to regenerate")
    parser.add_argument("--forward-from-month", help="First month of forward returns to refresh")
    args = parser.parse_args()

    data_root = args.data_root.resolve()
    input_root = (args.input or data_root / "daily").resolve()
    build_script = Path(__file__).with_name("build_features.py")

    build_command = [
        sys.executable,
        str(build_script),
        "--data-root",
        str(data_root),
        "--input",
        str(input_root),
        "--buckets",
        str(args.buckets),
    ]
    if args.overwrite:
        build_command.append("--overwrite")
    if args.from_month:
        build_command.extend(["--from-month", args.from_month])

    print("[daily_features 1/2] Building split-aware features and rankings", flush=True)
    subprocess.run(build_command, cwd=repo_root, check=True)

    print("[daily_features 2/2] Adding 3-session momentum and forward RTH outcomes", flush=True)
    forward_command = [
        sys.executable,
        "-m",
        "tools.daily_features_pipeline.add_forward_features",
        "--data-root",
        str(data_root),
    ]
    if args.forward_from_month:
        forward_command.extend(["--from-month", args.forward_from_month])
    subprocess.run(forward_command, cwd=repo_root, check=True)


if __name__ == "__main__":
    main()
