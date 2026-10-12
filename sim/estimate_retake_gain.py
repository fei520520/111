#!/usr/bin/env python3
"""Stage 4: how much does "change the view" actually help? Estimate it from real recordings.

The policy simulation (`sim/simulate_clarify_policy.py`) assumes a clarified sample ends up
answered correctly. That is an OPTIMISTIC upper bound: it assumes the very thing the study
wants to establish, and a reviewer can discount the whole result because of it.

This script replaces the assumption with an observation. In the recorded phone sessions
(`run/experiments/*/live/frames.jsonl`) every frame carries the app's own cheap quality
measures. A user who is asked to adjust the phone produces exactly the sequence
"bad frame -> ... -> better frame", so the *actual* recovery can be measured.

What is reported:
  - the sharpness distribution across all recorded frames;
  - for every "bad" frame, the best quality reached within a short horizon (the plausible
    window for a spoken request plus a human adjustment);
  - the recovery rate and the empirical size of the gain.

Limitations (stated, not hidden):
  - `quality.sharpness` is the app's own focus measure, not ground truth;
  - "same scene" across the pair is NOT verified here, so this brackets the achievable
    gain rather than measuring the gain for a specific question.

Usage:
    python sim/estimate_retake_gain.py --experiments run/experiments \
        --out run/research/retake-gain-v1.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

BAD_QUANTILE = 0.25   # frames below this per-session quantile are treated as "did not capture well"
GOOD_QUANTILE = 0.75  # frames above this are "captured well"
DEFAULT_HORIZON_MS = 8000


def load_session(frame_log: Path) -> list[dict]:
    """Read one frames.jsonl into an ordered list of (timestamp, sharpness, exposure)."""
    rows = []
    for line in frame_log.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        try:
            record = json.loads(line)
        except json.JSONDecodeError:
            continue
        quality = record.get("quality") or {}
        sharpness = quality.get("sharpness")
        if not isinstance(sharpness, (int, float)):
            continue
        rows.append({
            "timestampMs": record.get("timestampMs"),
            "sharpness": float(sharpness),
            "exposure": float(quality["exposure"]) if isinstance(quality.get("exposure"), (int, float)) else None,
        })
    rows.sort(key=lambda row: row["timestampMs"] or 0)
    return rows


def analyze_session(rows: list[dict], horizon_ms: int) -> dict | None:
    if len(rows) < 8:
        return None
    values = np.array([row["sharpness"] for row in rows], dtype=np.float64)
    bad_cut = float(np.quantile(values, BAD_QUANTILE))
    good_cut = float(np.quantile(values, GOOD_QUANTILE))

    recoveries = []
    for index, row in enumerate(rows):
        if row["sharpness"] > bad_cut:
            continue  # only start from frames that did not capture well
        start = row["timestampMs"] or 0
        window = [
            other["sharpness"] for other in rows[index + 1:]
            if (other["timestampMs"] or 0) - start <= horizon_ms
        ]
        if not window:
            continue
        best = max(window)
        recoveries.append({
            "from": round(row["sharpness"], 4),
            "best": round(best, 4),
            "gain": round(best - row["sharpness"], 4),
            "reachedGood": bool(best >= good_cut),
        })

    if not recoveries:
        return None
    gains = np.array([item["gain"] for item in recoveries], dtype=np.float64)
    return {
        "frames": len(rows),
        "badCut": round(bad_cut, 4),
        "goodCut": round(good_cut, 4),
        "badFramesAnalyzed": len(recoveries),
        "recoveryRate": round(float(np.mean([item["reachedGood"] for item in recoveries])), 3),
        "meanGain": round(float(gains.mean()), 4),
        "medianGain": round(float(np.median(gains)), 4),
        "p90Gain": round(float(np.quantile(gains, 0.9)), 4),
        "sharpnessP10": round(float(np.quantile(values, 0.1)), 4),
        "sharpnessP50": round(float(np.quantile(values, 0.5)), 4),
        "sharpnessP90": round(float(np.quantile(values, 0.9)), 4),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Estimate the real gain of 'changing the view' from recordings.")
    parser.add_argument("--experiments", required=True, type=Path, help="Directory containing <session>/live/frames.jsonl")
    parser.add_argument("--out", required=True, type=Path, help="Output JSON.")
    parser.add_argument("--horizon-ms", type=int, default=DEFAULT_HORIZON_MS,
                        help="How long after a bad frame we still count a recovery (speech + human adjustment).")
    args = parser.parse_args()

    sessions = {}
    for frame_log in sorted(args.experiments.glob("*/live/frames.jsonl")):
        rows = load_session(frame_log)
        stats = analyze_session(rows, args.horizon_ms)
        if stats:
            sessions[frame_log.parent.parent.name] = stats

    if not sessions:
        raise SystemExit(f"no usable frames.jsonl under {args.experiments}")

    recovery_rates = [item["recoveryRate"] for item in sessions.values()]
    mean_gains = [item["meanGain"] for item in sessions.values()]

    report = {
        "protocol": "retake-gain-estimate-v1",
        "horizonMs": args.horizon_ms,
        "sessions": sessions,
        "aggregate": {
            "sessionCount": len(sessions),
            "recoveryRateMean": round(float(np.mean(recovery_rates)), 3),
            "recoveryRateMedian": round(float(np.median(recovery_rates)), 3),
            "meanGainMean": round(float(np.mean(mean_gains)), 4),
            "totalBadFrames": int(sum(item["badFramesAnalyzed"] for item in sessions.values())),
        },
        "howToUse": (
            "simulate_clarify_policy.py currently assumes a clarified sample becomes correct (optimistic bound). "
            "A more defensible policy model: a clarified sample is repaired only with probability = recoveryRate, "
            "and the repaired image is only as good as sharpnessP50/P90 rather than 'clean'."
        ),
        "note": (
            "quality.sharpness is the app's own cheap focus measure and same-scene identity across the pair is not "
            "verified, so this brackets the gain instead of measuring it for a specific question. Real recordings, "
            "not a simulation."
        ),
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report["aggregate"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
