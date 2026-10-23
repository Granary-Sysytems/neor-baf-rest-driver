#!/usr/bin/env python3
"""Document auto-crop + perspective deskew (OpenCV).

Multi-strategy document quad detection with low-light normalization,
candidate scoring, and no-crop fallback when confidence is low.

Prints a JSON meta line to stdout (applied, method, confidence, reason, …).
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import dataclass
from typing import Optional

import cv2
import numpy as np

# Reject tiny / garbage quads (old bug: fell back to largest even at ~0.3% area).
MIN_AREA_RATIO = 0.18
MAX_AREA_RATIO = 0.96
MIN_CONFIDENCE = 0.42
MIN_ASPECT = 0.35  # short/long
MAX_ASPECT = 2.85
MIN_SOLIDITY = 0.78


def order_points(pts: np.ndarray) -> np.ndarray:
    rect = np.zeros((4, 2), dtype="float32")
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]  # tl
    rect[2] = pts[np.argmax(s)]  # br
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]  # tr
    rect[3] = pts[np.argmax(diff)]  # bl
    return rect


def quad_area(pts: np.ndarray) -> float:
    return float(cv2.contourArea(pts.reshape(4, 1, 2)))


def edge_lengths(rect: np.ndarray) -> tuple[float, float, float, float]:
    (tl, tr, br, bl) = rect
    return (
        float(np.linalg.norm(tr - tl)),
        float(np.linalg.norm(br - tr)),
        float(np.linalg.norm(bl - br)),
        float(np.linalg.norm(tl - bl)),
    )


def aspect_from_rect(rect: np.ndarray) -> float:
    top, right, bottom, left = edge_lengths(rect)
    w = max((top + bottom) * 0.5, 1.0)
    h = max((left + right) * 0.5, 1.0)
    return w / h


def touches_frame_edges(pts: np.ndarray, w: int, h: int, margin: float = 0.015) -> int:
    """How many of the four sides of the image the quad hugs."""
    mx, my = w * margin, h * margin
    xs, ys = pts[:, 0], pts[:, 1]
    sides = 0
    if float(xs.min()) <= mx:
        sides += 1
    if float(xs.max()) >= w - 1 - mx:
        sides += 1
    if float(ys.min()) <= my:
        sides += 1
    if float(ys.max()) >= h - 1 - my:
        sides += 1
    return sides


def normalize_for_detect(bgr: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Return gray, CLAHE gray, and a lightly gamma-lifted gray for low light."""
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    norm = clahe.apply(gray)
    # Mild gamma lift (mean-adaptive): dark frames get stronger boost
    mean = float(norm.mean()) + 1e-6
    gamma = 1.0 if mean >= 90 else max(0.45, mean / 90.0)
    table = np.array(
        [((i / 255.0) ** gamma) * 255 for i in range(256)], dtype=np.uint8
    )
    lifted = cv2.LUT(norm, table)
    return gray, norm, lifted


def _quads_from_binary(mask: np.ndarray, scale: float) -> list[np.ndarray]:
    cnts, _ = cv2.findContours(mask, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    cnts = sorted(cnts, key=cv2.contourArea, reverse=True)[:40]
    quads: list[np.ndarray] = []
    for c in cnts:
        peri = cv2.arcLength(c, True)
        if peri < 40:
            continue
        for eps in (0.02, 0.025, 0.03, 0.035):
            approx = cv2.approxPolyDP(c, eps * peri, True)
            if len(approx) == 4 and cv2.isContourConvex(approx):
                pts = approx.reshape(4, 2).astype("float32")
                if scale != 1.0:
                    pts = pts / scale
                quads.append(pts)
                break
    return quads


def _min_area_rect_quad(contour: np.ndarray, scale: float) -> Optional[np.ndarray]:
    if contour is None or len(contour) < 4:
        return None
    rect = cv2.minAreaRect(contour)
    box = cv2.boxPoints(rect).astype("float32")
    if scale != 1.0:
        box = box / scale
    return box


@dataclass
class Candidate:
    pts: np.ndarray
    method: str
    score: float
    area_ratio: float
    aspect: float
    solidity: float
    edge_touches: int


def score_quad(
    pts: np.ndarray,
    img_w: int,
    img_h: int,
    method: str,
    page_hint: Optional[np.ndarray] = None,
) -> Optional[Candidate]:
    if not cv2.isContourConvex(pts.reshape(4, 1, 2)):
        return None
    area = quad_area(pts)
    img_area = float(img_w * img_h)
    ratio = area / img_area
    if ratio < MIN_AREA_RATIO or ratio > MAX_AREA_RATIO:
        return None

    ordered = order_points(pts)
    aspect = aspect_from_rect(ordered)
    if aspect < MIN_ASPECT or aspect > MAX_ASPECT:
        return None

    # Thinness via min edge vs max edge
    lengths = edge_lengths(ordered)
    if min(lengths) / max(lengths) < 0.22:
        return None

    hull = cv2.convexHull(ordered.reshape(4, 1, 2))
    hull_area = float(cv2.contourArea(hull)) + 1e-6
    solidity = area / hull_area
    if solidity < MIN_SOLIDITY:
        return None

    touches = touches_frame_edges(ordered, img_w, img_h)
    # Full-bleed frame outline is usually wrong for a document on a mat
    if touches >= 4 and ratio > 0.9:
        return None

    score = ratio * 0.55
    # Prefer document-like aspects (open book ~0.6–1.4, single page ~0.7)
    if 0.55 <= aspect <= 1.55:
        score += 0.18
    elif 0.4 <= aspect <= 2.2:
        score += 0.08

    score += solidity * 0.12
    if touches <= 1:
        score += 0.08
    elif touches >= 3:
        score -= 0.12

    # Bright-page hint: prefer quads whose interior is brighter than exterior
    if page_hint is not None:
        mask = np.zeros(page_hint.shape, dtype=np.uint8)
        cv2.fillConvexPoly(mask, ordered.astype(np.int32), 255)
        inside = page_hint[mask > 0]
        outside = page_hint[mask == 0]
        if inside.size and outside.size:
            delta = float(inside.mean()) - float(outside.mean())
            score += max(-0.1, min(0.22, delta / 80.0))

    # Mild method priors
    if method.startswith("sat") or method.startswith("otsu"):
        score += 0.03
    if method.startswith("minrect"):
        score -= 0.04

    return Candidate(
        pts=ordered,
        method=method,
        score=float(score),
        area_ratio=float(ratio),
        aspect=float(aspect),
        solidity=float(solidity),
        edge_touches=touches,
    )


def gather_masks(lifted: np.ndarray, bgr_small: np.ndarray) -> list[tuple[str, np.ndarray]]:
    masks: list[tuple[str, np.ndarray]] = []
    blurred = cv2.GaussianBlur(lifted, (5, 5), 0)

    for lo, hi, tag in ((30, 100, "canny_lo"), (50, 150, "canny_mid"), (80, 200, "canny_hi")):
        edges = cv2.Canny(blurred, lo, hi)
        edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=2)
        edges = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8), iterations=2)
        masks.append((tag, edges))

    thr = cv2.adaptiveThreshold(
        blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 5
    )
    thr = cv2.bitwise_not(thr)
    thr = cv2.morphologyEx(thr, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8), iterations=2)
    masks.append(("adaptive", thr))

    _, otsu = cv2.threshold(blurred, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    # Document pages are usually brighter → keep bright component
    if float(otsu.mean()) > 127:
        otsu = cv2.bitwise_not(otsu)
    otsu = cv2.morphologyEx(otsu, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8), iterations=2)
    otsu = cv2.morphologyEx(otsu, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8), iterations=1)
    masks.append(("otsu", otsu))

    hsv = cv2.cvtColor(bgr_small, cv2.COLOR_BGR2HSV)
    # Low-sat bright-ish paper vs dark mat
    sat = hsv[:, :, 1]
    val = hsv[:, :, 2]
    paper = ((sat < 70) & (val > max(40, int(np.percentile(val, 35))))).astype(np.uint8) * 255
    paper = cv2.morphologyEx(paper, cv2.MORPH_CLOSE, np.ones((11, 11), np.uint8), iterations=2)
    paper = cv2.morphologyEx(paper, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8), iterations=1)
    masks.append(("sat_paper", paper))

    return masks


def find_document_quad(
    image: np.ndarray,
    debug_dir: Optional[str] = None,
) -> tuple[Optional[np.ndarray], dict]:
    h, w = image.shape[:2]
    scale = 1000.0 / max(h, w) if max(h, w) > 1000 else 1.0
    small = (
        cv2.resize(image, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
        if scale != 1.0
        else image
    )
    gray, norm, lifted = normalize_for_detect(small)
    page_hint = (
        cv2.resize(lifted, (w, h), interpolation=cv2.INTER_LINEAR) if scale != 1.0 else lifted
    )

    if debug_dir:
        import os

        os.makedirs(debug_dir, exist_ok=True)
        cv2.imwrite(f"{debug_dir}/gray.jpg", gray)
        cv2.imwrite(f"{debug_dir}/clahe.jpg", norm)
        cv2.imwrite(f"{debug_dir}/lifted.jpg", lifted)

    candidates: list[Candidate] = []
    masks = gather_masks(lifted, small)
    for name, mask in masks:
        if debug_dir:
            cv2.imwrite(f"{debug_dir}/mask_{name}.jpg", mask)
        for pts in _quads_from_binary(mask, scale):
            c = score_quad(pts, w, h, name, page_hint)
            if c:
                candidates.append(c)

        # minAreaRect fallback on largest contour of this mask
        cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        if cnts:
            biggest = max(cnts, key=cv2.contourArea)
            box = _min_area_rect_quad(biggest, scale)
            if box is not None:
                c = score_quad(box, w, h, f"minrect_{name}", page_hint)
                if c:
                    candidates.append(c)

    if not candidates:
        return None, {
            "reason": "no_plausible_quad",
            "confidence": 0.0,
            "method": "none",
            "candidateCount": 0,
        }

    candidates.sort(key=lambda c: c.score, reverse=True)
    best = candidates[0]

    if debug_dir:
        vis = image.copy()
        for i, c in enumerate(candidates[:8]):
            color = (0, 255, 0) if i == 0 else (0, 165, 255)
            cv2.polylines(vis, [c.pts.astype(np.int32)], True, color, 2 if i else 4)
        cv2.imwrite(f"{debug_dir}/candidates.jpg", vis)

    if best.score < MIN_CONFIDENCE:
        return None, {
            "reason": "low_confidence",
            "confidence": round(best.score, 4),
            "method": best.method,
            "areaRatio": round(best.area_ratio, 4),
            "aspect": round(best.aspect, 4),
            "candidateCount": len(candidates),
        }

    return best.pts, {
        "reason": "ok",
        "confidence": round(best.score, 4),
        "method": best.method,
        "areaRatio": round(best.area_ratio, 4),
        "aspect": round(best.aspect, 4),
        "solidity": round(best.solidity, 4),
        "edgeTouches": best.edge_touches,
        "candidateCount": len(candidates),
    }


def warp_document(image: np.ndarray, rect: np.ndarray) -> np.ndarray:
    (tl, tr, br, bl) = rect
    width_a = np.linalg.norm(br - bl)
    width_b = np.linalg.norm(tr - tl)
    max_w = max(int(width_a), int(width_b), 1)
    height_a = np.linalg.norm(tr - br)
    height_b = np.linalg.norm(tl - bl)
    max_h = max(int(height_a), int(height_b), 1)
    # Keep a sensible orientation: if warped would be very wide short strip, swap
    if max_w > 0 and max_h / max_w < 0.35 and max_w > max_h:
        # likely wrong corner order for a tall document — rotate assignment
        rect = order_points(np.array([tl, bl, br, tr], dtype="float32"))
        (tl, tr, br, bl) = rect
        width_a = np.linalg.norm(br - bl)
        width_b = np.linalg.norm(tr - tl)
        max_w = max(int(width_a), int(width_b), 1)
        height_a = np.linalg.norm(tr - br)
        height_b = np.linalg.norm(tl - bl)
        max_h = max(int(height_a), int(height_b), 1)
    dst = np.array(
        [[0, 0], [max_w - 1, 0], [max_w - 1, max_h - 1], [0, max_h - 1]],
        dtype="float32",
    )
    m = cv2.getPerspectiveTransform(rect, dst)
    return cv2.warpPerspective(image, m, (max_w, max_h))


def auto_level(image: np.ndarray) -> np.ndarray:
    """Optional mild luminance stretch (output only; not used for geometry)."""
    lab = cv2.cvtColor(image, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    l2 = clahe.apply(l)
    return cv2.cvtColor(cv2.merge([l2, a, b]), cv2.COLOR_LAB2BGR)


def process(
    path_in: str,
    path_out: str,
    auto_crop: bool,
    deskew: bool,
    auto_level_out: bool = False,
    debug_dir: Optional[str] = None,
) -> dict:
    image = cv2.imread(path_in, cv2.IMREAD_COLOR)
    if image is None:
        return {
            "ok": False,
            "error": f"failed to read image: {path_in}",
            "applied": False,
            "confidence": 0.0,
            "reason": "read_failed",
        }

    src_h, src_w = image.shape[:2]
    applied = False
    method = "none"
    reason = "skipped"
    confidence = 0.0
    detect_meta: dict = {}
    out = image

    if auto_crop or deskew:
        quad, detect_meta = find_document_quad(image, debug_dir=debug_dir)
        confidence = float(detect_meta.get("confidence") or 0.0)
        reason = str(detect_meta.get("reason") or "unknown")
        if quad is not None:
            out = warp_document(image, quad)
            applied = True
            method = f"perspective_quad:{detect_meta.get('method', 'unknown')}"
            reason = "ok"
        else:
            method = "no_crop"
            # keep original

    if auto_level_out:
        out = auto_level(out)
        method = f"{method}+auto_level" if applied else "auto_level_only"

    ext = path_out.lower().rsplit(".", 1)[-1]
    params: list[int] = []
    if ext in ("jpg", "jpeg"):
        params = [int(cv2.IMWRITE_JPEG_QUALITY), 92]
    ok = cv2.imwrite(path_out, out, params)
    out_h, out_w = out.shape[:2]
    return {
        "ok": bool(ok),
        "applied": applied,
        "method": method,
        "confidence": round(confidence, 4),
        "reason": reason,
        "sourceWidth": src_w,
        "sourceHeight": src_h,
        "width": out_w,
        "height": out_h,
        "autoCrop": auto_crop,
        "deskew": deskew,
        "autoLevel": auto_level_out,
        "detect": detect_meta,
    }


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--auto-crop", action="store_true")
    p.add_argument("--deskew", action="store_true")
    p.add_argument("--auto-level", action="store_true")
    p.add_argument("--debug-dir", default=None)
    args = p.parse_args()
    auto = args.auto_crop or args.deskew
    deskew = args.deskew or args.auto_crop
    meta = process(
        args.input,
        args.output,
        auto,
        deskew,
        auto_level_out=args.auto_level,
        debug_dir=args.debug_dir,
    )
    print(json.dumps(meta))
    return 0 if meta.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
