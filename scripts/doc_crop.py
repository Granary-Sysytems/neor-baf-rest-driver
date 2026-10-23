#!/usr/bin/env python3
"""Document auto-crop + deskew + enhance + orientation (OpenCV / Tesseract OSD).

Prints a JSON meta line to stdout.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from typing import Optional

import cv2
import numpy as np

MIN_AREA_RATIO = 0.16
MAX_AREA_RATIO = 0.98
MIN_CONFIDENCE = 0.42
MIN_ASPECT = 0.35
MAX_ASPECT = 2.85
MIN_SOLIDITY = 0.75
# Expand detected quad slightly so we don't clip page edges.
QUAD_MARGIN = 0.018


def order_points(pts: np.ndarray) -> np.ndarray:
    rect = np.zeros((4, 2), dtype="float32")
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]
    rect[2] = pts[np.argmax(s)]
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)]
    rect[3] = pts[np.argmax(diff)]
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


def expand_quad(pts: np.ndarray, img_w: int, img_h: int, margin: float = QUAD_MARGIN) -> np.ndarray:
    """Push each corner outward from the centroid by `margin` of the diagonal."""
    ordered = order_points(pts.astype("float32"))
    c = ordered.mean(axis=0)
    diag = float(np.linalg.norm([img_w, img_h]))
    out = []
    for p in ordered:
        v = p - c
        n = float(np.linalg.norm(v)) + 1e-6
        out.append(p + v / n * (margin * diag))
    expanded = np.array(out, dtype="float32")
    expanded[:, 0] = np.clip(expanded[:, 0], 0, img_w - 1)
    expanded[:, 1] = np.clip(expanded[:, 1], 0, img_h - 1)
    return order_points(expanded)


def normalize_for_detect(bgr: np.ndarray) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    gray = cv2.cvtColor(bgr, cv2.COLOR_BGR2GRAY)
    clahe = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8))
    norm = clahe.apply(gray)
    mean = float(norm.mean()) + 1e-6
    gamma = 1.0 if mean >= 90 else max(0.45, mean / 90.0)
    table = np.array([((i / 255.0) ** gamma) * 255 for i in range(256)], dtype=np.uint8)
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
        for eps in (0.02, 0.025, 0.03, 0.035, 0.04):
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
    box = cv2.boxPoints(cv2.minAreaRect(contour)).astype("float32")
    if scale != 1.0:
        box = box / scale
    return box


def merge_page_regions(mask: np.ndarray) -> np.ndarray:
    """Close gaps between facing pages so one contour covers the whole book."""
    k = cv2.getStructuringElement(cv2.MORPH_RECT, (25, 15))
    merged = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, k, iterations=3)
    k2 = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (15, 15))
    merged = cv2.dilate(merged, k2, iterations=2)
    return merged


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

    lengths = edge_lengths(ordered)
    if min(lengths) / max(lengths) < 0.22:
        return None

    hull = cv2.convexHull(ordered.reshape(4, 1, 2))
    hull_area = float(cv2.contourArea(hull)) + 1e-6
    solidity = area / hull_area
    if solidity < MIN_SOLIDITY:
        return None

    touches = touches_frame_edges(ordered, img_w, img_h)
    if touches >= 4 and ratio > 0.92:
        return None

    # Prefer larger coverage (full open book) more strongly than v2.
    score = ratio * 0.72
    if 0.55 <= aspect <= 1.55:
        score += 0.14
    elif 0.4 <= aspect <= 2.2:
        score += 0.06
    score += solidity * 0.1
    if touches <= 1:
        score += 0.05
    elif touches >= 3:
        score -= 0.08

    if page_hint is not None:
        mask = np.zeros(page_hint.shape, dtype=np.uint8)
        cv2.fillConvexPoly(mask, ordered.astype(np.int32), 255)
        inside = page_hint[mask > 0]
        outside = page_hint[mask == 0]
        if inside.size and outside.size:
            delta = float(inside.mean()) - float(outside.mean())
            score += max(-0.1, min(0.2, delta / 80.0))

    if method.startswith("merged") or method.startswith("sat"):
        score += 0.04
    if method.startswith("minrect"):
        score -= 0.02

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
    if float(otsu.mean()) > 127:
        otsu = cv2.bitwise_not(otsu)
    otsu = cv2.morphologyEx(otsu, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8), iterations=2)
    otsu = cv2.morphologyEx(otsu, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8), iterations=1)
    masks.append(("otsu", otsu))

    hsv = cv2.cvtColor(bgr_small, cv2.COLOR_BGR2HSV)
    sat = hsv[:, :, 1]
    val = hsv[:, :, 2]
    paper = ((sat < 80) & (val > max(35, int(np.percentile(val, 30))))).astype(np.uint8) * 255
    paper = cv2.morphologyEx(paper, cv2.MORPH_CLOSE, np.ones((11, 11), np.uint8), iterations=2)
    paper = cv2.morphologyEx(paper, cv2.MORPH_OPEN, np.ones((5, 5), np.uint8), iterations=1)
    masks.append(("sat_paper", paper))
    masks.append(("merged_paper", merge_page_regions(paper)))
    masks.append(("merged_otsu", merge_page_regions(otsu)))

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
        os.makedirs(debug_dir, exist_ok=True)
        cv2.imwrite(f"{debug_dir}/gray.jpg", gray)
        cv2.imwrite(f"{debug_dir}/clahe.jpg", norm)
        cv2.imwrite(f"{debug_dir}/lifted.jpg", lifted)

    candidates: list[Candidate] = []
    for name, mask in gather_masks(lifted, small):
        if debug_dir:
            cv2.imwrite(f"{debug_dir}/mask_{name}.jpg", mask)
        for pts in _quads_from_binary(mask, scale):
            c = score_quad(pts, w, h, name, page_hint)
            if c:
                candidates.append(c)
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

    candidates.sort(key=lambda c: (c.score, c.area_ratio), reverse=True)
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

    expanded = expand_quad(best.pts, w, h, QUAD_MARGIN)
    return expanded, {
        "reason": "ok",
        "confidence": round(best.score, 4),
        "method": best.method,
        "areaRatio": round(float(quad_area(expanded) / (w * h)), 4),
        "aspect": round(aspect_from_rect(expanded), 4),
        "solidity": round(best.solidity, 4),
        "edgeTouches": touches_frame_edges(expanded, w, h),
        "candidateCount": len(candidates),
        "margin": QUAD_MARGIN,
    }


def warp_document(image: np.ndarray, rect: np.ndarray) -> np.ndarray:
    (tl, tr, br, bl) = rect
    width_a = np.linalg.norm(br - bl)
    width_b = np.linalg.norm(tr - tl)
    max_w = max(int(width_a), int(width_b), 1)
    height_a = np.linalg.norm(tr - br)
    height_b = np.linalg.norm(tl - bl)
    max_h = max(int(height_a), int(height_b), 1)
    if max_w > 0 and max_h / max_w < 0.35 and max_w > max_h:
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


def gray_world_awb(image: np.ndarray) -> np.ndarray:
    b, g, r = cv2.split(image.astype(np.float32))
    avg = (float(b.mean()) + float(g.mean()) + float(r.mean())) / 3.0 + 1e-6
    b *= avg / (float(b.mean()) + 1e-6)
    g *= avg / (float(g.mean()) + 1e-6)
    r *= avg / (float(r.mean()) + 1e-6)
    return cv2.merge([np.clip(b, 0, 255), np.clip(g, 0, 255), np.clip(r, 0, 255)]).astype(
        np.uint8
    )


def levels_stretch(image: np.ndarray, low_p: float = 1.5, high_p: float = 98.5) -> np.ndarray:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    lo, hi = np.percentile(gray, (low_p, high_p))
    scale = 255.0 / max(float(hi - lo), 1.0)
    lut = np.clip((np.arange(256) - lo) * scale, 0, 255).astype(np.uint8)
    return cv2.LUT(image, lut)


def enhance_document(image: np.ndarray) -> np.ndarray:
    """Gray-world AWB + mild CLAHE on L + percentile levels stretch."""
    awb = gray_world_awb(image)
    lab = cv2.cvtColor(awb, cv2.COLOR_BGR2LAB)
    l, a, b = cv2.split(lab)
    l = cv2.createCLAHE(clipLimit=2.2, tileGridSize=(8, 8)).apply(l)
    merged = cv2.cvtColor(cv2.merge([l, a, b]), cv2.COLOR_LAB2BGR)
    return levels_stretch(merged)


def rotate_image(image: np.ndarray, degrees: int) -> np.ndarray:
    d = degrees % 360
    if d == 0:
        return image
    if d == 90:
        return cv2.rotate(image, cv2.ROTATE_90_CLOCKWISE)
    if d == 180:
        return cv2.rotate(image, cv2.ROTATE_180)
    if d == 270:
        return cv2.rotate(image, cv2.ROTATE_90_COUNTERCLOCKWISE)
    return image


def heuristic_orientation(image: np.ndarray) -> tuple[int, float]:
    """Fallback: prefer axis with stronger text-like horizontal runs after binarize."""
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    small = cv2.resize(gray, (min(900, gray.shape[1]), min(900, gray.shape[0])))
    thr = cv2.adaptiveThreshold(
        small, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY_INV, 31, 15
    )
    best_angle = 0
    best_score = -1.0
    for angle in (0, 90, 180, 270):
        rot = rotate_image(cv2.cvtColor(thr, cv2.COLOR_GRAY2BGR), angle)
        g = cv2.cvtColor(rot, cv2.COLOR_BGR2GRAY)
        # Horizontal projection variance is high when text lines are horizontal.
        row_sum = g.sum(axis=1).astype(np.float64)
        score = float(row_sum.std())
        if score > best_score:
            best_score = score
            best_angle = angle
    return best_angle, best_score


def detect_orientation_osd(image: np.ndarray) -> tuple[int, float, str]:
    """Return (rotate_degrees, confidence, method)."""
    tesseract = shutil.which("tesseract")
    if tesseract:
        with tempfile.TemporaryDirectory(prefix="neor-osd-") as td:
            path = os.path.join(td, "page.jpg")
            # Downscale large pages for speed; keep readable text.
            h, w = image.shape[:2]
            scale = 1600.0 / max(h, w) if max(h, w) > 1600 else 1.0
            small = (
                cv2.resize(image, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
                if scale != 1.0
                else image
            )
            cv2.imwrite(path, small, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
            try:
                proc = subprocess.run(
                    [tesseract, path, "stdout", "--psm", "0", "-l", "osd"],
                    capture_output=True,
                    text=True,
                    timeout=20,
                )
                text = (proc.stdout or "") + "\n" + (proc.stderr or "")
                m_rot = re.search(r"Rotate:\s*(\d+)", text)
                m_conf = re.search(r"Orientation confidence:\s*([0-9.]+)", text)
                if m_rot:
                    rot = int(m_rot.group(1)) % 360
                    if rot in (0, 90, 180, 270):
                        conf = float(m_conf.group(1)) if m_conf else 0.0
                        if conf >= 0.5 or rot != 0:
                            return rot, conf, "tesseract_osd"
            except (subprocess.TimeoutExpired, OSError, ValueError):
                pass

    angle, score = heuristic_orientation(image)
    return angle, float(score), "heuristic_projection"


def sharpness_laplacian(image: np.ndarray) -> float:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    h, w = gray.shape
    region = gray[h // 5 : 4 * h // 5, w // 5 : 4 * w // 5]
    return float(cv2.Laplacian(region, cv2.CV_64F).var())


def process(
    path_in: str,
    path_out: str,
    auto_crop: bool,
    deskew: bool,
    enhance: bool = True,
    rotate: str = "auto",
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
    rotation_applied = 0
    rotation_detected = 0
    rotation_confidence = 0.0
    rotation_method = "none"
    enhanced = False

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

    # Enhance before OSD so orientation is reliable on dark UVC frames.
    if enhance:
        out = enhance_document(out)
        enhanced = True
        method = f"{method}+enhance" if method != "none" else "enhance"

    # Orientation
    rot_mode = (rotate or "none").strip().lower()
    if rot_mode == "auto" and (auto_crop or deskew or enhance):
        rotation_detected, rotation_confidence, rotation_method = detect_orientation_osd(out)
        rotation_applied = rotation_detected
    elif rot_mode in ("0", "90", "180", "270"):
        rotation_applied = int(rot_mode)
        rotation_detected = rotation_applied
        rotation_method = "manual"
        rotation_confidence = 1.0
    elif rot_mode in ("none", "off", ""):
        rotation_applied = 0
    else:
        return {
            "ok": False,
            "error": f"invalid rotate: {rotate}",
            "applied": False,
            "reason": "invalid_rotate",
        }

    if rotation_applied:
        out = rotate_image(out, rotation_applied)
        method = f"{method}+rot{rotation_applied}"

    sharp = sharpness_laplacian(out)
    # Rough guidance thresholds on enhanced page-sized images.
    if sharp >= 400:
        focus_note = "ok"
    elif sharp >= 120:
        focus_note = "soft"
    else:
        focus_note = "blurry"

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
        "enhanced": enhanced,
        "rotation": rotation_applied,
        "rotationDetected": rotation_detected,
        "rotationConfidence": round(float(rotation_confidence), 4),
        "rotationMethod": rotation_method,
        "sharpness": round(sharp, 2),
        "focusNote": focus_note,
        "sourceWidth": src_w,
        "sourceHeight": src_h,
        "width": out_w,
        "height": out_h,
        "autoCrop": auto_crop,
        "deskew": deskew,
        "detect": detect_meta,
    }


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--auto-crop", action="store_true")
    p.add_argument("--deskew", action="store_true")
    p.add_argument("--enhance", action="store_true")
    p.add_argument("--no-enhance", action="store_true")
    p.add_argument(
        "--rotate",
        default="auto",
        help="auto|0|90|180|270|none — default auto when cropping/enhancing",
    )
    p.add_argument("--debug-dir", default=None)
    args = p.parse_args()
    auto = args.auto_crop or args.deskew
    deskew = args.deskew or args.auto_crop
    if args.no_enhance:
        enhance = False
    elif args.enhance:
        enhance = True
    else:
        # Default ON when any document processing is requested.
        enhance = auto
    rotate = args.rotate
    if rotate == "auto" and not (auto or enhance):
        rotate = "none"
    meta = process(
        args.input,
        args.output,
        auto,
        deskew,
        enhance=enhance,
        rotate=rotate,
        debug_dir=args.debug_dir,
    )
    print(json.dumps(meta))
    return 0 if meta.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
