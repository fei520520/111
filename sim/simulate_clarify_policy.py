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


def final_accuracy(order: list[bool], clarify_count: int) -> float:
    """Clarified samples become correct (optimistic bound); the rest keep their own outcome."""
    n = len(order)
    kept = order[: n - clarify_count] if clarify_count else order
    clarified_correct = clarify_count  # every clarified sample is assumed fixed
    return (sum(1 for ok in kept if ok) + clarified_correct) / n


def curve(rows: list[dict], key: str) -> list[dict]:
    """Sort by a signal (low = more doubtful -> clarify first), then sweep the clarify budget."""
    order = sorted(rows, key=lambda r: r[key])          # lowest signal clarified first
    kept_outcomes = [r["correct_if_kept"] for r in reversed(order)]  # best-kept first
    n = len(rows)
    out = []
    for step in range(0, 11):
        clarify = int(n * step / 10)
        out.append({"clarifyRate": round(step / 10, 1), "clarifyCount": clarify,
                    "finalAccuracy": round(final_accuracy(kept_outcomes, clarify), 3)})
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Compare clarification trigger policies (offline simulation).")
    parser.add_argument("--results", required=True, type=Path)
    parser.add_argument("--dataset", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    args = parser.parse_args()

    rows = build_rows(args.results, args.dataset)
    if not rows:
        raise SystemExit("no usable rows")

    fused = fuse(rows)
    for row, score in zip(rows, fused):
        row["fused"] = score

    base_accuracy = round(sum(1 for r in rows if r["correct_if_kept"]) / len(rows), 3)
    policies = {
        "clarity_none": [{"clarifyRate": 0.0, "clarifyCount": 0, "finalAccuracy": base_accuracy}],
        "byModelConfidence": curve(rows, "model_confidence"),
        "bySharpness": curve(rows, "sharpness"),
        "byFused": curve(rows, "fused"),
    }

    # Summary: how much clarification each policy needs to reach a target accuracy.
    targets = [0.7, 0.8, 0.9]
    cost_to_target = {}
    for name, points in policies.items():
        cost_to_target[name] = {}
        for target in targets:
            hit = next((p for p in points if p["finalAccuracy"] >= target), None)
            cost_to_target[name][f"reach{target}"] = hit["clarifyRate"] if hit else None

    report = {
        "protocol": "clarify-policy-simulation-v1",
        "samples": len(rows),
        "baseAccuracyNoClarification": base_accuracy,
        "assumption": "A clarified sample is assumed answered correctly (optimistic upper bound). This isolates the trigger policy, not the follow-up model.",
        "policies": policies,
        "clarifyRateToReachTarget": cost_to_target,
        "note": "Developer simulation on 40 samples, not a validated reliability result.",
    }
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"baseAccuracyNoClarification": base_accuracy, "clarifyRateToReachTarget": cost_to_target}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
