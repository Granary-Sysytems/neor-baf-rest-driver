#!/usr/bin/env python3
"""Document auto-crop + perspective deskew (OpenCV).

Reads an image file, finds the largest 4-point document contour, warps it
to a frontal rectangle, writes the result. Prints a JSON meta line to stdout.
"""

from __future__ import annotations

import argparse
import json
import sys
from typing import Optional, Tuple

import cv2
import numpy as np


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


def find_document_quad(
    image: np.ndarray,
) -> Optional[np.ndarray]:
    h, w = image.shape[:2]
    scale = 1000.0 / max(h, w) if max(h, w) > 1000 else 1.0
    small = (
        cv2.resize(image, (int(w * scale), int(h * scale)))
        if scale != 1.0
        else image
    )
    gray = cv2.cvtColor(small, cv2.COLOR_BGR2GRAY)
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)

    candidates: list[np.ndarray] = []

    # Pass 1: Canny edges
    edges = cv2.Canny(blurred, 50, 150)
    edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=1)
    candidates.extend(_quads_from_edges(edges, scale))

    # Pass 2: adaptive threshold (helps on flatbed/document-cam scenes)
    thr = cv2.adaptiveThreshold(
        blurred, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 11, 2
    )
    thr = cv2.bitwise_not(thr)
    thr = cv2.morphologyEx(thr, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8), iterations=2)
    candidates.extend(_quads_from_edges(thr, scale))

    if not candidates:
        return None

    # Prefer largest quad that covers a meaningful portion of the frame
    img_area = float(h * w)
    candidates.sort(key=quad_area, reverse=True)
    for q in candidates:
        area = quad_area(q)
        if 0.08 * img_area <= area <= 0.98 * img_area:
            return order_points(q)
    # fall back to largest even if ratio is odd
    return order_points(candidates[0])


def _quads_from_edges(edges: np.ndarray, scale: float) -> list[np.ndarray]:
    cnts, _ = cv2.findContours(edges, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    cnts = sorted(cnts, key=cv2.contourArea, reverse=True)[:30]
    quads: list[np.ndarray] = []
    for c in cnts:
        peri = cv2.arcLength(c, True)
        approx = cv2.approxPolyDP(c, 0.02 * peri, True)
        if len(approx) == 4 and cv2.isContourConvex(approx):
            pts = approx.reshape(4, 2).astype("float32")
            if scale != 1.0:
                pts = pts / scale
            quads.append(pts)
    return quads


def warp_document(image: np.ndarray, rect: np.ndarray) -> np.ndarray:
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


def process(path_in: str, path_out: str, auto_crop: bool, deskew: bool) -> dict:
    image = cv2.imread(path_in, cv2.IMREAD_COLOR)
    if image is None:
        return {"ok": False, "error": f"failed to read image: {path_in}", "applied": False}

    src_h, src_w = image.shape[:2]
    applied = False
    method = "none"
    out = image

    if auto_crop or deskew:
        quad = find_document_quad(image)
        if quad is not None:
            out = warp_document(image, quad)
            applied = True
            method = "perspective_quad"
        else:
            method = "no_quad_found"

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
        "sourceWidth": src_w,
        "sourceHeight": src_h,
        "width": out_w,
        "height": out_h,
        "autoCrop": auto_crop,
        "deskew": deskew,
    }


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--auto-crop", action="store_true")
    p.add_argument("--deskew", action="store_true")
    args = p.parse_args()
    # deskew alone still runs the same perspective pipeline
    auto = args.auto_crop or args.deskew
    deskew = args.deskew or args.auto_crop
    meta = process(args.input, args.output, auto, deskew)
    print(json.dumps(meta))
    return 0 if meta.get("ok") else 1


if __name__ == "__main__":
    sys.exit(main())
