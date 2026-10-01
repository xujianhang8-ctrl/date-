#!/usr/bin/env python3
"""Build data.js and floor-plan images for the 3D explorer from the project brochure PDF.

Usage:
    pip install pymupdf numpy opencv-python-headless pillow
    python3 tools/build_data.py "Thomson_Reserve_....pdf"

What it extracts:
  * the stack charts (unit type of every block / level / stack),
  * the unit-type pages (bedroom category, area and floor-plan page),
  * the key plan (site boundary, tower footprints and every stack outline, traced
    from the vector drawing) and the north arrow,
  * the pools from the illustrated site plan,
and writes them, georeferenced in metres east/north of the site centroid, to data.js.
"""
import json
import math
import os
import re
import sys

import cv2
import numpy as np
import pymupdf
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Pages (1-based) in the brochure.
CHART_PAGES = [(4, False), (5, False), (32, True), (33, True)]  # (page, luxury collection)
PLAN_PAGES = list(range(6, 32)) + list(range(34, 49))
KEY_PLAN_PAGE = 6
SITE_PLAN_PAGE = 3

# Georeferencing of the key plan. The north arrow gives the page rotation; the scale and
# the site centroid position were fitted against satellite imagery and road edges, and
# agree with the floor-plan scale bar (Type B1 is 8.7 m x 10.0 m) and the 5-hectare site.
PAGE_UP_BEARING = 38.10  # degrees clockwise from true north
METRES_PER_PT = 2.2919
CENTROID_LATLNG = (1.3570843, 103.8304295)

CATEGORIES = [
    # id, label, bedrooms, colour
    ("2BR", "2-Bedroom", 2, "#9fd8cf"),
    ("2BRP", "2-Bedroom Premium", 2, "#4fb3a7"),
    ("2BRPS", "2-Bedroom Premium + Study", 2, "#2b7e86"),
    ("3BR", "3-Bedroom", 3, "#f4d47c"),
    ("3BRP", "3-Bedroom Premium", 3, "#e8a33d"),
    ("3BRPS", "3-Bedroom Premium + Study", 3, "#d6702c"),
    ("4BR", "4-Bedroom", 4, "#eb9bab"),
    ("4BRP", "4-Bedroom Premium (Private Lift)", 4, "#c95c7c"),
    ("4BRPS", "4-Bedroom Premium + Study (Private Lift)", 4, "#9a3d6c"),
    ("5BR", "5-Bedroom Suite (Private Lift)", 5, "#6a2c5c"),
]
CATEGORY_BY_HEADING = {
    "2-Bedroom": "2BR",
    "2-Bedroom Premium": "2BRP",
    "2-Bedroom Premium + Study": "2BRPS",
    "3-Bedroom": "3BR",
    "3-Bedroom Premium": "3BRP",
    "3-Bedroom Premium + Study": "3BRPS",
    "4-Bedroom": "4BR",
    "4-Bedroom Premium": "4BRP",
    "4-Bedroom Premium + Study": "4BRPS",
    "5-Bedroom Suite": "5BR",
}


def base_type(code):
    """'B1p' -> 'B1', 'BP2p (L)' -> 'BP2 (L)'."""
    return re.sub(r"p( \(L\))?$", r"\1", code)


# ----------------------------------------------------------------------------- stack charts
def parse_charts(doc):
    units = []
    for pno, lux in CHART_PAGES:
        words = doc[pno - 1].get_text("words")
        for head in [w for w in words if w[4] == "Bright"]:
            num = [w for w in words if abs(w[1] - head[1]) < 1 and w[2] < head[0] and head[0] - w[2] < 8][-1]
            block = int(num[4])
            bx = (head[0] + head[2]) / 2
            cand = [w for w in words if re.fullmatch(r"\d\d", w[4]) and 0 < w[1] - head[1] < 40]
            row_y = min(w[1] for w in cand)
            header = sorted([w for w in cand if abs(w[1] - row_y) < 1.5], key=lambda w: w[0])
            groups = [[header[0]]]
            for w in header[1:]:
                if w[0] - groups[-1][-1][2] > 60:
                    groups.append([w])
                else:
                    groups[-1].append(w)
            group = min(groups, key=lambda g: abs((g[0][0] + g[-1][2]) / 2 - bx))
            cols = [(int(w[4]), (w[0] + w[2]) / 2) for w in group]
            col_w = (cols[-1][1] - cols[0][1]) / (len(cols) - 1)
            levels = [w for w in words if re.fullmatch(r"\d\d", w[4]) and w[1] > row_y + 2
                      and cols[0][1] - col_w * 2.2 < (w[0] + w[2]) / 2 < cols[0][1] - col_w * 0.6]
            for lw in levels:
                y = (lw[1] + lw[3]) / 2
                row = [w for w in words if abs((w[1] + w[3]) / 2 - y) < 1.2 and w[0] > lw[2]]
                for stack, cx in cols:
                    cell = [w for w in row if abs((w[0] + w[2]) / 2 - cx) < col_w * 0.5
                            and re.fullmatch(r"[A-Z]+\d+p?", w[4])]
                    if cell:
                        units.append((block, int(lw[4]), stack, cell[0][4] + (" (L)" if lux else "")))
    return units


# ----------------------------------------------------------------------------- unit types
def parse_types(doc):
    types = {}
    for pno in PLAN_PAGES:
        text = doc[pno - 1].get_text()
        lines = [l.strip() for l in text.split("\n")]
        heading = next(l for l in lines if re.match(r"\d-Bedroom", l))
        cat = CATEGORY_BY_HEADING[heading.strip()]
        for m in re.finditer(r"Type ([A-Z]+\d+p?(?: \(L\))?)\s*\n\s*(\d+) sqm \(([\d,]+) sqft\)", text):
            code = m.group(1)
            types[code] = {
                "category": cat,
                "sqm": int(m.group(2)),
                "sqft": int(m.group(3).replace(",", "")),
                "page": pno,
            }
    return types


# ----------------------------------------------------------------------------- key plan
def bezier(p0, p1, p2, p3, n=6):
    out = []
    for t in np.linspace(0, 1, n)[1:]:
        out.append(tuple((1 - t) ** 3 * a + 3 * (1 - t) ** 2 * t * b + 3 * (1 - t) * t * t * c + t ** 3 * d
                         for a, b, c, d in zip(p0, p1, p2, p3)))
    return out


def path_points(drawing):
    pts = []
    for it in drawing["items"]:
        if it[0] == "l":
            a, b = it[1], it[2]
            if not pts:
                pts.append((a.x, a.y))
            pts.append((b.x, b.y))
        elif it[0] == "c":
            a, b, c, d = it[1:5]
            if not pts:
                pts.append((a.x, a.y))
            pts += bezier((a.x, a.y), (b.x, b.y), (c.x, c.y), (d.x, d.y))
    return pts


def site_boundary(page):
    """The boundary is drawn as one long path plus a few short pieces around the north-west tip."""
    strokes = [d for d in page.get_drawings() if d["type"] == "s" and 550 < d["rect"].x0 < 780
               and 450 < d["rect"].y0 < 560]
    main = max(strokes, key=lambda d: d["rect"].width)
    pts = path_points(main)
    pieces = [path_points(d) for d in strokes if d is not main and d["rect"].x1 < 590 and d["rect"].y1 < 490
              and d["rect"].width < 30]
    # Chain the pieces from the end of the main path back to its start.
    end, start = pts[-1], pts[0]
    chain = []
    cur = end
    remaining = [p for p in pieces if len(p) >= 2]
    while remaining:
        best = None
        for p in remaining:
            for seq in (p, p[::-1]):
                d = math.dist(seq[0], cur)
                if best is None or d < best[0]:
                    best = (d, p, seq)
        if best[0] > 1.0:
            break
        remaining.remove(best[1])
        chain += best[2][1:]
        cur = chain[-1]
        if math.dist(cur, start) < 0.5:
            break
    return pts + chain


def trace_key_plan(doc):
    page = doc[KEY_PLAN_PAGE - 1]
    clip = pymupdf.Rect(585, 470, 782, 562)
    words = [w for w in page.get_text("words") if clip.contains(pymupdf.Rect(w[:4]))]
    labels = {}
    for w in words:
        if re.fullmatch(r"\d\d", w[4]):
            labels.setdefault(int(w[4]), []).append(((w[0] + w[2]) / 2, (w[1] + w[3]) / 2))
    site = site_boundary(page)

    # Render the line work without text and flood-fill every stack from its label.
    page.add_redact_annot(clip)
    page.apply_redactions(images=0, graphics=0, text=0)
    Z = 30
    pix = page.get_pixmap(matrix=pymupdf.Matrix(Z, Z), clip=clip, alpha=False)
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, 3)
    walls = (cv2.cvtColor(img, cv2.COLOR_RGB2GRAY) < 170).astype(np.uint8)
    H, W = walls.shape
    to_px = lambda p: (int(round((p[0] - clip.x0) * Z)), int(round((p[1] - clip.y0) * Z)))
    to_pt = lambda x, y: (clip.x0 + x / Z, clip.y0 + y / Z)

    footprints = []
    closed = cv2.morphologyEx(walls, cv2.MORPH_CLOSE, np.ones((9, 9), np.uint8))
    contours, _ = cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    for cnt in contours:
        if cv2.contourArea(cnt) / Z / Z < 100:
            continue
        mask = np.zeros_like(walls)
        cv2.drawContours(mask, [cnt], -1, 1, -1)
        core = cv2.erode(mask, np.ones((15, 15), np.uint8))  # inset ~0.5 m so unit walls stay visible
        cc, _ = cv2.findContours(core, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cc = max(cc, key=cv2.contourArea)
        footprints.append({
            "contour": cnt,
            "outline": [to_pt(*p[0]) for p in cv2.approxPolyDP(cnt, 0.12 * Z, True)],
            "core": [to_pt(*p[0]) for p in cv2.approxPolyDP(cc, 0.12 * Z, True)],
        })

    stacks = {}
    free = (1 - walls).astype(np.uint8)
    for stack, positions in labels.items():
        for c in positions:
            x, y = to_px(c)
            # The same number can label a block and a stack; keep the one inside a tower.
            if not any(cv2.pointPolygonTest(f["contour"], (float(x), float(y)), False) >= 0 for f in footprints):
                continue
            if walls[y, x]:
                for r in range(1, 40):
                    hits = [(x + dx, y + dy) for dx, dy in ((r, 0), (-r, 0), (0, r), (0, -r))
                            if 0 <= y + dy < H and 0 <= x + dx < W and not walls[y + dy, x + dx]]
                    if hits:
                        x, y = hits[0]
                        break
            mask = np.zeros((H + 2, W + 2), np.uint8)
            cv2.floodFill(free.copy(), mask, (x, y), 1, flags=4 | (1 << 8))
            m = cv2.dilate(mask[1:-1, 1:-1], np.ones((5, 5), np.uint8))
            cnts, _ = cv2.findContours(m, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            cnt = max(cnts, key=cv2.contourArea)
            stacks[stack] = [to_pt(*p[0]) for p in cv2.approxPolyDP(cnt, 0.10 * Z, True)]
    return site, footprints, stacks


# ----------------------------------------------------------------------------- georeference
def centroid(poly):
    p = np.array(poly)
    x, y = p[:, 0], p[:, 1]
    cross = x * np.roll(y, -1) - np.roll(x, -1) * y
    a = cross.sum() / 2
    return (np.sum((x + np.roll(x, -1)) * cross) / (6 * a), np.sum((y + np.roll(y, -1)) * cross) / (6 * a))


def make_enu(origin):
    th = math.radians(PAGE_UP_BEARING)

    def enu(p):
        u = p[0] - origin[0]
        v = -(p[1] - origin[1])
        e = METRES_PER_PT * (u * math.cos(th) + v * math.sin(th))
        n = METRES_PER_PT * (-u * math.sin(th) + v * math.cos(th))
        return [round(e, 2), round(n, 2)]
    return enu


# ----------------------------------------------------------------------------- pools
def trace_pools(doc, footprints, enu):
    """Pools from the illustrated site plan, aligned to the key plan via the six tower centres."""
    page = doc[SITE_PLAN_PAGE - 1]
    xref = page.get_images()[0][0]
    pix = pymupdf.Pixmap(doc, xref)
    img = np.frombuffer(pix.samples, dtype=np.uint8).reshape(pix.height, pix.width, pix.n)[:, :, :3]
    img = np.ascontiguousarray(img[:, :, ::-1])
    # Tower centres (block numbers) in the site-plan image, west to east: Blk 7, 5, 9, 11, 3, 1.
    plan_px = np.array([(1300, 1767), (1723, 2048), (2997, 1753), (3503, 1373), (3334, 2116), (3827, 1864)], float)
    order = [7, 5, 9, 11, 3, 1]
    key_pt = np.array([centroid(footprints[b]["outline"]) for b in order], float)
    # Least-squares similarity transform plan_px -> key_pt.
    mp, mk = plan_px.mean(0), key_pt.mean(0)
    A, B = plan_px - mp, key_pt - mk
    u, s, vt = np.linalg.svd(A.T @ B)
    R = (u @ vt).T
    if np.linalg.det(R) < 0:
        vt[-1] *= -1
        R = (u @ vt).T
    scale = s.sum() / (A ** 2).sum()
    resid = np.linalg.norm((A @ R.T) * scale - B, axis=1).max() * METRES_PER_PT
    print(f"  site plan -> key plan fit: max residual {resid:.1f} m")

    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    water = cv2.inRange(hsv, (95, 80, 90), (115, 255, 255))
    water = cv2.morphologyEx(water, cv2.MORPH_CLOSE, np.ones((25, 25), np.uint8))
    cnts, _ = cv2.findContours(water, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    pools = []
    for c in cnts:
        if cv2.contourArea(c) < 6000:
            continue  # facility markers are small blue circles
        c = cv2.approxPolyDP(c, 6, True)
        pts = (c[:, 0, :].astype(float) - mp) @ R.T * scale + mk
        pools.append([enu(p) for p in pts])
    return pools


# ----------------------------------------------------------------------------- main
def main(pdf_path):
    doc = pymupdf.open(pdf_path)
    units = parse_charts(doc)
    types = parse_types(doc)
    print(f"  {len(units)} units, {len(types)} unit types")
    missing = sorted({t for *_, t in units} - set(types))
    assert not missing, f"unit types without a floor plan: {missing}"

    site, footprints, stacks = trace_key_plan(pymupdf.open(pdf_path))
    origin = centroid(site)
    enu = make_enu(origin)

    # Which tower each stack belongs to, from the stack charts.
    stack_block = {s: b for b, _, s, _ in units}
    blocks = {}
    for b in sorted(set(stack_block.values())):
        members = [s for s, bb in stack_block.items() if bb == b]
        cx, cy = np.mean([centroid(stacks[s]) for s in members], axis=0)
        fp = min(footprints, key=lambda f: math.dist(centroid(f["outline"]), (cx, cy)))
        blocks[b] = fp
    pools = trace_pools(pymupdf.open(pdf_path), blocks, enu)
    print(f"  {len(pools)} pools")

    luxury = {b for b, _, _, t in units if t.endswith("(L)")}
    addresses = {1: "579580", 3: "579587", 5: "579594", 7: "579599", 9: "579600", 11: "579608"}
    block_out = []
    for b, fp in sorted(blocks.items()):
        levels = sorted({l for bb, l, _, _ in units if bb == b})
        bc = centroid(fp["outline"])
        block_out.append({
            "id": str(b),
            "name": f"Blk {b}",
            "address": f"{b} Bright Hill Drive, Singapore {addresses[b]}",
            "collection": "Luxury" if b in luxury else "Classic",
            "levels": [levels[0], levels[-1]],
            "outline": [enu(p) for p in fp["outline"]],
            "core": [enu(p) for p in fp["core"]],
            "center": enu(bc),
        })

    stack_out = {}
    for s, poly in sorted(stacks.items()):
        sc = centroid(poly)
        b = stack_block[s]
        bc = centroid(blocks[b]["outline"])
        e, n = np.subtract(enu(sc), enu(bc))
        bearing = (math.degrees(math.atan2(e, n)) + 360) % 360
        stack_out[f"{s:02d}"] = {"block": str(b), "outline": [enu(p) for p in poly], "center": enu(sc),
                                 "bearing": round(bearing, 1)}

    type_out = {}
    for code, t in sorted(types.items()):
        type_out[code] = dict(t, plan=f"floorplans/p{t['page']:02d}.webp", pes=bool(re.search(r"\dp( |$)", code)))

    # Floor-plan images, one per page.
    os.makedirs(os.path.join(ROOT, "floorplans"), exist_ok=True)
    for pno in sorted({t["page"] for t in types.values()}):
        pix = doc[pno - 1].get_pixmap(matrix=pymupdf.Matrix(2, 2), alpha=False)
        im = Image.frombytes("RGB", (pix.width, pix.height), pix.samples)
        im.save(os.path.join(ROOT, "floorplans", f"p{pno:02d}.webp"), "WEBP", quality=72, method=6)

    data = {
        "origin": {"lat": CENTROID_LATLNG[0], "lng": CENTROID_LATLNG[1]},
        "categories": [{"id": c, "label": l, "beds": b, "color": col} for c, l, b, col in CATEGORIES],
        "types": type_out,
        "blocks": block_out,
        "stacks": stack_out,
        "units": [[str(b), l, f"{s:02d}", t] for b, l, s, t in sorted(units)],
        "site": [enu(p) for p in site],
        "pools": pools,
    }
    with open(os.path.join(ROOT, "data.js"), "w") as f:
        f.write("// Generated by tools/build_data.py from the project brochure. Do not edit by hand.\n")
        f.write("// Coordinates are metres east / north of data.origin.\n")
        f.write("window.SITE_DATA = ")
        json.dump(data, f, separators=(",", ":"))
        f.write(";\n")
    print("  wrote data.js")


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
