#!/usr/bin/env python3
"""Inject controllable ambiguities into frames to build a clarifying-dialogue dataset.

This is stage 1 of the "clarifying visual dialogue" research line (see
docs/research/clarifying-dialogue.md). It takes *clean* frames and produces
degraded variants (blur / crop / occlude / dark / downscale), each with metadata
so the evaluation knows exactly what ambiguity was introduced.

We do NOT need to re-run the simulator: any directory of *.jpg frames works
(e.g. run/experiments/<session>/live/ or run/sim/<episode>/frames/).

Usage:
    python sim/inject_ambiguity.py --input run/experiments/<session>/live \
        --output run/research/ambiguous-v1 --limit 10

Output layout:
    <output>/images/<id>.jpg     degraded image
    <output>/manifest.jsonl      one JSON object per produced sample
"""

from __future__ import annotations

import argparse
import json
import random
from pathlib import Path

import cv2
import numpy as np

# Ambiguity kinds we can inject. Each returns (image, params).
DEFAULT_TYPES = ["blur", "crop", "occlude", "dark", "downscale"]


def apply_blur(image: np.ndarray, rng: random.Random) -> tuple[np.ndarray, dict]:
    """Motion/focus blur -> the assistant cannot read fine detail."""
    sigma = rng.choice([4, 6, 9, 12])
    kernel = int(sigma) * 2 + 1
    return cv2.GaussianBlur(image, (kernel, kernel), sigma), {"sigma": sigma}


def apply_crop(image: np.ndarray, rng: random.Random) -> tuple[np.ndarray, dict]:
    """Too narrow a view -> the target is partly/fully out of frame."""
    height, width = image.shape[:2]
    scale = rng.choice([0.45, 0.55, 0.65])
    crop_w, crop_h = int(width * scale), int(height * scale)
    x = rng.randint(0, max(0, width - crop_w))
    y = rng.randint(0, max(0, height - crop_h))
    cropped = image[y:y + crop_h, x:x + crop_w]
    return cv2.resize(cropped, (width, height), interpolation=cv2.INTER_LINEAR), {"scale": scale, "x": x, "y": y}


def apply_occlude(image: np.ndarray, rng: random.Random) -> tuple[np.ndarray, dict]:
    """A blocker hides part of the scene (e.g. a hand, a wall)."""
    height, width = image.shape[:2]
    box_w = int(width * rng.choice([0.3, 0.4, 0.5]))
    box_h = int(height * rng.choice([0.3, 0.4, 0.5]))
    x = rng.randint(0, max(0, width - box_w))
    y = rng.randint(0, max(0, height - box_h))
    out = image.copy()
    color = int(rng.choice([30, 90, 160]))
    out[y:y + box_h, x:x + box_w] = color
    return out, {"x": x, "y": y, "w": box_w, "h": box_h}


def apply_dark(image: np.ndarray, rng: random.Random) -> tuple[np.ndarray, dict]:
    """Under-exposure -> low contrast, detail lost in shadow."""
    factor = rng.choice([0.25, 0.35, 0.45])
    return np.clip(image.astype(np.float32) * factor, 0, 255).astype(np.uint8), {"factor": factor}


def apply_downscale(image: np.ndarray, rng: random.Random) -> tuple[np.ndarray, dict]:
    """Low resolution / far away -> too few pixels to identify objects."""
    height, width = image.shape[:2]
    factor = rng.choice([0.12, 0.18, 0.25])
    small = cv2.resize(image, (max(1, int(width * factor)), max(1, int(height * factor))), interpolation=cv2.INTER_AREA)
    return cv2.resize(small, (width, height), interpolation=cv2.INTER_NEAREST), {"factor": factor}


INJECTORS = {
    "blur": apply_blur,
    "crop": apply_crop,
    "occlude": apply_occlude,
    "dark": apply_dark,
    "downscale": apply_downscale,
}


def sharpness(image: np.ndarray) -> float:
    """Variance of Laplacian: a standard, cheap focus measure. Higher = sharper."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def collect_frames(input_dir: Path, limit: int) -> list[Path]:
    frames = sorted(p for p in input_dir.rglob("*") if p.suffix.lower() in {".jpg", ".jpeg", ".png"})
    return frames[:limit] if limit > 0 else frames


def main() -> None:
    parser = argparse.ArgumentParser(description="Inject controllable ambiguities into frames.")
    parser.add_argument("--input", required=True, help="Directory containing clean frames (*.jpg/*.png).")
    parser.add_argument("--output", required=True, help="Output directory for the dataset.")
    parser.add_argument("--types", default=",".join(DEFAULT_TYPES), help="Comma-separated ambiguity kinds.")
    parser.add_argument("--limit", type=int, default=0, help="Max number of source frames (0 = all).")
    parser.add_argument("--seed", type=int, default=0, help="Random seed for reproducibility.")
    parser.add_argument("--min-sharpness", type=float, default=100.0,
                        help="Skip source frames blurrier than this Laplacian-variance value (keep clean base images only).")
    args = parser.parse_args()

    input_dir = Path(args.input)
    if not input_dir.is_dir():
        raise SystemExit(f"input directory not found: {input_dir}")
    types = [t.strip() for t in args.types.split(",") if t.strip()]
    unknown = [t for t in types if t not in INJECTORS]
    if unknown:
        raise SystemExit(f"unknown ambiguity types: {unknown}; known = {list(INJECTORS)}")

    output_dir = Path(args.output)
    images_dir = output_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    frames = collect_frames(input_dir, 0)
    if not frames:
        raise SystemExit(f"no frames found under {input_dir}")

    rng = random.Random(args.seed)
    manifest_path = output_dir / "manifest.jsonl"
    count = 0
    with manifest_path.open("w", encoding="utf-8") as manifest:
        used_sources = 0
        for frame_path in frames:
            if args.limit > 0 and used_sources >= args.limit:
                break
            image = cv2.imread(str(frame_path))
            if image is None:
                print(f"[skip] cannot read {frame_path}")
                continue
            focus = sharpness(image)
            if focus < args.min_sharpness:
                continue
            used_sources += 1
            for kind in types:
                degraded, params = INJECTORS[kind](image, rng)
                sample_id = f"amb-{count:04d}"
                rel_image = f"images/{sample_id}.jpg"
                cv2.imwrite(str(output_dir / rel_image), degraded)
                manifest.write(json.dumps({
                    "id": sample_id,
                    "source_image": str(frame_path).replace("\\", "/"),
                    "image": rel_image,
                    "ambiguity": [kind],
                    "params": params,
                    "sourceSharpness": round(focus, 1),
                    "seed": args.seed,
                }, ensure_ascii=False) + "\n")
                count += 1

    print(f"[done] {count} samples from {len(frames)} frames -> {output_dir}")
    print(f"[done] manifest: {manifest_path}")


if __name__ == "__main__":
    main()
