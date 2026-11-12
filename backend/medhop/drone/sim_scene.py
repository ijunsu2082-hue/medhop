"""The simulator's display scene: a closed care-home room rendered at a high resolution.

Used only by the display camera profile (`SimConfig(scene="room")`, see `SimConfig.high_quality`). The
drone-like profile (`scene="plain"`, the default, used by the closed-loop and marker tests and every
published simulator figure) never imports anything from here that builds textures.

Room: x in [X0, X1], y in [0, ROOM_H], z in [Z0, 0]. The station wall is the plane z = 0, as in sim.py.
Every surface is a plane drawn with a homography from a pre-computed texture (with baked lighting), so a
frame costs a few dozen `cv2.warpPerspective` calls. Walls are drawn in bands of columns from the mip
level that suits their distance. The floor and the ceiling are drawn in bands of rows from anisotropic
levels (`Rip`: sharp across, filtered in the foreshortened depth direction), only in the rows the walls
leave visible. Level changes cross-fade so they do not show as seams. A tiling grain layer down to
4096 px per metre gives the floor its detail when the camera is close to it (on the ground before
takeoff). The station sign is the printable `station_sign` sheet, pure black and white, drawn per frame
with its own soft shadow.
"""
from __future__ import annotations

import functools
import math
from typing import Callable, Dict, List, Optional, Sequence, Tuple

import cv2
import numpy as np

from medhop.vision.marker import A4_HEIGHT_M, A4_WIDTH_M, SIGN_TOP_MARGIN_M

ROOM_H = 2.7
X0, X1 = -5.0, 5.0
Z0 = -8.0
WALL_PPM = 320.0
FLOOR_PPM = 256.0
CEIL_PPM = 96.0
GRAIN_PPM = 4096.0           # the tiling floor grain layer: a tile 4 boards wide, 0.5 m long
GRAIN_PLANKS = 4
GRAIN_TILE_M = 0.5
DETAIL_PPM = 1024.0          # the grain layer fades in from DETAIL_PPM / 8 render px per metre in depth
SHADOW_PPM = 400.0           # the station sign's shadow mask
SHADOW_MARGIN_M = 0.06
LOD_BIAS = 0.85              # < 1 picks a slightly coarser level: less shimmer, barely softer
DEPTH_LOD_BIAS = 0.23        # floor and ceiling: the same bias, in levels, on the foreshortened direction

LIGHT_X = (-3.75, -1.25, 1.25, 3.75)
LIGHT_Z = (-1.4, -4.0, -6.6)

# Colours are BGR. Warm white plaster (near #EDE9DF), muted grey-green wainscot, oak rail, doors and
# floor, light plaques with dark text. Nothing saturated, and no dark panel with light content on it
# (a dark plate with light marks can decode as an ArUco marker).
PLASTER = (224, 234, 238)
WAINSCOT = (170, 186, 178)
OAK_RAIL = (128, 170, 204)
OAK_DOOR = (114, 158, 194)
OAK_FLOOR = (150, 186, 212)
ARCHITRAVE = (230, 236, 239)
SKIRTING = (214, 222, 226)
STEEL = (178, 180, 180)
PLAQUE = (236, 239, 240)
PLAQUE_EDGE = (178, 182, 184)
PLAQUE_TEXT = (74, 70, 64)
CORK = (150, 182, 206)
PIN = (96, 128, 150)

PALETTES = (
    ((222, 214, 196), (186, 178, 150), (150, 158, 122), (112, 132, 98)),
    ((206, 222, 236), (170, 190, 214), (140, 164, 190), (108, 132, 160)),
    ((226, 220, 208), (176, 186, 160), (132, 156, 128), (96, 124, 104)),
)

Level = Tuple[float, np.ndarray]


# --------------------------------------------------------------------------- #
# texture helpers
# --------------------------------------------------------------------------- #
def _to_u8(img: np.ndarray) -> np.ndarray:
    return np.clip(img, 0, 255).astype(np.uint8)


def _fbm(rng: np.random.Generator, h: int, w: int, base: int, octaves: int, persistence: float = 0.5) -> np.ndarray:
    """Smooth multi-octave noise in about [-1, 1], float32."""
    out = np.zeros((h, w), np.float32)
    amp, total, cells = 1.0, 0.0, base
    for _ in range(octaves):
        gh, gw = max(2, h // cells + 2), max(2, w // cells + 2)
        grid = rng.standard_normal((gh, gw)).astype(np.float32)
        out += amp * cv2.resize(grid, (w, h), interpolation=cv2.INTER_CUBIC)
        total += amp
        amp *= persistence
        cells = max(1, cells // 2)
    return out / total


def _shadow(tex: np.ndarray, x0: int, y0: int, x1: int, y1: int, blur: float, strength: float,
            dx: int = 0, dy: int = 0) -> None:
    """Multiply a soft dark rectangle into tex (a drop shadow or a contact shadow)."""
    pad = int(blur * 3) + 2
    ax0, ay0 = max(0, x0 + dx - pad), max(0, y0 + dy - pad)
    ax1, ay1 = min(tex.shape[1], x1 + dx + pad), min(tex.shape[0], y1 + dy + pad)
    if ax1 <= ax0 or ay1 <= ay0:
        return
    mask = np.zeros((ay1 - ay0, ax1 - ax0), np.float32)
    cv2.rectangle(mask, (x0 + dx - ax0, y0 + dy - ay0), (x1 + dx - ax0 - 1, y1 + dy - ay0 - 1), 1.0, -1)
    mask = cv2.GaussianBlur(mask, (0, 0), blur)
    region = tex[ay0:ay1, ax0:ax1].astype(np.float32)
    region *= (1.0 - strength * mask)[..., None]
    tex[ay0:ay1, ax0:ax1] = _to_u8(region)


def _mips(tex: np.ndarray, ppm: float, levels: int) -> List[Level]:
    out = [(ppm, tex)]
    for _ in range(levels - 1):
        ppm /= 2.0
        tex = cv2.resize(tex, (max(1, tex.shape[1] // 2), max(1, tex.shape[0] // 2)),
                         interpolation=cv2.INTER_AREA)
        out.append((ppm, tex))
    return out


class Rip:
    """Anisotropic mip levels ("rip maps") of a horizontal plane's texture.

    Level (lx, ly) halves the texture lx times across (u) and ly times in depth (v), with ly >= lx. A
    floor seen from a level camera is foreshortened in depth far more than across (by dv / focal), so a
    row of the floor can use a level that is sharp across and filtered in depth: no smear toward the
    vanishing point and no shimmer from the depth direction."""

    def __init__(self, tex: np.ndarray, ppm: float, max_lx: int, max_ly: int) -> None:
        self.ppm = ppm
        self.max_lx, self.max_ly = max_lx, max_ly
        self.levels: Dict[Tuple[int, int], np.ndarray] = {}
        iso = tex
        for lx in range(max_lx + 1):
            if lx:
                iso = cv2.resize(iso, (max(1, iso.shape[1] // 2), max(1, iso.shape[0] // 2)),
                                 interpolation=cv2.INTER_AREA)
            cur = iso
            self.levels[(lx, lx)] = cur
            for ly in range(lx + 1, max_ly + 1):
                cur = cv2.resize(cur, (cur.shape[1], max(1, cur.shape[0] // 2)), interpolation=cv2.INTER_AREA)
                self.levels[(lx, ly)] = cur


def _overlaps(a: Tuple[float, float, float, float], b: Tuple[float, float, float, float]) -> bool:
    return a[0] < b[2] and b[0] < a[2] and a[1] < b[3] and b[1] < a[3]


# --------------------------------------------------------------------------- #
# walls
# --------------------------------------------------------------------------- #
def _wall_base(rng: np.random.Generator, length_m: float) -> np.ndarray:
    """Painted plaster, lower wainscot, handrail and skirting, with baked ambient shading."""
    ppm = WALL_PPM
    w, h = int(length_m * ppm), int(ROOM_H * ppm)

    def row(y_m: float) -> int:
        return int(round((ROOM_H - y_m) * ppm))

    tex = np.empty((h, w, 3), np.float32)
    tex[:] = PLASTER
    dado = row(0.66)
    tex[dado:] = WAINSCOT
    mottle = _fbm(rng, h, w, 220, 4) * 4.0
    grain = cv2.GaussianBlur(rng.standard_normal((h, w)).astype(np.float32), (0, 0), 0.7) * 2.6
    tex += (mottle + grain)[..., None]

    # light: a gentle wash from the ceiling lights, brighter at mid height, darker into the creases
    ys = ROOM_H - (np.arange(h, dtype=np.float32) + 0.5) / ppm
    vertical = 0.90 + 0.12 * np.exp(-((ys - 1.55) / 0.95) ** 2)
    vertical *= 1.0 - 0.22 * np.exp(-ys / 0.16)
    vertical *= 1.0 - 0.16 * np.exp(-(ROOM_H - ys) / 0.14)
    xs = (np.arange(w, dtype=np.float32) + 0.5) / ppm
    corner = 1.0 - 0.20 * (np.exp(-xs / 0.22) + np.exp(-(length_m - xs) / 0.22))
    pools = np.zeros(w, np.float32)
    for cx in np.arange(length_m / 2.0 % 2.5, length_m, 2.5):
        pools += np.exp(-((xs - cx) / 0.85) ** 2)
    scallop = 1.0 + 0.05 * pools[None, :] * np.exp(-((ys[:, None] - 1.75) / 0.8) ** 2)
    tex *= (vertical[:, None] * corner[None, :] * scallop)[..., None]

    # handrail (oak) with a shadow beneath it
    r0, r1 = row(0.735), row(0.675)
    tex8 = _to_u8(tex)
    _shadow(tex8, 0, r0, w, r1, blur=ppm * 0.02, strength=0.26, dy=int(ppm * 0.03))
    rail = np.empty((r1 - r0, w, 3), np.float32)
    rail[:] = OAK_RAIL
    streak = cv2.GaussianBlur(rng.standard_normal((r1 - r0, w)).astype(np.float32), (0, 0), sigmaX=40, sigmaY=0.8)
    rail += streak[..., None] * 50.0
    profile = np.sin(np.linspace(0.15, math.pi - 0.3, r1 - r0, dtype=np.float32))   # rounded: lit on top
    rail *= (0.74 + 0.34 * profile)[:, None, None]
    tex8[r0:r1] = _to_u8(rail)
    # skirting board
    s0 = row(0.11)
    _shadow(tex8, 0, s0 - 2, w, s0, blur=2.0, strength=0.22)
    skirt = np.empty((h - s0, w, 3), np.float32)
    skirt[:] = SKIRTING
    skirt *= np.linspace(1.03, 0.74, h - s0, dtype=np.float32)[:, None, None]
    skirt[:2] *= 1.05
    tex8[s0:] = _to_u8(skirt)
    return tex8


def _plaque(tex: np.ndarray, x: int, y: int, text: str) -> None:
    """A light room-number plaque with dark figures."""
    ppm = WALL_PPM
    w, h = int(round(0.16 * ppm)), int(round(0.10 * ppm))
    _shadow(tex, x, y, x + w, y + h, blur=3, strength=0.18, dy=3)
    cv2.rectangle(tex, (x, y), (x + w, y + h), PLAQUE, -1, cv2.LINE_AA)
    cv2.rectangle(tex, (x, y), (x + w, y + h), PLAQUE_EDGE, 1, cv2.LINE_AA)
    scale = ppm * 0.0019
    (tw, th), _ = cv2.getTextSize(text, cv2.FONT_HERSHEY_DUPLEX, scale, 2)
    cv2.putText(tex, text, (x + (w - tw) // 2, y + (h + th) // 2), cv2.FONT_HERSHEY_DUPLEX, scale,
                PLAQUE_TEXT, 2, cv2.LINE_AA)


def _door(tex: np.ndarray, rng: np.random.Generator, x_m: float, width_m: float = 0.92, number: str = "") -> None:
    ppm = WALL_PPM
    h = tex.shape[0]

    def px(v: float) -> int:
        return int(round(v * ppm))

    top = h - px(2.08)
    x0, x1 = px(x_m), px(x_m + width_m)
    f = px(0.07)
    _shadow(tex, x0 - f, top - f, x1 + f, h, blur=ppm * 0.03, strength=0.22, dx=px(0.012), dy=px(0.012))
    cv2.rectangle(tex, (x0 - f, top - f), (x1 + f, h), ARCHITRAVE, -1)
    cv2.rectangle(tex, (x0 - f, top - f), (x1 + f, h), (190, 196, 200), 1)
    door = np.empty((h - top, x1 - x0, 3), np.float32)
    door[:] = OAK_DOOR
    streak = cv2.GaussianBlur(rng.standard_normal(door.shape[:2]).astype(np.float32), (0, 0), sigmaX=1.2, sigmaY=60)
    door += streak[..., None] * 60.0
    door *= np.linspace(1.04, 0.92, door.shape[0], dtype=np.float32)[:, None, None]
    tex[top:h, x0:x1] = _to_u8(door)
    cv2.rectangle(tex, (x0, top), (x1 - 1, h - 1), (84, 116, 146), 1)
    # narrow vision panel: frosted glass, lighter than the door, so the door never frames a light patch
    # inside a dark border
    g0x, g1x = x1 - px(0.27), x1 - px(0.12)
    g0y, g1y = top + px(0.32), top + px(1.05)
    glass = np.empty((g1y - g0y, g1x - g0x, 3), np.float32)
    glass[:] = (204, 204, 198)
    glass *= np.linspace(1.06, 0.92, glass.shape[0], dtype=np.float32)[:, None, None]
    tex[g0y:g1y, g0x:g1x] = _to_u8(glass)
    cv2.rectangle(tex, (g0x - 2, g0y - 2), (g1x + 1, g1y + 1), (120, 150, 176), 2)
    # kick plate and lever handle (brushed steel)
    cv2.rectangle(tex, (x0 + px(0.02), h - px(0.24)), (x1 - px(0.02), h - px(0.03)), STEEL, -1)
    hy = h - px(1.02)
    _shadow(tex, x0 + px(0.06), hy - px(0.012), x0 + px(0.20), hy + px(0.012), blur=3, strength=0.3, dy=px(0.012))
    cv2.rectangle(tex, (x0 + px(0.06), hy - px(0.012)), (x0 + px(0.20), hy + px(0.012)), (198, 200, 200), -1,
                  cv2.LINE_AA)
    cv2.circle(tex, (x0 + px(0.075), hy), px(0.028), (206, 208, 208), -1, cv2.LINE_AA)
    cv2.circle(tex, (x0 + px(0.075), hy), px(0.028), (150, 152, 152), 1, cv2.LINE_AA)
    if number:
        _plaque(tex, x1 + f + px(0.08), top + px(0.55), number)


def _print(tex: np.ndarray, rng: np.random.Generator, x_m: float, y_m: float, w_m: float, h_m: float,
           palette: Sequence[Tuple[int, int, int]]) -> None:
    """A framed print: oak frame, off-white mount, a soft landscape in muted tones."""
    ppm = WALL_PPM
    hh = tex.shape[0]
    x0, x1 = int(x_m * ppm), int((x_m + w_m) * ppm)
    y0, y1 = hh - int((y_m + h_m) * ppm), hh - int(y_m * ppm)
    _shadow(tex, x0, y0, x1, y1, blur=ppm * 0.03, strength=0.26, dx=int(ppm * 0.012), dy=int(ppm * 0.03))
    cv2.rectangle(tex, (x0, y0), (x1, y1), (138, 178, 210), -1)
    fr = int(ppm * 0.022)
    cv2.rectangle(tex, (x0, y0), (x1, y1), (110, 146, 176), 1)
    cv2.rectangle(tex, (x0 + fr, y0 + fr), (x1 - fr, y1 - fr), (232, 238, 242), -1)
    m = int(ppm * 0.07)
    ax0, ay0, ax1, ay1 = x0 + fr + m, y0 + fr + m, x1 - fr - m, y1 - fr - m
    ah, aw = ay1 - ay0, ax1 - ax0
    art = np.empty((ah, aw, 3), np.float32)
    sky, far, mid, near = palette
    t = np.linspace(0, 1, ah, dtype=np.float32)[:, None, None]
    art[:] = np.array(sky, np.float32) * (1 - t * 0.25) + 22 * (1 - t)
    xs = np.linspace(0, 1, aw, dtype=np.float32)
    for colour, base, amp, freq, ph in ((far, 0.52, 0.10, 2.2, rng.uniform(0, 6)),
                                        (mid, 0.66, 0.08, 3.4, rng.uniform(0, 6)),
                                        (near, 0.82, 0.05, 5.0, rng.uniform(0, 6))):
        ridge = base + amp * np.sin(xs * freq * math.pi + ph) + 0.5 * amp * np.sin(xs * freq * 2.7 * math.pi + ph * 2)
        rows = (np.arange(ah, dtype=np.float32)[:, None] / ah) > ridge[None, :]
        art[rows] = colour
    art = cv2.GaussianBlur(art, (0, 0), 1.2)
    art += rng.standard_normal((ah, aw, 1)).astype(np.float32) * 2.0
    tex[ay0:ay1, ax0:ax1] = _to_u8(art)
    cv2.rectangle(tex, (ax0 - 1, ay0 - 1), (ax1, ay1), (206, 212, 216), 1)


def _noticeboard(tex: np.ndarray, rng: np.random.Generator, x_m: float, y_m: float, w_m: float, h_m: float) -> None:
    ppm = WALL_PPM
    hh = tex.shape[0]
    x0, x1 = int(x_m * ppm), int((x_m + w_m) * ppm)
    y0, y1 = hh - int((y_m + h_m) * ppm), hh - int(y_m * ppm)
    _shadow(tex, x0, y0, x1, y1, blur=ppm * 0.025, strength=0.24, dx=3, dy=int(ppm * 0.025))
    cv2.rectangle(tex, (x0, y0), (x1, y1), (150, 184, 210), -1)
    fr = int(ppm * 0.02)
    cork = np.empty((y1 - y0 - 2 * fr, x1 - x0 - 2 * fr, 3), np.float32)
    cork[:] = CORK
    cork += cv2.GaussianBlur(rng.standard_normal(cork.shape[:2]).astype(np.float32), (0, 0), 1.0)[..., None] * 16
    tex[y0 + fr:y1 - fr, x0 + fr:x1 - fr] = _to_u8(cork)
    # pinned sheets with lines of grey "text" (plain shapes: nothing that looks like a square code)
    for cx, cy, sw, sh, col in ((0.12, 0.10, 0.20, 0.27, (238, 240, 242)), (0.40, 0.14, 0.26, 0.18, (226, 234, 240)),
                                (0.42, 0.40, 0.20, 0.26, (236, 238, 230)), (0.74, 0.12, 0.19, 0.26, (240, 238, 234)),
                                (0.13, 0.46, 0.22, 0.16, (230, 236, 228))):
        if cx + sw > w_m or cy + sh > h_m:
            continue
        sx0, sy0 = x0 + fr + int(cx * ppm), y0 + fr + int(cy * ppm)
        sx1, sy1 = sx0 + int(sw * ppm), sy0 + int(sh * ppm)
        if sx1 >= x1 - fr or sy1 >= y1 - fr:
            continue
        _shadow(tex, sx0, sy0, sx1, sy1, blur=2.5, strength=0.18, dx=2, dy=3)
        cv2.rectangle(tex, (sx0, sy0), (sx1, sy1), col, -1)
        for k in range(4, int(sh * ppm) - 6, 7):
            if k < 14:
                cv2.line(tex, (sx0 + 6, sy0 + k + 2), (sx0 + int(sw * ppm * 0.6), sy0 + k + 2), (130, 134, 138), 2)
            else:
                end = sx0 + int(sw * ppm * rng.uniform(0.55, 0.92))
                cv2.line(tex, (sx0 + 6, sy0 + k + 4), (end, sy0 + k + 4), (182, 186, 190), 1)
        cv2.circle(tex, ((sx0 + sx1) // 2, sy0 + 5), 3, PIN, -1, cv2.LINE_AA)


# --------------------------------------------------------------------------- #
# floor, ceiling and the fine floor grain
# --------------------------------------------------------------------------- #
def _floor(rng: np.random.Generator) -> np.ndarray:
    """Oak planks running away from the station wall, low-contrast joints, baked contact shadows."""
    ppm = FLOOR_PPM
    w, h = int((X1 - X0) * ppm), int(-Z0 * ppm)
    plank_w = int(0.16 * ppm)
    tex = np.empty((h, w, 3), np.float32)
    # Grain in the planks. Kept short and gentle: seen from a few centimetres these terms are magnified
    # many times across, and long strong streaks would read as a radial smear. The fine grain that a
    # close view needs comes from the tiling grain layer (_floor_grain).
    grain = cv2.GaussianBlur(rng.standard_normal((h, w)).astype(np.float32), (0, 0), sigmaX=0.9, sigmaY=16)
    grain2 = cv2.GaussianBlur(rng.standard_normal((h, w)).astype(np.float32), (0, 0), sigmaX=2.5, sigmaY=48)
    base = np.array(OAK_FLOOR, np.float32)
    tex[:] = base
    lines = np.zeros((h, w), np.float32)
    for x in range(-plank_w // 2, w, plank_w):
        xe = min(w, x + plank_w)
        x = max(0, x)
        length = int(rng.uniform(1.0, 1.9) * ppm)
        y = -int(rng.uniform(0, length))
        while y < h:
            ye = min(h, y + length)
            ys = max(0, y)
            tone = rng.uniform(0.95, 1.04)
            tint = np.array((rng.uniform(-4, 4), rng.uniform(-3, 3), rng.uniform(-3, 5)), np.float32)
            tex[ys:ye, x:xe] = base * tone + tint
            if 0 < y < h:
                lines[y:y + 1, x:xe] = 1.0                      # butt joint
            y = ye
            length = int(rng.uniform(1.0, 1.9) * ppm)
        if x > 0:
            lines[:, x:x + 1] = 1.0                             # long joint
    fine = cv2.GaussianBlur(rng.standard_normal((h, w)).astype(np.float32), (0, 0), sigmaX=0.6, sigmaY=6)
    tex += (grain * 36.0 + grain2 * 55.0 + fine * 7.0)[..., None]
    lines = cv2.GaussianBlur(lines, (0, 0), 0.7)
    tex *= (1.0 - 0.13 * np.clip(lines * 1.6, 0, 1))[..., None]
    # light and shade (rows are the distance from the station wall, columns are x from X0)
    zs = (np.arange(h, dtype=np.float32) + 0.5) / ppm
    xs = (np.arange(w, dtype=np.float32) + 0.5) / ppm
    edge = (1.0 - 0.30 * np.exp(-zs / 0.20))[:, None] * (1.0 - 0.30 * np.exp(-(-Z0 - zs) / 0.20))[:, None] \
        * (1.0 - 0.30 * np.exp(-xs / 0.20))[None, :] * (1.0 - 0.30 * np.exp(-((X1 - X0) - xs) / 0.20))[None, :]
    pools = np.zeros((h, w), np.float32)
    for lz in LIGHT_Z:
        for lx in LIGHT_X:
            pools += np.exp(-(((xs[None, :] - (lx - X0)) / 0.95) ** 2 + ((zs[:, None] + lz) / 0.95) ** 2))
    tex *= (edge * (0.93 + 0.12 * np.clip(pools, 0, 1.2)))[..., None]
    return _to_u8(tex)


def _wrap_blur(noise: np.ndarray, sigma_x: float, sigma_y: float) -> np.ndarray:
    """Gaussian blur with wrap-around edges, so the result tiles. A short blur pads by wrapping and uses
    cv2; a long one is done in the frequency domain, where it costs the same as a short one."""
    h, w = noise.shape
    pad = int(math.ceil(4.0 * max(sigma_x, sigma_y)))
    if pad <= 16 and min(sigma_x, sigma_y) > 0:          # (cv2 reads a sigma of 0 as "same as the other")
        big = np.pad(noise, pad, mode="wrap")
        return cv2.GaussianBlur(big, (0, 0), sigmaX=sigma_x, sigmaY=sigma_y)[pad:pad + h, pad:pad + w]
    fy = np.fft.fftfreq(h)[:, None]
    fx = np.fft.rfftfreq(w)[None, :]
    kernel = np.exp(-2.0 * np.pi ** 2 * ((sigma_x * fx) ** 2 + (sigma_y * fy) ** 2))
    return np.fft.irfft2(np.fft.rfft2(noise) * kernel, s=(h, w)).astype(np.float32)


def _smoothstep(a: float, b: float, x: np.ndarray) -> np.ndarray:
    t = np.clip((x - a) / (b - a), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def _floor_grain(rng: np.random.Generator) -> np.ndarray:
    """The floor's tiling grain layer, one channel, 128 = no change: oak growth rings, pores and fibre at
    GRAIN_PPM, GRAIN_PLANKS boards wide and GRAIN_TILE_M long.

    Each board has its own rings: dark late-wood lines (a gradual edge on one side, an abrupt one on the
    other) about 2.7 to 4.9 mm apart on average (varying across the board) with a gentle wander along it. Pores are
    short dark dashes along the grain, mostly in each ring's early wood; fibre is short (about 1 mm) and a
    fine isotropic tooth breaks up the rest. Nothing in the layer is a long streak, so a floor seen from a
    few centimetres, magnified many times, shows lines and pores rather than a radial smear. The board
    edges sit where _floor puts its long joints, so the ring pattern changes at each joint."""
    ppm = GRAIN_PPM
    plank_m = int(0.16 * FLOOR_PPM) / FLOOR_PPM            # _floor's plank width (0.15625 m)
    pw = int(round(plank_m * ppm))
    w, h = pw * GRAIN_PLANKS, int(round(GRAIN_TILE_M * ppm))
    rings = np.zeros((h, w), np.float32)
    early = np.zeros((h, w), np.float32)
    for k in range(GRAIN_PLANKS):
        # ring phase p: g(u) sets the spacing across the board (pixels per ring varies a little), the
        # wander terms bend the lines together along the board and are periodic over the tile
        drift = _wrap_blur(rng.standard_normal((1, pw)).astype(np.float32), 60.0, 0.0)[0]
        spacing = rng.uniform(11.0, 20.0) * (1.0 + 0.35 * drift / (drift.std() + 1e-6))
        g = np.cumsum(1.0 / np.clip(spacing, 6.0, 30.0))[None, :]
        wander = _wrap_blur(rng.standard_normal((h, pw)).astype(np.float32), 90.0, 500.0)
        wander *= 0.9 / (wander.std() + 1e-6)
        kink = _wrap_blur(rng.standard_normal((h, pw)).astype(np.float32), 18.0, 120.0)
        kink *= 0.3 / (kink.std() + 1e-6)
        p = g + wander + kink
        f = p - np.floor(p)
        index = np.floor(p).astype(np.int64)
        strength = rng.uniform(0.3, 1.0, int(index.max() - index.min()) + 2)[index - index.min()]
        rings[:, k * pw:(k + 1) * pw] = -13.0 * _smoothstep(0.58, 0.93, f) ** 1.6 * strength
        early[:, k * pw:(k + 1) * pw] = (1.0 - _smoothstep(0.0, 0.22, f)) * (f < 0.3)
    rings = _wrap_blur(rings, 0.55, 0.55)                   # soften the abrupt late-to-early edge to ~1 px
    pores = _wrap_blur((rng.uniform(0.0, 1.0, (h, w)) < 0.014).astype(np.float32), 0.45, 3.0)
    pores = np.clip(pores * (1.8 / (pores.max() + 1e-6)), 0.0, 1.0) * (0.25 + 0.75 * early)
    fibre = _wrap_blur(rng.standard_normal((h, w)).astype(np.float32), 0.5, 3.5)
    tooth = _wrap_blur(rng.standard_normal((h, w)).astype(np.float32), 0.7, 0.7)
    layer = rings - 22.0 * pores + 3.0 * fibre / (fibre.std() + 1e-6) + 2.0 * tooth / (tooth.std() + 1e-6)
    layer -= float(layer.mean())                            # keep the layer's mean at "no change"
    # The tile starts at X0, half a plank before _floor's first long joint: shift the boards to match.
    return _to_u8(128.0 + np.roll(layer, pw // 2, axis=1))


def _ceiling(rng: np.random.Generator) -> np.ndarray:
    ppm = CEIL_PPM
    w, h = int((X1 - X0) * ppm), int(-Z0 * ppm)
    tex = np.empty((h, w, 3), np.float32)
    tex[:] = (230, 236, 239)
    tex += rng.standard_normal((h, w, 1)).astype(np.float32) * 1.2
    tile = int(0.6 * ppm)
    for x in range(0, w, tile):
        tex[:, x:x + 1] *= 0.95
    for y in range(0, h, tile):
        tex[y:y + 1, :] *= 0.95
    zs = (np.arange(h, dtype=np.float32) + 0.5) / ppm
    xs = (np.arange(w, dtype=np.float32) + 0.5) / ppm
    edge = (1.0 - 0.18 * np.exp(-zs / 0.25))[:, None] * (1.0 - 0.18 * np.exp(-(-Z0 - zs) / 0.25))[:, None] \
        * (1.0 - 0.18 * np.exp(-xs / 0.25))[None, :] * (1.0 - 0.18 * np.exp(-((X1 - X0) - xs) / 0.25))[None, :]
    tex *= (edge * 0.94)[..., None]
    glow = np.zeros((h, w), np.float32)
    panels = []
    for lz in LIGHT_Z:
        for lx in LIGHT_X:
            cx, cz = int((lx - X0) * ppm), int(-lz * ppm)
            half = int(0.3 * ppm)
            panels.append((cx - half, cz - half, cx + half, cz + half))
            cv2.rectangle(glow, (cx - half, cz - half), (cx + half, cz + half), 1.0, -1)
    glow = cv2.GaussianBlur(glow, (0, 0), ppm * 0.22)
    tex += glow[..., None] * 24.0
    tex8 = _to_u8(tex)
    for x0, y0, x1, y1 in panels:
        cv2.rectangle(tex8, (x0, y0), (x1, y1), (248, 251, 252), -1)
        cv2.rectangle(tex8, (x0, y0), (x1, y1), (204, 208, 210), 1)
    return tex8


def _sign_shadow() -> np.ndarray:
    """Multiplier mask (255 = unchanged) for the sign's soft shadow, in sign-plane pixels at SHADOW_PPM.
    Pixel (0, 0) is the sheet's top-left corner moved SHADOW_MARGIN_M left and up."""
    ppm, m = SHADOW_PPM, SHADOW_MARGIN_M
    w = int(round((A4_WIDTH_M + 2 * m) * ppm))
    h = int(round((A4_HEIGHT_M + 2 * m) * ppm))
    mask = np.zeros((h, w), np.float32)
    x0, y0 = int(round((m + 0.003) * ppm)), int(round((m + 0.008) * ppm))
    cv2.rectangle(mask, (x0, y0), (x0 + int(round(A4_WIDTH_M * ppm)) - 1, y0 + int(round(A4_HEIGHT_M * ppm)) - 1),
                  1.0, -1)
    mask = cv2.GaussianBlur(mask, (0, 0), 0.010 * ppm)
    shade = 255.0 * (1.0 - 0.30 * mask)
    return np.repeat(_to_u8(shade)[..., None], 3, axis=2)


@functools.lru_cache(maxsize=4)
def build_room(marker_height_m: float, marker_size_m: float) -> Dict[str, object]:
    """All textures of the room as mip chains. Deterministic; built once per process and sign position."""
    rng = np.random.default_rng(1234)
    sign_top = marker_height_m + marker_size_m / 2.0 + SIGN_TOP_MARGIN_M
    # keep everything on the station wall clear of the sign (front wall texture coordinates, metres)
    keep = (-A4_WIDTH_M / 2.0 - X0 - 0.35, sign_top - A4_HEIGHT_M - 0.35,
            A4_WIDTH_M / 2.0 - X0 + 0.35, sign_top + 0.35)

    def clear(x_m: float, y_m: float, w_m: float, h_m: float) -> bool:
        return not _overlaps((x_m, y_m, x_m + w_m, y_m + h_m), keep)

    front = _wall_base(rng, X1 - X0)
    _door(front, rng, x_m=6.55, number="12")
    for x_m, w_m, palette in ((2.55, 0.62, PALETTES[0]), (3.30, 0.46, PALETTES[1])):
        if clear(x_m, 1.22, w_m, 0.46):
            _print(front, rng, x_m, 1.22, w_m, 0.46, palette)
    if clear(0.55, 1.05, 1.15, 0.80):
        _noticeboard(front, rng, 0.55, 1.05, 1.15, 0.80)
    _door(front, rng, x_m=8.55, number="14")

    back = _wall_base(rng, X1 - X0)
    _door(back, rng, x_m=4.0, width_m=0.95)
    _door(back, rng, x_m=5.05, width_m=0.95)
    _print(back, rng, 1.6, 1.25, 0.7, 0.5, PALETTES[2])
    _print(back, rng, 7.6, 1.25, 0.7, 0.5, PALETTES[0])

    right = _wall_base(rng, -Z0)
    _door(right, rng, x_m=1.6, number="11")
    _print(right, rng, 3.6, 1.2, 0.9, 0.55, PALETTES[1])
    _door(right, rng, x_m=5.6, number="9")

    left = _wall_base(rng, -Z0)
    _print(left, rng, 1.2, 1.2, 0.55, 0.55, PALETTES[2])
    _door(left, rng, x_m=2.9, number="10")
    _noticeboard(left, rng, 4.8, 1.05, 1.3, 0.8)
    _print(left, rng, 6.7, 1.2, 0.55, 0.55, PALETTES[0])

    return {
        "front": _mips(front, WALL_PPM, 5), "back": _mips(back, WALL_PPM, 5),
        "right": _mips(right, WALL_PPM, 5), "left": _mips(left, WALL_PPM, 5),
        "floor": Rip(_floor(rng), FLOOR_PPM, 5, 9), "ceiling": Rip(_ceiling(rng), CEIL_PPM, 3, 7),
        "grain": Rip(_floor_grain(rng), GRAIN_PPM, 4, 9),
        "sign_shadow": _sign_shadow(),
    }


# --------------------------------------------------------------------------- #
# drawing helpers
# --------------------------------------------------------------------------- #
def _lod(levels: List[Level], wanted: np.ndarray) -> np.ndarray:
    """Continuous level of detail: 0 is the finest level, +1 halves the pixels per metre."""
    lod = np.log2(levels[0][0] / np.maximum(wanted, 1e-6))
    return np.clip(lod, 0.0, len(levels) - 1.0)


def _bands(lod: np.ndarray) -> List[Tuple[int, int, int, int, np.ndarray]]:
    """Split a monotonic run of lod values into bands of one level.

    Returns (start, end, level, blend_start, weights) per band: the band uses `level`; its entries from
    `blend_start` to `end` also fade toward the next coarser level with `weights` (0..1, over the last
    quarter of the level), so the level change is a gradual cross-fade instead of a seam.
    """
    out = []
    n = lod.size
    level = np.floor(lod).astype(np.int32)
    frac = lod - level
    weight = np.clip((frac - 0.75) * 4.0, 0.0, 1.0)
    edges = [0] + (np.flatnonzero(np.diff(level)) + 1).tolist() + [n]
    for start, end in zip(edges[:-1], edges[1:]):
        seg = np.flatnonzero(weight[start:end] > 1e-3) + start
        if seg.size:
            b0, b1 = int(seg[0]), int(seg[-1]) + 1
            out.append((start, end, int(level[start]), b0, weight[b0:b1].astype(np.float32)))
        else:
            out.append((start, end, int(level[start]), end, np.zeros(0, np.float32)))
    return out


def _rip_bands(lx_f: np.ndarray, ly_f: np.ndarray, rip: Rip) -> List[Tuple[int, int, int, int, int, np.ndarray]]:
    """Split rows into bands of one rip level.

    `lx_f` and `ly_f` are the continuous levels each row wants across and in depth. Across, the finer of
    the two neighbouring levels is used (the 2x supersampling filters what is left), so the picture is as
    sharp as the output allows and a change of level only changes sharpness below the output's own
    resolution. In depth, the band fades toward the next coarser level over the last quarter of each
    level, as `_bands` does. Returns (start, end, lx, ly, blend_start, weights) per band."""
    lx = np.clip(np.floor(lx_f), 0, rip.max_lx).astype(np.int32)
    ly_c = np.clip(ly_f, lx, rip.max_ly)
    ly = np.minimum(np.floor(ly_c), rip.max_ly).astype(np.int32)
    weight = np.clip((ly_c - ly - 0.75) * 4.0, 0.0, 1.0).astype(np.float32)
    weight[ly >= rip.max_ly] = 0.0
    key = lx * 64 + ly
    edges = [0] + (np.flatnonzero(np.diff(key)) + 1).tolist() + [key.size]
    out = []
    for start, end in zip(edges[:-1], edges[1:]):
        seg = np.flatnonzero(weight[start:end] > 1e-3) + start
        if seg.size:
            b0, b1 = int(seg[0]), int(seg[-1]) + 1
            out.append((start, end, int(lx[start]), int(ly[start]), b0, weight[b0:b1]))
        else:
            out.append((start, end, int(lx[start]), int(ly[start]), end, np.zeros(0, np.float32)))
    return out


def _draw_rows_rip(dst: np.ndarray, row0: int, lx_f: np.ndarray, ly_f: np.ndarray, rip: Rip,
                   h_of: Callable[[int, int], np.ndarray], border: int = cv2.BORDER_TRANSPARENT) -> None:
    """Draw a horizontal plane into rows row0 .. row0 + len(lx_f) of dst, one rip level per band of rows.
    `h_of(lx, ly)` maps that level's texture pixels to dst pixels (row 0 = dst row 0)."""
    width = dst.shape[1]
    for start, end, lx, ly, b0, weights in _rip_bands(lx_f, ly_f, rip):
        r0, r1 = row0 + start, row0 + end
        cv2.warpPerspective(rip.levels[(lx, ly)], _shift(h_of(lx, ly), 0, r0), (width, r1 - r0), dst=dst[r0:r1],
                            flags=cv2.INTER_LINEAR, borderMode=border)
        if weights.size:
            c0, c1 = row0 + b0, row0 + b0 + weights.size
            other = dst[c0:c1].copy()
            cv2.warpPerspective(rip.levels[(lx, ly + 1)], _shift(h_of(lx, ly + 1), 0, c0), (width, c1 - c0),
                                dst=other, flags=cv2.INTER_LINEAR, borderMode=border)
            _blend_into(dst[c0:c1], other, weights, axis=0)


def _blend_into(dst: np.ndarray, src: np.ndarray, weights: np.ndarray, axis: int) -> None:
    """dst += (src - dst) * w, with one weight per row (axis 0) or per column (axis 1)."""
    h, w = dst.shape[:2]
    shaped = weights[:, None] if axis == 0 else weights[None, :]
    wsrc = np.ascontiguousarray(np.broadcast_to(shaped, (h, w)), dtype=np.float32)
    mixed = cv2.blendLinear(src, np.ascontiguousarray(dst), wsrc, 1.0 - wsrc)
    dst[...] = mixed


def _shift(h: np.ndarray, dx: float, dy: float) -> np.ndarray:
    return np.array([[1.0, 0.0, -dx], [0.0, 1.0, -dy], [0.0, 0.0, 1.0]]) @ h


def _draw_columns(dst: np.ndarray, col0: int, lod: np.ndarray, levels: List[Level],
                  h_of: Callable[[float], np.ndarray], top: np.ndarray, bottom: np.ndarray) -> None:
    """Draw a wall into columns col0 .. col0 + len(lod) of dst, a mip level per band of columns.

    `top` and `bottom` give, per column, the image rows of the wall's upper and lower edges: each band
    is only warped over the rows the wall can cover there."""
    height = dst.shape[0]
    for start, end, level, b0, weights in _bands(lod):
        c0, c1 = col0 + start, col0 + end
        r0 = max(0, int(math.floor(float(top[start:end].min()))) - 2)
        r1 = min(height, int(math.ceil(float(bottom[start:end].max()))) + 3)
        if r1 <= r0:
            continue
        ppm, tex = levels[level]
        part = np.ascontiguousarray(dst[r0:r1, c0:c1])
        cv2.warpPerspective(tex, _shift(h_of(ppm), c0, r0), (c1 - c0, r1 - r0), dst=part,
                            flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_TRANSPARENT)
        if weights.size and level + 1 < len(levels):
            k0, k1 = b0 - start, b0 - start + weights.size
            ppm2, tex2 = levels[level + 1]
            other = np.ascontiguousarray(part[:, k0:k1])
            cv2.warpPerspective(tex2, _shift(h_of(ppm2), col0 + b0, r0), (k1 - k0, r1 - r0), dst=other,
                                flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_TRANSPARENT)
            _blend_into(part[:, k0:k1], other, weights, axis=1)
        dst[r0:r1, c0:c1] = part


# --------------------------------------------------------------------------- #
class RoomRenderer:
    """Renders the room from a camera snapshot. Camera maths match the plain scene in sim.py: a level
    pinhole camera with focal = (width / 2) / tan(hfov / 2) and the principal point at the centre."""

    def __init__(self, cfg, focal: float, sign_levels: List[Level], sign_left_x: float, sign_top_y: float,
                 rng: np.random.Generator) -> None:
        self.cfg = cfg
        ss = max(1, int(cfg.supersample))
        self._ss = ss
        self._rw, self._rh = cfg.width * ss, cfg.height * ss
        self._rf = focal * ss
        # Output pixel i averages render pixels ss*i .. ss*i + ss - 1, whose centre is ss*i + (ss - 1) / 2,
        # so the principal point moves by that half-pixel to keep the geometry identical to the output K.
        self._cx = cfg.width / 2.0 * ss + (ss - 1) / 2.0
        self._cy = cfg.height / 2.0 * ss + (ss - 1) / 2.0
        self._RK = np.array([[self._rf, 0.0, self._cx], [0.0, self._rf, self._cy], [0.0, 0.0, 1.0]])
        self._room = build_room(float(cfg.marker_height_m), float(cfg.marker_size_m))
        self._sign_levels = sign_levels
        self._sign_left_x = sign_left_x
        self._sign_top_y = sign_top_y

        self._cols = np.arange(self._rw, dtype=np.float64) - self._cx
        self._floor_rows = np.arange(int(math.floor(self._cy)) + 1, self._rh)
        self._ceil_rows = np.arange(0, int(math.ceil(self._cy)))

        width, height = cfg.width, cfg.height
        self._vignette: Optional[np.ndarray] = None
        if cfg.vignette > 0:
            yy, xx = np.mgrid[0:height, 0:width].astype(np.float32)
            r2 = ((xx + 0.5 - width / 2.0) / (width / 2.0)) ** 2 + ((yy + 0.5 - height / 2.0) / (width / 2.0)) ** 2
            vig = 1.0 - float(cfg.vignette) * np.clip(r2 / 1.32, 0, 1) ** 1.3
            self._vignette = np.repeat(_to_u8(vig * 255.0)[..., None], 3, axis=2)
        self._noise: List[Tuple[np.ndarray, np.ndarray]] = []
        if cfg.sensor_noise > 0:
            for _ in range(6):
                n = rng.normal(0.0, cfg.sensor_noise, (height, width, 1))
                n = np.repeat(n, 3, axis=2) + rng.normal(0.0, cfg.sensor_noise * 0.35, (height, width, 3))
                self._noise.append((_to_u8(n), _to_u8(-n)))
        self._canvas_bg = np.empty((self._rh, self._rw, 3), np.uint8)
        self._canvas_bg[:] = (60, 64, 66)

    # ------------------------------------------------------------------ #
    def render(self, snap: dict, rng: np.random.Generator) -> np.ndarray:
        cfg = self.cfg
        rw, rh, rf = self._rw, self._rh, self._rf
        heading = snap["heading"]
        sin_h, cos_h = math.sin(heading), math.cos(heading)
        cam = np.array([snap["x"], snap["cam_y"], snap["z"]], dtype=np.float64)
        rot = np.array([[cos_h, 0.0, -sin_h], [0.0, -1.0, 0.0], [sin_h, 0.0, cos_h]])
        kr = self._RK @ rot
        canvas = self._canvas_bg.copy()

        def plane(origin, eu, ev) -> Callable[[float], np.ndarray]:
            o = np.asarray(origin, np.float64) - cam
            u, v = np.asarray(eu, np.float64), np.asarray(ev, np.float64)
            return lambda ppm: kr @ np.column_stack([u / ppm, v / ppm, o])

        def flat(origin, rip: Rip, row0: int) -> Callable[[int, int], np.ndarray]:
            """Homography of a horizontal plane (u = +x, v = -z) for rip level (lx, ly), shifted so that
            canvas row `row0` is row 0. Texel j of a level averages level-0 texels s*j .. s*j + s - 1, so
            its centre sits (s - 1) / 2 level-0 texels further on: levels line up exactly."""
            o = np.asarray(origin, np.float64) - cam
            u, v = np.array([1.0, 0.0, 0.0]), np.array([0.0, 0.0, -1.0])
            ppm = rip.ppm

            def h(lx: int, ly: int) -> np.ndarray:
                su, sv = float(2 ** lx), float(2 ** ly)
                shift = o + u * (su - 1.0) / (2.0 * ppm) + v * (sv - 1.0) / (2.0 * ppm)
                return _shift(kr @ np.column_stack([u * su / ppm, v * sv / ppm, shift]), 0, row0)
            return h

        # ---- which rows the walls leave for the floor and the ceiling ----
        toward_front = -self._cols * sin_h + rf * cos_h
        toward_right = self._cols * cos_h + rf * sin_h
        walls = (
            ("back", (X1, ROOM_H, Z0), (-1, 0, 0), -toward_front, cam[2] - Z0),
            ("left", (X0, ROOM_H, Z0), (0, 0, 1), -toward_right, cam[0] - X0),
            ("right", (X1, ROOM_H, 0.0), (0, 0, -1), toward_right, X1 - cam[0]),
            ("front", (X0, ROOM_H, 0.0), (1, 0, 0), toward_front, -cam[2]),
        )
        # In each column the visible wall is the nearest one, at camera depth f / max(toward / dist); its
        # edges are at cy -/+ height * that ratio. The floor and the ceiling are only drawn in the rows
        # some column can show them (plus a margin), not under the walls.
        nearest = np.zeros(rw)
        for _name, _origin, _eu, toward, dist in walls:
            seen = toward > 1e-3 * rf
            np.maximum(nearest, np.where(seen, toward / max(0.05, float(dist)), 0.0), out=nearest)
        reach = float(nearest.min())
        floor_rows, ceil_rows = self._floor_rows, self._ceil_rows
        if reach > 0:
            floor_rows = floor_rows[floor_rows >= self._cy + float(cam[1]) * reach - 3]
            ceil_rows = ceil_rows[ceil_rows <= self._cy - (ROOM_H - float(cam[1])) * reach + 3]

        # ---- floor, then its tiling grain where the floor is near enough to show it ----
        # For a level camera, floor row dv below the horizon is at depth cam_y * f / dv: across it holds
        # dv / cam_y pixels per metre, in depth (foreshortened) dv^2 / (f * cam_y).
        cam_y = max(0.02, float(cam[1]))
        rows = floor_rows
        if rows.size:
            row0 = int(rows[0])
            dv = rows - self._cy
            across = dv / cam_y
            along = dv * dv / (rf * cam_y)
            floor = self._room["floor"]
            _draw_rows_rip(canvas, row0, np.log2(floor.ppm / across), np.log2(floor.ppm / along) + DEPTH_LOD_BIAS,
                           floor, flat((X0, 0.0, 0.0), floor, 0))
            self._draw_grain(canvas, row0, across, along, flat)

        # ---- ceiling ----
        rows = ceil_rows
        if rows.size:
            lift = max(0.05, ROOM_H - float(cam[1]))
            dv = self._cy - rows
            ceiling = self._room["ceiling"]
            _draw_rows_rip(canvas, int(rows[0]), np.log2(ceiling.ppm / (dv / lift)),
                           np.log2(ceiling.ppm / (dv * dv / (rf * lift))) + DEPTH_LOD_BIAS,
                           ceiling, flat((X0, ROOM_H, 0.0), ceiling, 0))

        # ---- walls ----
        for name, origin, eu, toward, dist in walls:
            cols = np.flatnonzero(toward > 1e-3 * rf)
            if cols.size == 0:
                continue
            c0, c1 = int(cols[0]), int(cols[-1]) + 1
            dist = max(0.05, float(dist))
            t = toward[c0:c1]
            wanted = np.power(np.maximum(t, 1e-6), 1.5) / (dist * math.sqrt(rf)) * LOD_BIAS
            levels = self._room[name]
            # a level camera sees the wall's top and bottom edges at these rows in each column
            top = self._cy - (ROOM_H - float(cam[1])) * t / dist
            bottom = self._cy + float(cam[1]) * t / dist
            _draw_columns(canvas, c0, _lod(levels, wanted), levels, plane(origin, eu, (0, -1, 0)), top, bottom)
            if name == "front" and not snap["marker_hidden"]:
                self._draw_sign(canvas, kr, cam, rot, (c0, c1))

        # ---- lens and sensor ----
        if self._ss > 1:
            canvas = cv2.resize(canvas, (cfg.width, cfg.height), interpolation=cv2.INTER_AREA)
        if cfg.blur_sigma > 0:
            canvas = cv2.GaussianBlur(canvas, (0, 0), cfg.blur_sigma)
        if self._vignette is not None:
            canvas = cv2.multiply(canvas, self._vignette, scale=float(cfg.light) / 255.0)
        elif cfg.light != 1.0:
            canvas = cv2.convertScaleAbs(canvas, alpha=float(cfg.light))
        if self._noise:
            plus, minus = self._noise[int(rng.integers(len(self._noise)))]
            canvas = cv2.subtract(cv2.add(canvas, plus), minus)
        return canvas

    # ------------------------------------------------------------------ #
    def _draw_grain(self, canvas: np.ndarray, row0: int, across: np.ndarray, along: np.ndarray,
                    flat: Callable[..., Callable[[int, int], np.ndarray]]) -> None:
        """Multiply the tiling grain layer into the floor rows (128 = no change).

        It fades in where the floor holds at least about 128 px per metre in depth, or about 700 px per
        metre across (so on the ground even the far floor keeps a crisp grain across the planks). In
        normal flight that is only the bottom of the frame; nothing is drawn where it would not show."""
        rip = self._room["grain"]
        lx_f = np.log2(rip.ppm / across)
        fade = np.maximum(np.clip((3.0 - np.log2(DETAIL_PPM / along)) * 2.0, 0.0, 1.0),
                          np.clip(2.5 - lx_f, 0.0, 1.0))
        used = np.flatnonzero(fade > 1e-3)
        if used.size == 0:
            return
        a, b = int(used[0]), int(used[-1]) + 1
        grain = np.full((b - a, canvas.shape[1]), 128, np.uint8)
        _draw_rows_rip(grain, 0, lx_f[a:b], np.log2(rip.ppm / along[a:b]) + DEPTH_LOD_BIAS, rip,
                       flat((X0, 0.0, 0.0), rip, row0 + a), border=cv2.BORDER_WRAP)
        if np.any(fade[a:b] < 1.0):
            _blend_into(grain, np.full_like(grain, 128), 1.0 - fade[a:b].astype(np.float32), axis=0)
        region = canvas[row0 + a:row0 + b]
        cv2.multiply(region, cv2.cvtColor(grain, cv2.COLOR_GRAY2BGR), dst=region, scale=1.0 / 128.0)

    def _draw_sign(self, canvas: np.ndarray, kr: np.ndarray, cam: np.ndarray, rot: np.ndarray,
                   columns: Tuple[int, int]) -> None:
        """The station sign and its soft shadow, warped only into the sign's own patch of the frame."""
        cfg = self.cfg
        centre = np.array([0.0, cfg.marker_height_m, 0.0]) - cam
        depth = float(rot[2] @ centre)
        if depth <= 0.05:
            return
        m = SHADOW_MARGIN_M
        left, top = self._sign_left_x - m, self._sign_top_y + m
        corners = np.array([[left, top, 0.0], [left + A4_WIDTH_M + 2 * m, top, 0.0],
                            [left, top - A4_HEIGHT_M - 2 * m, 0.0],
                            [left + A4_WIDTH_M + 2 * m, top - A4_HEIGHT_M - 2 * m, 0.0]]) - cam
        proj = (kr @ corners.T)
        c0, c1 = columns
        if np.all(proj[2] > 1e-3 * self._rf):
            xs, ys = proj[0] / proj[2], proj[1] / proj[2]
            x0, x1 = max(c0, int(math.floor(xs.min())) - 2), min(c1, int(math.ceil(xs.max())) + 3)
            y0, y1 = max(0, int(math.floor(ys.min())) - 2), min(self._rh, int(math.ceil(ys.max())) + 3)
        else:
            x0, x1, y0, y1 = c0, c1, 0, self._rh
        if x1 <= x0 or y1 <= y0:
            return
        patch = np.ascontiguousarray(canvas[y0:y1, x0:x1])

        def h_at(origin, ppm):
            o = np.asarray(origin, np.float64) - cam
            h = kr @ np.column_stack([np.array([1.0, 0.0, 0.0]) / ppm, np.array([0.0, -1.0, 0.0]) / ppm, o])
            return _shift(h, x0, y0)

        shade = cv2.warpPerspective(self._room["sign_shadow"], h_at((left, top, 0.0), SHADOW_PPM),
                                    (x1 - x0, y1 - y0), flags=cv2.INTER_LINEAR,
                                    borderMode=cv2.BORDER_CONSTANT, borderValue=(255, 255, 255))
        cv2.multiply(patch, shade, dst=patch, scale=1.0 / 255.0)
        wanted = self._rf / depth * 1.1
        sppm, sheet = self._sign_levels[0]
        for level_ppm, level in self._sign_levels:
            if level_ppm >= wanted:
                sppm, sheet = level_ppm, level
        cv2.warpPerspective(sheet, h_at((self._sign_left_x, self._sign_top_y, 0.0), sppm), (x1 - x0, y1 - y0),
                            dst=patch, flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_TRANSPARENT)
        canvas[y0:y1, x0:x1] = patch
