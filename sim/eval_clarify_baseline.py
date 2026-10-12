#!/usr/bin/env python3
"""Stage 1 baseline: does the VLM *know* it is unsure when the image is degraded?

See docs/research/clarifying-dialogue.md. Given the dataset produced by
`sim/inject_ambiguity.py`, this asks a fixed question about each ambiguous image
AND about its clean source image, then compares the model's self-reported
confidence. This is the first evidence for hypothesis H1:

    H1: when visual evidence is insufficient, the system can tell it is unsure.

Design choices:
  - Fixed question for every image (so only the image varies).
  - The model must return JSON with an explicit `confidence` and `can_answer` flag,
    so "uncertainty" is measured, not guessed.
  - We cache clean (source) results by path so the same source is only called once.

Output:
  <out>/results.jsonl   one record per ambiguous sample (with its clean counterpart)
  <out>/report.json     per-ambiguity confidence stats vs clean

Usage:
    python sim/eval_clarify_baseline.py --dataset run/research/ambiguous-v1 \
        --out run/research/ambiguous-v1/eval --limit 10
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import time
from collections import defaultdict
from pathlib import Path

DEFAULT_QUESTION = "画面里主要有什么物体？请简要回答。"

PROMPT = """你是一个第一视角视觉助手，服务视障用户。请根据图片回答用户的问题。
如果图片太模糊、被裁切、太暗或被遮挡，导致无法可靠回答，请如实说明，并调低 confidence。
只输出一个 JSON 对象，不要 Markdown：
{"answer": "<你的回答>", "confidence": <0 到 1>, "can_answer": <true 或 false>}
用户的问题：{question}"""


def image_data_uri(path: Path) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(path.read_bytes()).decode("ascii")


def parse_reply(text: str) -> dict:
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
    obj = json.loads(cleaned)
    answer = obj.get("answer")
    if not isinstance(answer, str) or not answer.strip():
        raise ValueError("reply.answer must be a non-empty string")
    confidence = obj.get("confidence")
    confidence = float(confidence) if isinstance(confidence, (int, float)) else 0.5
    confidence = max(0.0, min(1.0, confidence))
    can_answer = obj.get("can_answer")
    can_answer = bool(can_answer) if isinstance(can_answer, bool) else True
    return {"answer": answer.strip(), "confidence": confidence, "can_answer": can_answer}


def char_ngrams(text: str, n: int = 2) -> set:
    """Character n-grams of a (possibly Chinese) string. Used for a cheap answer-similarity score."""
    compact = re.sub(r"\s+", "", text)
    if len(compact) < n:
        return {compact} if compact else set()
    return {compact[i:i + n] for i in range(len(compact) - n + 1)}


def answer_similarity(a: str, b: str) -> float:
    """Jaccard similarity over character 2-grams. 1.0 = same answer, 0.0 = unrelated."""
    ga, gb = char_ngrams(a), char_ngrams(b)
    if not ga or not gb:
        return 0.0
    return round(len(ga & gb) / len(ga | gb), 3)


def ask(client, model: str, path: Path, question: str) -> dict:
    content = [
        {"type": "text", "text": PROMPT.replace("{question}", question)},
        {"type": "image_url", "image_url": {"url": image_data_uri(path)}},
    ]
    started = time.perf_counter()
    response = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": content}],
        temperature=0,
        max_tokens=300,
    )
    elapsed_ms = (time.perf_counter() - started) * 1000
    text = response.choices[0].message.content or ""
    parsed = parse_reply(text)
    parsed["elapsedMs"] = round(elapsed_ms, 1)
    parsed["raw"] = text
    return parsed


def load_manifest(dataset: Path, limit: int) -> list[dict]:
    rows = [json.loads(line) for line in (dataset / "manifest.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    return rows[:limit] if limit > 0 else rows


OVERCONFIDENT_CONF = 0.7   # claiming this much confidence...
OVERCONFIDENT_SIM = 0.3    # ...while the answer barely matches the clean one


def summarize(records: list[dict]) -> dict:
    by_kind: dict[str, list[dict]] = defaultdict(list)
    for row in records:
        for kind in row["ambiguity"]:
            by_kind[kind].append(row)
    stats = {}
    for kind, rows in sorted(by_kind.items()):
        conf = [r["ambiguous"]["confidence"] for r in rows]
        clean = [r["clean"]["confidence"] for r in rows]
        sim = [r.get("similarityToClean", 0.0) for r in rows]
        overconfident = [r for r in rows if r["ambiguous"]["confidence"] >= OVERCONFIDENT_CONF and r.get("similarityToClean", 0.0) < OVERCONFIDENT_SIM]
        stats[kind] = {
            "n": len(rows),
            "ambiguousConfidenceMean": round(sum(conf) / len(conf), 3),
            "cleanConfidenceMean": round(sum(clean) / len(clean), 3),
            "confidenceDrop": round(sum(clean) / len(clean) - sum(conf) / len(conf), 3),
            "similarityToCleanMean": round(sum(sim) / len(sim), 3),
            "overconfidentRate": round(len(overconfident) / len(rows), 3),
            "ambiguousCannotAnswerRate": round(sum(1 for r in rows if not r["ambiguous"]["can_answer"]) / len(rows), 3),
            "cleanCannotAnswerRate": round(sum(1 for r in rows if not r["clean"]["can_answer"]) / len(rows), 3),
        }
    return stats


def risk_coverage(records: list[dict], sim_threshold: float = 0.3) -> list[dict]:
    """Sort answers by confidence; as coverage grows, report the error rate.

    'Correct' here = the degraded-image answer is similar enough to the clean-image answer.
    A well-calibrated model keeps low error even at high coverage; an overconfident one does not.
    """
    labeled = [(r["ambiguous"]["confidence"], 1 if r.get("similarityToClean", 0.0) >= sim_threshold else 0) for r in records]
    labeled.sort(key=lambda item: -item[0])
    n = len(labeled)
    if n == 0:
        return []
    curve = []
    for step in range(1, 11):
        coverage = round(step / 10, 1)
        k = max(1, int(n * coverage))
        subset = labeled[:k]
        error = 1 - sum(correct for _, correct in subset) / len(subset)
        curve.append({"coverage": coverage, "n": len(subset), "error": round(error, 3)})
    return curve


def main() -> None:
    parser = argparse.ArgumentParser(description="Baseline: measure VLM self-reported confidence under injected ambiguity.")
    parser.add_argument("--dataset", required=True, type=Path, help="Directory with manifest.jsonl (from inject_ambiguity.py).")
    parser.add_argument("--out", required=True, type=Path, help="Output directory for results/report.")
    parser.add_argument("--model", default=os.getenv("QWEN_MODEL", "qwen3-vl-plus"))
    parser.add_argument("--question", default=DEFAULT_QUESTION)
    parser.add_argument("--limit", type=int, default=0, help="Max samples (0 = all).")
    args = parser.parse_args()

    if not os.getenv("QWEN_API_KEY") or not os.getenv("QWEN_BASE_URL"):
        raise SystemExit("Missing QWEN_API_KEY / QWEN_BASE_URL environment variables")

    from openai import OpenAI

    client = OpenAI(api_key=os.environ["QWEN_API_KEY"], base_url=os.environ["QWEN_BASE_URL"], timeout=240, max_retries=0)
    rows = load_manifest(args.dataset, args.limit)
    if not rows:
        raise SystemExit("empty dataset")

    args.out.mkdir(parents=True, exist_ok=True)
    results_path = args.out / "results.jsonl"
    clean_cache: dict[str, dict] = {}
    records: list[dict] = []
    with results_path.open("w", encoding="utf-8") as out:
        for index, row in enumerate(rows, 1):
            ambiguous_path = args.dataset / row["image"]
            clean_path = Path(row["source_image"])
            if not clean_path.is_file():
                print(f"[skip] missing source: {clean_path}")
                continue
            ambiguous = ask(client, args.model, ambiguous_path, args.question)
            key = str(clean_path)
            if key not in clean_cache:
                clean_cache[key] = ask(client, args.model, clean_path, args.question)
            record = {
                "id": row["id"],
                "ambiguity": row["ambiguity"],
                "params": row.get("params", {}),
                "image": row["image"],
                "sourceImage": row["source_image"],
                "ambiguous": ambiguous,
                "clean": clean_cache[key],
                "similarityToClean": answer_similarity(ambiguous["answer"], clean_cache[key]["answer"]),
            }
            records.append(record)
            out.write(json.dumps(record, ensure_ascii=False) + "\n")
            print(f"[{index}/{len(rows)}] {row['id']} {row['ambiguity']}: amb_conf={ambiguous['confidence']} clean_conf={clean_cache[key]['confidence']}")

    report = {
        "protocol": "clarify-baseline-v1",
        "model": args.model,
        "question": args.question,
        "samples": len(records),
        "datasetSha256": hashlib.sha256((args.dataset / "manifest.jsonl").read_bytes()).hexdigest(),
        "stats": summarize(records),
        "riskCoverage": risk_coverage(records),
        "note": "Self-reported confidence from a single VLM call per image. Not calibrated probabilities; developer baseline, not blind validation.",
    }
    (args.out / "report.json").write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(report["stats"], ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
