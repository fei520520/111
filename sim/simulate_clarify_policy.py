#!/usr/bin/env python3
"""Stage 3-4: simulate the clarification loop and compare trigger policies.

Idea (docs/research/clarifying-dialogue.md): when the system is unsure it can ASK the user
to adjust the view. We cannot re-shoot inside this offline study, so we *simulate* the outcome:

  - the ambiguous image is what the user shows now;
  - if the system decides to clarify, we assume the follow-up view is clean (an OPTIMISTIC
    upper bound: the user does turn/approach and the clean image is what the model would see);
  - if it does not clarify, it keeps the ambiguous answer.

So the only thing that matters is: **which samples do we spend clarification on?**
A good trigger selects the samples that are actually wrong. We compare several signals
(model confidence / image sharpness / a fused score / oracle) and report, for each,
the final accuracy as a function of how many samples we clarify.

A model with a useful uncertainty signal reaches high accuracy with FEW clarifications.
This is the core "active clarification" experiment.

Usage:
    python sim/simulate_clarify_policy.py --results run/research/ambiguous-v3/eval/results.jsonl \
        --dataset run/research/ambiguous-v3 --out run/research/ambiguous-v3/policy.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from analyze_uncertainty import CORRECT_SIMILARITY, fuse, quality_features


def build_rows(results_path: Path, dataset: Path) -> list[dict]:
    rows = []
    for line in results_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        features = quality_features(dataset / record["image"])
        if not features:
            continue
        rows.append({
            "id": record["id"],
            "correct_if_kept": record.get("similarityToClean", 0.0) >= CORRECT_SIMILARITY,
            "model_confidence": record["ambiguous"]["confidence"],
            "sharpness": features["sharpness"],
        })
    return rows


def final_accuracy(order: list[bool], clarify_count: int, repair_rate: float = 1.0) -> float:
    """Accuracy after clarifying `clarify_count` samples.

    repair_rate is the probability that a clarification actually repairs the sample:
      - 1.0 -> the old optimistic upper bound (every clarified sample becomes correct);
      - p<1 -> a clarified sample becomes correct with probability p and otherwise keeps its
        original outcome. p is estimated from real recordings by sim/estimate_retake_gain.py
        (measured recovery rate ~0.50), instead of being assumed.
    """
    n = len(order)
    if clarify_count <= 0:
        return sum(1 for ok in order if ok) / n
    kept = order[: n - clarify_count]
    clarified = order[n - clarify_count:]
    kept_correct = sum(1 for ok in kept if ok)
    clarified_expected = repair_rate * len(clarified) + (1 - repair_rate) * sum(1 for ok in clarified if ok)
    return (kept_correct + clarified_expected) / n


def curve(rows: list[dict], key: str, repair_rate: float = 1.0) -> list[dict]:
    """Sort by a signal (low = more doubtful -> clarify first), then sweep the clarify budget."""
    order = sorted(rows, key=lambda r: r[key])          # lowest signal clarified first
    kept_outcomes = [r["correct_if_kept"] for r in reversed(order)]  # best-kept first
    n = len(rows)
    out = []
    for step in range(0, 11):
        clarify = int(n * step / 10)
        out.append({"clarifyRate": round(step / 10, 1), "clarifyCount": clarify,
                    "finalAccuracy": round(final_accuracy(kept_outcomes, clarify, repair_rate), 3)})
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Compare clarification trigger policies (offline simulation).")
    parser.add_argument("--results", required=True, type=Path)
    parser.add_argument("--dataset", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--repair-rate", type=float, default=1.0,
                        help="Probability a clarification repairs the sample. 1.0 = optimistic upper bound.")
    parser.add_argument("--retake-gain", type=Path, default=None,
                        help="retake-gain JSON from estimate_retake_gain.py; its measured recovery rate overrides --repair-rate.")
    args = parser.parse_args()

    repair_rate = args.repair_rate
    measured = None
    if args.retake_gain and args.retake_gain.is_file():
        measured = json.loads(args.retake_gain.read_text(encoding="utf-8"))
        repair_rate = float(measured["aggregate"]["recoveryRateMean"])

    rows = build_rows(args.results, args.dataset)
    if not rows:
        raise SystemExit("no usable rows")

    fused = fuse(rows)
    for row, score in zip(rows, fused):
        row["fused"] = score

    base_accuracy = round(sum(1 for r in rows if r["correct_if_kept"]) / len(rows), 3)

    def build_policies(rate: float) -> dict:
        return {
            "clarity_none": [{"clarifyRate": 0.0, "clarifyCount": 0, "finalAccuracy": base_accuracy}],
            "byModelConfidence": curve(rows, "model_confidence", rate),
            "bySharpness": curve(rows, "sharpness", rate),
            "byFused": curve(rows, "fused", rate),
        }

    # Summary: how much clarification each policy needs to reach a target accuracy.
    def cost_table(policies: dict) -> dict:
        targets = [0.7, 0.8, 0.9]
        table = {}
        for name, points in policies.items():
            table[name] = {}
            for target in targets:
                hit = next((p for p in points if p["finalAccuracy"] >= target), None)
                table[name][f"reach{target}"] = hit["clarifyRate"] if hit else None
        return table

    policies = build_policies(repair_rate)
    cost_to_target = cost_table(policies)

    # The same sweep under the optimistic assumption, so the size of the optimism is explicit.
    optimistic_policies = build_policies(1.0)
    optimistic_cost = cost_table(optimistic_policies)

    report = {
        "protocol": "clarify-policy-simulation-v2",
        "samples": len(rows),
        "baseAccuracyNoClarification": base_accuracy,
        "repairRate": round(repair_rate, 3),
        "repairRateSource": (
            f"measured from recordings via estimate_retake_gain.py (recovery rate over "
            f"{measured['aggregate']['totalBadFrames']} bad frames / {measured['aggregate']['sessionCount']} sessions)"
            if measured else "assumed (use --retake-gain to plug in the measured recovery rate)"
        ),
        "policies": policies,
        "clarifyRateToReachTarget": cost_to_target,
        "optimisticUpperBound": {
            "repairRate": 1.0,
            "clarifyRateToReachTarget": optimistic_cost,
            "note": "What earlier reports assumed. The gap between this and 'clarifyRateToReachTarget' is the size of the optimism.",
        },
        "ceilingAtRepairRate": round(base_accuracy + repair_rate * (1 - base_accuracy), 3),
        "note": (
            "Developer simulation on the available samples, not a validated reliability result. "
            "The ceiling line shows the best accuracy reachable if EVERY sample were clarified at this repair rate."
        ),
    }
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "baseAccuracyNoClarification": base_accuracy,
        "repairRate": report["repairRate"],
        "ceilingAtRepairRate": report["ceilingAtRepairRate"],
        "clarifyRateToReachTarget": cost_to_target,
        "optimisticClarifyRateToReachTarget": optimistic_cost,
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
