#!/usr/bin/env python3
"""Build *referential* ambiguity tasks: the image is fine, the request is not.

Stage 3 companion (docs/research/clarifying-dialogue.md). The existing dataset injects
only *image-quality* ambiguity (blur / crop / occlude / dark / downscale), for which
asking the user to change the view (ask_view) is the correct repair. A different and
equally real failure mode is a vague reference ("帮我拿那个东西") on a perfectly clear
image: here changing the view does NOT help, and the correct repair is a short spoken
question (ask_verbal).

Why this file exists: without a second kind of task, the observed "the model always
picks ask_view" (n=6) is confounded by the dataset rather than a property of the model.
So this builds the missing half of the task set, with a *rule-based* expected action
(documented, not hand-labelled) so the comparison is at least falsifiable.

Output layout:
    <out>/images/<id>.jpg     the (unmodified) clear frame
    <out>/manifest.jsonl      {id, image, ambiguity:["referential"], question,
                               expectedAction:"ask_verbal", sourceImage, sourceSharpness}

Usage:
    python sim/build_referential_tasks.py --input run/experiments \
        --output run/research/referential-v1 --limit 40
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

import cv2

from inject_ambiguity import collect_frames, sharpness

# Vague requests an assistant cannot resolve from the image alone: the referent of
# "那个" is under-specified, so the right move is to ask, not to look harder.
QUESTIONS = [
    "帮我拿一下那个东西。",
    "把那个递给我。",
    "那边那个是什么？",
    "我前面那个能拿给我吗？",
]


def main() -> None:
    parser = argparse.ArgumentParser(description="Build referential-ambiguity tasks from clear frames.")
    parser.add_argument("--input", required=True, type=Path, help="Directory containing clear frames.")
    parser.add_argument("--output", required=True, type=Path, help="Output dataset directory.")
    parser.add_argument("--limit", type=int, default=40, help="Max number of source frames (0 = all).")
    parser.add_argument("--min-sharpness", type=float, default=100.0, help="Skip source frames blurrier than this.")
    args = parser.parse_args()

    frames = collect_frames(args.input, 0)
    if not frames:
        raise SystemExit(f"no frames found under {args.input}")

    images_dir = args.output / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    manifest_path = args.output / "manifest.jsonl"
    count = 0
    with manifest_path.open("w", encoding="utf-8") as manifest:
        for frame_path in frames:
            if args.limit > 0 and count >= args.limit:
                break
            image = cv2.imread(str(frame_path))
            if image is None:
                continue
            focus = sharpness(image)
            if focus < args.min_sharpness:
                continue
            sample_id = f"ref-{count:04d}"
            rel_image = f"images/{sample_id}.jpg"
            shutil.copyfile(frame_path, args.output / rel_image)
            manifest.write(json.dumps({
                "id": sample_id,
                "image": rel_image,
                "sourceImage": str(frame_path).replace("\\", "/"),
                "ambiguity": ["referential"],
                "question": QUESTIONS[count % len(QUESTIONS)],
                "expectedAction": "ask_verbal",
                "sourceSharpness": round(focus, 1),
            }, ensure_ascii=False) + "\n")
            count += 1

    print(f"[done] {count} referential tasks -> {args.output}")
    print(f"[done] manifest: {manifest_path}")


if __name__ == "__main__":
    main()
