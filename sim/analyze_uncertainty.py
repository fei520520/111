#!/usr/bin/env python3
"""Which signal best predicts a wrong answer under ambiguity?

Stage 2 of the clarifying-dialogue line (docs/research/clarifying-dialogue.md).
Reads the results from `sim/eval_clarify_baseline.py`, computes cheap *image-quality*
features offline (no extra API cost), and compares how well each signal separates
correct from wrong answers using AUC (area under the ROC curve).

Signals compared:
  - model confidence   (what the VLM says about itself)
  - sharpness          (Laplacian variance)
  - brightness         (mean luminance)
  - contrast           (std of luminance)
  - dark_ratio         (fraction of very dark pixels)

A signal with AUC ~0.5 cannot tell correct from wrong; higher is better. The point of
the study is to check whether the model's self-reported confidence is actually useful,
or whether independent image features are needed (the motivation for active clarification).

Usage:
    python sim/analyze_uncertainty.py --results run/research/ambiguous-v3/eval/results.jsonl \
        --dataset run/research/ambiguous-v3 --out run/research/ambiguous-v3/analysis.json
"""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path

import cv2
import numpy as np

CORRECT_SIMILARITY = 0.3  # answer is "correct" if it matches the clean-image answer at least this much


def quality_features(path: Path) -> dict:
    image = cv2.imread(str(path))
    if image is None:
        return {}
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    luminance = gray.astype(np.float32)
    return {
        "sharpness": float(cv2.Laplacian(gray, cv2.CV_64F).var()),
        "brightness": float(luminance.mean()),
        "contrast": float(luminance.std()),
        "dark_ratio": float((luminance < 40).mean()),
    }


def roc_auc(scores: list[float], labels: list[int]) -> float | None:
    """AUC = P(score of a correct sample > score of a wrong sample). None if one class is empty."""
    positives = [s for s, l in zip(scores, labels) if l == 1]
    negatives = [s for s, l in zip(scores, labels) if l == 0]
    if not positives or not negatives:
        return None
    wins = 0.0
    for p in positives:
        for n in negatives:
            if p > n:
                wins += 1
            elif p == n:
                wins += 0.5
    return round(wins / (len(positives) * len(negatives)), 3)


SIGNALS = ["model_confidence", "sharpness", "brightness", "contrast", "dark_ratio"]


def rank_normalize(values: list[float]) -> list[float]:
    """Map values to [0,1] by rank, so signals with different units can be fused."""
    n = len(values)
    if n <= 1:
        return [0.0] * n
    order = sorted(range(n), key=lambda i: values[i])
    out = [0.0] * n
    for rank, index in enumerate(order):
        out[index] = rank / (n - 1)
    return out


def fuse(rows: list[dict]) -> list[float]:
    """A simple equal-weight fusion of the two strongest signals (confidence + sharpness)."""
    conf = rank_normalize([r["model_confidence"] for r in rows])
    sharp = rank_normalize([r["sharpness"] for r in rows])
    return [(c + s) / 2 for c, s in zip(conf, sharp)]


def risk_coverage(scores: list[float], labels: list[int], steps: int = 10) -> list[dict]:
    """Sort by score (high = more trustworthy); report error rate as we accept more samples."""
    pairs = sorted(zip(scores, labels), key=lambda item: -item[0])
    n = len(pairs)
    if n == 0:
        return []
    curve = []
    for step in range(1, steps + 1):
        k = max(1, int(n * step / steps))
        error = 1 - sum(label for _, label in pairs[:k]) / k
        curve.append({"coverage": round(step / steps, 1), "error": round(error, 3)})
    return curve


def summarize(rows: list[dict]) -> dict:
    labels = [1 if r["correct"] else 0 for r in rows]
    out = {}
    for signal in SIGNALS:
        values = [r[signal] for r in rows]
        out[signal] = {
            "auc": roc_auc(values, labels),
            "meanCorrect": round(float(np.mean([v for v, l in zip(values, labels) if l == 1])), 3) if any(labels) else None,
            "meanWrong": round(float(np.mean([v for v, l in zip(values, labels) if l == 0])), 3) if (len(labels) - sum(labels)) else None,
        }
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description="Compare signals for predicting wrong answers under ambiguity.")
    parser.add_argument("--results", required=True, type=Path, help="results.jsonl from eval_clarify_baseline.py")
    parser.add_argument("--dataset", required=True, type=Path, help="Dataset dir (contains images/).")
    parser.add_argument("--out", required=True, type=Path, help="Output analysis JSON.")
    args = parser.parse_args()

    records = [json.loads(line) for line in args.results.read_text(encoding="utf-8").splitlines() if line.strip()]
    rows = []
    for record in records:
        features = quality_features(args.dataset / record["image"])
        if not features:
            continue
        rows.append({
            "id": record["id"],
            "ambiguity": record["ambiguity"][0],
            "model_confidence": record["ambiguous"]["confidence"],
            "similarity": record.get("similarityToClean", 0.0),
            "correct": record.get("similarityToClean", 0.0) >= CORRECT_SIMILARITY,
            **features,
        })

    if not rows:
        raise SystemExit("no usable records")

    by_kind: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        by_kind[row["ambiguity"]].append(row)

    fused = fuse(rows)
    for row, score in zip(rows, fused):
        row["fused"] = score
    labels = [1 if r["correct"] else 0 for r in rows]

    report = {
        "protocol": "uncertainty-signals-v1",
        "samples": len(rows),
        "correctSimilarityThreshold": CORRECT_SIMILARITY,
        "overallAccuracy": round(sum(1 for r in rows if r["correct"]) / len(rows), 3),
        "overall": {**summarize(rows), "fused": {"auc": roc_auc(fused, labels)}},
        "byAmbiguity": {kind: {"n": len(items), **summarize(items)} for kind, items in sorted(by_kind.items())},
        "triggerComparison": {
            "note": "Which signal should decide to clarify? Higher AUC = better at telling correct from wrong.",
            "byModelConfidence": risk_coverage([r["model_confidence"] for r in rows], labels),
            "bySharpness": risk_coverage([r["sharpness"] for r in rows], labels),
            "byFused": risk_coverage(fused, labels),
        },
        "note": "AUC ~0.5 means the signal cannot separate correct from wrong answers. Cheap image features are a developer proxy, not validated reliability.",
    }
    for kind, stats in report["byAmbiguity"].items():
        stats["accuracy"] = round(sum(1 for r in by_kind[kind] if r["correct"]) / len(by_kind[kind]), 3)

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"overallAccuracy": report["overallAccuracy"], "overall": report["overall"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
