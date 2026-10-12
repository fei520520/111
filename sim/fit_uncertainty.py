#!/usr/bin/env python3
"""Stage 2b: does a *learned* combination of uncertainty signals beat any single one?

Motivation (docs/research/clarifying-dialogue.md, discovery E): under ambiguity no
single offline signal covers all cases, and the equal-weight average of
confidence + sharpness does NOT beat sharpness alone (AUC 0.684 vs 0.701).

That left open whether the *combination rule* or the *feature set* was at fault.
This script answers the former: it fits a regularized logistic regressor on the same
cheap features (no extra API cost) and evaluates it with **leave-one-out cross
validation**, so the reported AUC is not a training-set artifact on a tiny (n=40)
sample.

Honesty notes:
  - The ambiguity *kind* is NEVER used as a feature: at deployment time the system is
    not told what went wrong, so using it would leak the injected label.
  - LOO-CV mitigates but does not remove small-sample optimism. L2 strength is swept
    and all values are reported rather than silently picking the best.

No new dependencies: logistic regression is implemented directly in numpy.

Usage:
    python sim/fit_uncertainty.py --results run/research/ambiguous-v3/eval/results.jsonl \
        --dataset run/research/ambiguous-v3 --out run/research/ambiguous-v3/learned-uncertainty.json
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np

from analyze_uncertainty import CORRECT_SIMILARITY, fuse, quality_features, roc_auc

# Cheap, deployment-legal features (all derived from the image itself or the model's
# own reply). Deliberately excludes the injected ambiguity kind.
FEATURES = ["model_confidence", "sharpness", "brightness", "contrast", "dark_ratio"]

L2_SWEEP = [0.1, 0.5, 1.0, 2.0, 5.0, 10.0]
L2_MAIN = 1.0


def load_rows(results_path: Path, dataset: Path) -> list[dict]:
    rows: list[dict] = []
    for line in results_path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        record = json.loads(line)
        features = quality_features(dataset / record["image"])
        if not features:
            continue
        rows.append({
            "id": record["id"],
            "ambiguity": record["ambiguity"][0],
            "similarity": record.get("similarityToClean", 0.0),
            "correct": record.get("similarityToClean", 0.0) >= CORRECT_SIMILARITY,
            "model_confidence": record["ambiguous"]["confidence"],
            **features,
        })
    return rows


def feature_matrix(rows: list[dict]) -> np.ndarray:
    return np.array([[float(row[name]) for name in FEATURES] for row in rows], dtype=np.float64)


def standardize(train: np.ndarray, other: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """Z-score using train statistics only (no leakage from the held-out row)."""
    mean = train.mean(axis=0)
    std = train.std(axis=0)
    std = np.where(std < 1e-9, 1.0, std)
    return (train - mean) / std, (other - mean) / std


def fit_logreg(x: np.ndarray, y: np.ndarray, l2: float, lr: float = 0.5, epochs: int = 3000) -> tuple[np.ndarray, float]:
    """Plain gradient descent on the L2-regularized log-likelihood (no sklearn)."""
    n, d = x.shape
    w = np.zeros(d)
    b = 0.0
    for _ in range(epochs):
        p = 1.0 / (1.0 + np.exp(-(x @ w + b)))
        w -= lr * (x.T @ (p - y) / n + l2 * w / n)
        b -= lr * float((p - y).mean())
    return w, b


def predict(x: np.ndarray, w: np.ndarray, b: float) -> np.ndarray:
    return 1.0 / (1.0 + np.exp(-(x @ w + b)))


def loo_scores(x: np.ndarray, y: np.ndarray, l2: float) -> np.ndarray:
    """Leave-one-out predictions: each sample scored by a model that never saw it."""
    n = len(y)
    out = np.zeros(n)
    for i in range(n):
        keep = np.ones(n, dtype=bool)
        keep[i] = False
        x_train, x_test = standardize(x[keep], x[i:i + 1])
        w, b = fit_logreg(x_train, y[keep], l2=l2)
        out[i] = float(predict(x_test, w, b)[0])
    return out


def paired_bootstrap_auc_diff(scores_a: np.ndarray, scores_b: np.ndarray, labels: np.ndarray,
                              rounds: int = 2000, seed: int = 0) -> dict:
    """Paired bootstrap over samples: how often does A beat B, and by how much?

    The same resampled subset is scored by both signals, so the resulting interval
    is attached to the *difference* rather than to either AUC alone. With n=40 this
    is the difference between "learned fusion looks better" and "it reliably is".
    """
    rng = np.random.default_rng(seed)
    n = len(labels)
    diffs: list[float] = []
    for _ in range(rounds):
        index = rng.integers(0, n, n)
        y = labels[index]
        if y.min() == y.max():  # a degenerate resample has no AUC
            continue
        auc_a = roc_auc(scores_a[index].tolist(), y.tolist())
        auc_b = roc_auc(scores_b[index].tolist(), y.tolist())
        if auc_a is None or auc_b is None:
            continue
        diffs.append(auc_a - auc_b)
    if not diffs:
        return {"rounds": 0}
    arr = np.array(diffs)
    return {
        "rounds": len(arr),
        "meanDiff": round(float(arr.mean()), 3),
        "ci95": [round(float(np.percentile(arr, 2.5)), 3), round(float(np.percentile(arr, 97.5)), 3)],
        "probGreaterThanZero": round(float((arr > 0).mean()), 3),
        "note": "Paired bootstrap over samples; a CI that spans 0 means the gap is not established at this n.",
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Learned fusion of uncertainty signals (LOO-CV).")
    parser.add_argument("--results", required=True, type=Path, help="results.jsonl from eval_clarify_baseline.py")
    parser.add_argument("--dataset", required=True, type=Path, help="Dataset dir (contains images/).")
    parser.add_argument("--out", required=True, type=Path, help="Output JSON.")
    args = parser.parse_args()

    rows = load_rows(args.results, args.dataset)
    if len(rows) < 8:
        raise SystemExit(f"too few usable rows ({len(rows)}) for a meaningful comparison")

    labels = np.array([1 if row["correct"] else 0 for row in rows], dtype=np.float64)
    x = feature_matrix(rows)

    # --- baselines: every single signal, then the existing equal-weight fusion ---
    baselines: dict[str, dict] = {}
    for name in FEATURES:
        values = [float(row[name]) for row in rows]
        baselines[name] = {"auc": roc_auc(values, labels.tolist())}
    equal_weight = fuse(rows)
    baselines["equalWeightFuse(conf+sharp)"] = {"auc": roc_auc(equal_weight, labels.tolist())}
    best_single = max(
        (name for name in FEATURES),
        key=lambda name: baselines[name]["auc"] if baselines[name]["auc"] is not None else -1,
    )

    # --- learned fusion, LOO-CV, with a regularization sweep for transparency ---
    sweep = {}
    loo_main = loo_scores(x, labels, L2_MAIN)
    for l2 in L2_SWEEP:
        scores = loo_main if l2 == L2_MAIN else loo_scores(x, labels, l2)
        sweep[str(l2)] = roc_auc(scores.tolist(), labels.tolist())

    x_all, _ = standardize(x, x)
    w_all, b_all = fit_logreg(x_all, labels, l2=L2_MAIN)
    weights = {name: round(float(weight), 3) for name, weight in zip(FEATURES, w_all)}

    learned_auc = sweep[str(L2_MAIN)]
    best_single_auc = baselines[best_single]["auc"]
    ties = learned_auc is not None and best_single_auc is not None and abs(learned_auc - best_single_auc) < 0.02

    best_single_scores = np.array([float(row[best_single]) for row in rows], dtype=np.float64)
    bootstrap = paired_bootstrap_auc_diff(loo_main, best_single_scores, labels)
    established = bootstrap.get("ci95", [None, None])[0] is not None and bootstrap["ci95"][0] > 0

    report = {
        "protocol": "learned-uncertainty-v1",
        "samples": len(rows),
        "positiveRate": round(float(labels.mean()), 3),
        "correctSimilarityThreshold": CORRECT_SIMILARITY,
        "features": FEATURES,
        "baselines": baselines,
        "learnedFusion": {
            "method": "L2-regularized logistic regression, leave-one-out CV",
            "l2": L2_MAIN,
            "looAuc": learned_auc,
            "l2SweepLooAuc": sweep,
            "standardizedWeights": weights,
            "intercept": round(float(b_all), 3),
        },
        "comparison": {
            "bestSingleSignal": best_single,
            "bestSingleAuc": best_single_auc,
            "equalWeightAuc": baselines["equalWeightFuse(conf+sharp)"]["auc"],
            "learnedAuc": learned_auc,
            "learnedBeatsBestSingle": bool(
                learned_auc is not None and best_single_auc is not None and learned_auc > best_single_auc and not ties
            ),
            "verdict": (
                "ties best single signal (within 0.02)" if ties else
                "learned fusion wins" if learned_auc is not None and best_single_auc is not None and learned_auc > best_single_auc else
                "learned fusion does NOT beat the best single signal"
            ),
            "pairedBootstrap": bootstrap,
            "gapEstablished": established,
        },
        "note": (
            f"n={len(rows)}; the answer-similarity label is a coarse 2-gram proxy and the gap interval is a "
            "paired bootstrap over samples, so this is a developer baseline, not a validated calibration "
            "result. Weights are on z-scored features; correlated features make individual weights unstable."
        ),
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "samples": report["samples"],
        "baselines": {k: v["auc"] for k, v in baselines.items()},
        "learnedLooAuc": learned_auc,
        "verdict": report["comparison"]["verdict"],
    }, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
