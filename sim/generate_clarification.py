#!/usr/bin/env python3
"""Stage 3: generate the clarification the assistant should ask.

Given an image the system is unsure about, produce ONE actionable clarification:
  - ask_view   : ask the blind user to change the view (e.g. "把手机向左转一点")
  - ask_verbal : ask a short yes/no or choice question (e.g. "是桌上那个吗")

This is the "what to ask" half of the active-clarification loop (the "when" half is
sim/eval_clarify_baseline.py + sim/simulate_clarify_policy.py).

We also run a cheap *actionability* check on the generated speech: does it contain a
direction word (for ask_view) and is it short enough to be said aloud? This is a
developer proxy, not a human usability study.

Usage:
    python sim/generate_clarification.py --dataset run/research/ambiguous-v3 \
        --out run/research/ambiguous-v3/clarify --limit 6
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
from pathlib import Path

DEFAULT_QUESTION = "画面里主要有什么物体？请简要回答。"

PROMPT = """你是视障用户的第一视角视觉助手。当前画面不足以可靠回答用户的问题。
请生成**一句**澄清请求，让用户帮你获得更好的信息。二选一：
- ask_view：请求改变视角，例如"请把手机向左转一点，对准前方"；
- ask_verbal：问一个是非或二选一的问题，例如"是桌子上那个吗？"。
要求：一句话、口语化、盲人可直接执行；不要描述你看到的画面。
只输出 JSON：{"action": "ask_view" 或 "ask_verbal", "speech": "<一句话>"}
用户原本的问题：{question}"""

DIRECTION_WORDS = ["左", "右", "上", "下", "前", "后", "靠近", "转", "退", "抬", "低", "对准"]


def image_data_uri(path: Path) -> str:
    return "data:image/jpeg;base64," + base64.b64encode(path.read_bytes()).decode("ascii")


def parse_reply(text: str) -> dict:
    cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip())
    obj = json.loads(cleaned)
    action = obj.get("action")
    speech = obj.get("speech")
    if action not in {"ask_view", "ask_verbal"}:
        raise ValueError("action must be ask_view or ask_verbal")
    if not isinstance(speech, str) or not speech.strip():
        raise ValueError("speech must be a non-empty string")
    return {"action": action, "speech": speech.strip()}


def actionability(clarification: dict) -> dict:
    speech = clarification["speech"]
    return {
        "length": len(speech),
        "shortEnough": len(speech) <= 30,
        "hasDirectionWord": any(word in speech for word in DIRECTION_WORDS),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate one clarification for an ambiguous image.")
    parser.add_argument("--dataset", required=True, type=Path)
    parser.add_argument("--out", required=True, type=Path)
    parser.add_argument("--model", default="qwen3-vl-plus", help="Pinned for reproducibility with the n=250 baseline; pass --model explicitly to run another model.")
    parser.add_argument("--question", default=DEFAULT_QUESTION)
    parser.add_argument("--expected-action", default=None, choices=["ask_view", "ask_verbal"],
                        help="Expected action to score against when the manifest row does not carry one.")
    parser.add_argument("--limit", type=int, default=6)
    args = parser.parse_args()

    if not os.getenv("QWEN_API_KEY") or not os.getenv("QWEN_BASE_URL"):
        raise SystemExit("Missing QWEN_API_KEY / QWEN_BASE_URL")
    from openai import OpenAI

    client = OpenAI(api_key=os.environ["QWEN_API_KEY"], base_url=os.environ["QWEN_BASE_URL"], timeout=240, max_retries=0)
    rows = [json.loads(line) for line in (args.dataset / "manifest.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()][: args.limit]
    if not rows:
        raise SystemExit("empty dataset")

    args.out.mkdir(parents=True, exist_ok=True)
    results_path = args.out / "clarifications.jsonl"
    records = []
    with results_path.open("w", encoding="utf-8") as out:
        for row in rows:
            # A manifest row may carry its own question and the action a correct system
            # should choose. Using them lets one dataset mix *image-quality* ambiguity
            # (where changing the view is the fix) with *referential* ambiguity (where a
            # short spoken question is the fix) instead of assuming a single answer.
            question = row.get("question") or args.question
            expected = row.get("expectedAction") or args.expected_action
            content = [
                {"type": "text", "text": PROMPT.replace("{question}", question)},
                {"type": "image_url", "image_url": {"url": image_data_uri(args.dataset / row["image"])}},
            ]
            response = client.chat.completions.create(model=args.model, messages=[{"role": "user", "content": content}], temperature=0, max_tokens=200)
            text = response.choices[0].message.content or ""
            clarification = parse_reply(text)
            record = {"id": row["id"], "ambiguity": row["ambiguity"], "image": row["image"], "question": question,
                      "expectedAction": expected, "actionMatches": (expected is None or clarification["action"] == expected),
                      "clarification": clarification, "actionability": actionability(clarification), "raw": text}
            records.append(record)
            out.write(json.dumps(record, ensure_ascii=False) + "\n")
            mark = "" if expected is None else (" OK" if record["actionMatches"] else f" != expected {expected}")
            print(f"[{row['id']}] {clarification['action']}: {clarification['speech']}{mark}")

    with_expected = [r for r in records if r["expectedAction"] is not None]
    by_expected = {}
    for action in sorted({r["expectedAction"] for r in with_expected}):
        subset = [r for r in with_expected if r["expectedAction"] == action]
        by_expected[action] = {
            "n": len(subset),
            "actionMatchRate": round(sum(1 for r in subset if r["actionMatches"]) / len(subset), 3),
        }

    # Distinct-speech rate: how many clarifications are textually unique. Low values mean
    # the model repeats one canned sentence, which is the "lack of diversity" symptom.
    speeches = [r["clarification"]["speech"] for r in records]
    summary = {
        "protocol": "clarification-generation-v2",
        "model": args.model,
        "samples": len(records),
        "askViewRate": round(sum(1 for r in records if r["clarification"]["action"] == "ask_view") / len(records), 3),
        "shortEnoughRate": round(sum(1 for r in records if r["actionability"]["shortEnough"]) / len(records), 3),
        "hasDirectionWordRate": round(sum(1 for r in records if r["actionability"]["hasDirectionWord"]) / len(records), 3),
        "distinctSpeechRate": round(len(set(speeches)) / len(speeches), 3),
        "actionMatchRate": (round(sum(1 for r in with_expected if r["actionMatches"]) / len(with_expected), 3) if with_expected else None),
        "actionMatchByExpected": by_expected,
        "note": "Developer proxy for actionability, not a human usability study.",
    }
    (args.out / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(summary, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
