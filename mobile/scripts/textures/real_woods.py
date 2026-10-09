"""Woods modelled on real photographs: irregular at every scale.

Layers, each warped by the same flow field so they follow one grain:
  growth lines (uneven spacing), fine fibres, pore flecks (short dark dashes along the grain),
  optional figure (flame/curl: soft bands across the grain that come and go), broad colour mottling.
"""
import os
import sys
import numpy as np
from PIL import Image

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "real")
os.makedirs(OUT, exist_ok=True)
H, W = 1100, 1600            # landscape, grain along x


def noise(h, w, ch, cw, seed):
    r = np.random.default_rng(seed)
    gh, gw = int(h / ch) + 4, int(w / cw) + 4
    small = Image.fromarray(r.random((gh, gw)).astype(np.float32), "F")
    big = np.asarray(small.resize((int(gw * cw), int(gh * ch)), Image.BICUBIC), np.float32)
    return big[:h, :w]


def fbm(ch, cw, octaves, seed, gain=0.5):
    t, a, n = np.zeros((H, W), np.float32), 1.0, 0.0
    for o in range(octaves):
        t += a * noise(H, W, max(1, ch / 2 ** o), max(1, cw / 2 ** o), seed + 31 * o)
        n += a
        a *= gain
    return t / n


def box(a, r, axis):
    if r < 1:
        return a
    c = np.cumsum(np.pad(a, [(r + 1, r) if i == axis else (0, 0) for i in range(a.ndim)], mode="edge"), axis=axis)
    hi = np.take(c, np.arange(2 * r + 1, c.shape[axis]), axis=axis)
    lo = np.take(c, np.arange(0, c.shape[axis] - 2 * r - 1), axis=axis)
    return (hi - lo) / (2 * r + 1)


def blur(a, rx, ry):
    for _ in range(3):
        a = box(box(a, int(rx), 1), int(ry), 0)
    return a


def warp(a, dx, dy):
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    x = np.clip(xx + dx, 0, W - 1.001)
    y = np.clip(yy + dy, 0, H - 1.001)
    x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
    fx, fy = x - x0, y - y0
    return (a[y0, x0] * (1 - fx) * (1 - fy) + a[y0, x0 + 1] * fx * (1 - fy)
            + a[y0 + 1, x0] * (1 - fx) * fy + a[y0 + 1, x0 + 1] * fx * fy)


def ramp(t, stops):
    t = np.clip(t, 0, 1)
    xs = [s for s, _ in stops]
    out = np.empty(t.shape + (3,), np.float32)
    for c in range(3):
        out[..., c] = np.interp(t, xs, [int(h[1 + 2 * c:3 + 2 * c], 16) for _, h in stops])
    return out


def norm(a):
    lo, hi = np.percentile(a, 1), np.percentile(a, 99)
    return np.clip((a - lo) / (hi - lo + 1e-6), 0, 1)


def wood(seed, ring_px, flow, ring_strength, fibre_strength, pore_density, pore_strength,
         figure=None, swirl=None, mottle=0.18, band_strength=0.0, dash_len=(5, 9)):
    r = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    # Flow field: the grain wanders across the board (big, slow) and ripples (small).
    dy = (fbm(700, 1400, 3, seed) - 0.5) * flow + (fbm(160, 500, 3, seed + 1) - 0.5) * flow * 0.25
    dx = (fbm(500, 900, 2, seed + 2) - 0.5) * flow * 0.4
    if swirl:
        cx, cy, radius, turns = swirl
        ox, oy = xx - cx, yy - cy
        d = np.sqrt(ox ** 2 + oy ** 2)
        ang = turns * np.exp(-(d / radius) ** 2)
        ca, sa = np.cos(ang), np.sin(ang)
        dx += ox * ca - oy * sa - ox
        dy += ox * sa + oy * ca - oy
    v = yy + dy                                     # across-the-grain coordinate, warped
    # Growth lines: uneven spacing, uneven darkness.
    spacing = ring_px * (0.55 + 0.9 * fbm(900, 2400, 2, seed + 3))
    phase = v / spacing + (fbm(300, 1800, 2, seed + 4) - 0.5) * 1.2
    frac = phase - np.floor(phase)
    line = np.exp(-((frac - 0.85) ** 2) / 0.006) * (0.35 + 0.65 * fbm(240, 700, 2, seed + 5))
    rings = blur(line, 2, 1)
    broad = 0.5 + 0.5 * np.sin(np.pi * phase + (fbm(500, 900, 2, seed + 12) - 0.5) * 3)
    broad = blur(broad, 4, 2)
    # Fine fibres along the grain.
    fib = warp(fbm(1.2, 260, 2, seed + 6), dx, dy)
    fib = norm(blur(fib, 6, 0))
    # Pores: short dark dashes along the grain, scattered unevenly.
    density = pore_density * (0.4 + 1.2 * fbm(200, 300, 2, seed + 7))
    pts = (r.random((H, W)) < density).astype(np.float32)
    dash = box(pts, int(r.integers(*dash_len)), 1)       # elongate along x
    dash = warp(np.clip(dash * 6, 0, 1), dx, dy)
    # Broad mottling: the board is never one colour.
    mott = fbm(260, 420, 4, seed + 8)
    t = 0.56 - band_strength * (broad - 0.5) - ring_strength * rings + fibre_strength * (fib - 0.5) + mottle * (mott - 0.5) - pore_strength * dash
    if figure:
        period, strength, softness, tilt = figure
        # Figure runs across the grain: soft bands, uneven period, fading in and out.
        u = xx + tilt * yy + (fbm(700, 220, 3, seed + 9) - 0.5) * period * 0.8
        band = np.sin(2 * np.pi * u / (period * (0.8 + 0.4 * fbm(900, 400, 2, seed + 10))))
        band = blur(band, period * 0.10, 2)
        fade = np.clip((fbm(110, 320, 3, seed + 11) - 0.32) * 2.4, 0, 1) * (0.5 + 0.5 * fbm(500, 700, 2, seed + 13))
        t = t + strength * band * fade
    return t


def save(rgb, name, rotate=False):
    img = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8))
    if rotate:
        img = img.transpose(Image.Transpose.ROTATE_90)
    img.save(os.path.join(OUT, name), quality=88, optimize=True, progressive=True)


def violin_back(name, seed, stops, period, strength):
    # Grain along the length of the back, flame across it; rotated so the grain runs top to bottom.
    t = wood(seed, ring_px=9, flow=24, ring_strength=0.07, fibre_strength=0.12, pore_density=0.0045,
             pore_strength=0.38, figure=(period, strength, 0, 0.22), mottle=0.26, dash_len=(6, 12))
    save(ramp(t, stops), name, rotate=True)


which = sys.argv[1:] or ["all"]
run = lambda n: "all" in which or n in which

if run("maple"):
    violin_back("violin-maple.jpg", 101, [(0.0, "#2A0A02"), (0.3, "#6E1E06"), (0.52, "#B2400F"), (0.72, "#E0731E"), (0.9, "#F7A445"), (1.0, "#FFD27E")], 80, 0.26)
if run("golden"):
    violin_back("violin-golden.jpg", 202, [(0.0, "#2E1206"), (0.3, "#6B2C0C"), (0.5, "#A65318"), (0.7, "#D88A2E"), (0.88, "#F2BC5A"), (1.0, "#FFE29A")], 58, 0.24)
if run("pernambuco"):
    t = wood(303, ring_px=22, flow=40, ring_strength=0.16, fibre_strength=0.14, pore_density=0.004, pore_strength=0.28, mottle=0.30)
    save(ramp(t, [(0.0, "#2C0D05"), (0.35, "#64200C"), (0.55, "#8E3416"), (0.75, "#B4542A"), (1.0, "#D88048")]), "pernambuco.jpg")
if run("koa"):
    t = wood(404, ring_px=46, flow=140, ring_strength=0.22, fibre_strength=0.16, pore_density=0.006, pore_strength=0.32,
             figure=(26, 0.10, 0, 0.0), mottle=0.34)
    save(ramp(t, [(0.0, "#2A170C"), (0.3, "#5A3420"), (0.55, "#8A5A3A"), (0.78, "#B4835C"), (1.0, "#D8AE84")]), "curly-walnut.jpg")
if run("rosewood"):
    t = wood(505, ring_px=34, flow=260, ring_strength=0.16, fibre_strength=0.22, pore_density=0.005, pore_strength=0.26,
             swirl=(1180, 640, 230, 3.2), mottle=0.28, band_strength=0.30)
    save(ramp(t, [(0.0, "#3A0E02"), (0.3, "#7A2606"), (0.55, "#B24411"), (0.78, "#D9651F"), (1.0, "#F08A3A")]), "figured-rosewood.jpg")

names = [n for n in ["violin-maple.jpg", "violin-golden.jpg", "pernambuco.jpg", "curly-walnut.jpg", "figured-rosewood.jpg"] if os.path.exists(os.path.join(OUT, n))]
sheet = Image.new("RGB", (900, 600 * ((len(names) + 1) // 2)))
for i, n in enumerate(names):
    im = Image.open(os.path.join(OUT, n))
    im = im.crop((0, 0, min(im.width, 900), min(im.height, 600))) if im.width >= 900 else im.resize((450, 600))
    sheet.paste(im.resize((450, 300)) if im.width > im.height else im.resize((450, 600)).crop((0, 0, 450, 300)), ((i % 2) * 450, (i // 2) * 300))
sheet = sheet.crop((0, 0, 900, 300 * ((len(names) + 1) // 2)))
sheet.save(os.path.join(OUT, "contact.png"))
print("ok", names)
