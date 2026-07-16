"""Generate a 48x48 Netscape-style throbber GIF: dithered spinning globe + orbiting comet."""

import math
import random

from PIL import Image

SIZE = 48
FRAMES = 12
DELAY_MS = 100
GLOBE_R = 13  # globe radius in px
GLOBE_CX, GLOBE_CY = 24, 22  # centered slightly high

# --- Palette (90s web-safe leaning) ---
BG = (0, 0, 33)  # near-black navy
OCEAN_LIT = (51, 102, 204)
OCEAN_MID = (0, 51, 153)
OCEAN_DARK = (0, 0, 102)
LAND_LIT = (51, 204, 102)
LAND_MID = (0, 153, 51)
LAND_DARK = (0, 102, 51)
STAR_BRIGHT = (255, 255, 255)
STAR_DIM = (153, 153, 153)
COMET_HEAD = (255, 255, 255)
COMET_HEAD2 = (255, 255, 102)
COMET_TAIL = [(255, 255, 153), (255, 204, 51), (255, 153, 0), (204, 102, 0), (153, 51, 0)]

# 4x4 Bayer matrix, normalized to [0,1) — fixed across frames so dither doesn't shimmer
BAYER = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
]


def bayer(x, y):
    return (BAYER[y % 4][x % 4] + 0.5) / 16.0


# --- Tileable continent map (blobby noise, wraps horizontally) ---
MAP_W, MAP_H = 96, 32
random.seed(911)
_blobs = []
for _ in range(26):
    bx = random.uniform(0, MAP_W)
    by = random.uniform(4, MAP_H - 4)
    br = random.uniform(2.5, 7.5)
    _blobs.append((bx, by, br))


def is_land(u, v):
    """u in [0, MAP_W), v in [0, MAP_H). Wraps in u."""
    for bx, by, br in _blobs:
        dx = min(abs(u - bx), MAP_W - abs(u - bx))  # horizontal wrap
        dy = v - by
        if dx * dx + dy * dy * 2.2 < br * br:  # squash vertically -> long continents
            return True
    return False


# --- Stars (fixed positions, some twinkle) ---
random.seed(2001)
STARS = []
while len(STARS) < 11:
    sx, sy = random.randrange(1, SIZE - 1), random.randrange(1, SIZE - 1)
    dx, dy = sx - GLOBE_CX, sy - GLOBE_CY
    if dx * dx + dy * dy > (GLOBE_R + 4) ** 2:  # keep clear of the globe
        STARS.append((sx, sy, random.random() < 0.4))  # third field = twinkles


# --- Comet orbit: tilted ellipse around the globe ---
ORBIT_A, ORBIT_B = 20.0, 10.0  # semi-axes
ORBIT_TILT = math.radians(-18)


def comet_pos(t):
    """t in [0,1). Returns (x, y, in_front). Front on lower arc, behind on upper."""
    ang = 2 * math.pi * t
    ex, ey = ORBIT_A * math.cos(ang), ORBIT_B * math.sin(ang)
    x = GLOBE_CX + ex * math.cos(ORBIT_TILT) - ey * math.sin(ORBIT_TILT)
    y = GLOBE_CY + ex * math.sin(ORBIT_TILT) + ey * math.cos(ORBIT_TILT)
    return x, y, math.sin(ang) > 0  # sin>0 -> lower half -> in front


def shade_globe_pixel(px, py, frame):
    """Return color for a pixel inside the globe, or None if outside."""
    dx, dy = px - GLOBE_CX, py - GLOBE_CY
    rr = dx * dx + dy * dy
    if rr > GLOBE_R * GLOBE_R:
        return None
    # Sphere surface normal -> longitude/latitude
    nz = math.sqrt(max(0.0, GLOBE_R * GLOBE_R - rr)) / GLOBE_R
    nx, ny = dx / GLOBE_R, dy / GLOBE_R
    lon = math.atan2(nx, nz)  # [-pi/2, pi/2] visible hemisphere
    lat = math.asin(max(-1.0, min(1.0, ny)))
    # Scroll texture west->east; one full map width per loop for a seamless cycle
    u = (lon / math.pi + 0.5) * (MAP_W / 2.0) + (frame / FRAMES) * MAP_W
    v = (lat / (math.pi / 2) * 0.5 + 0.5) * (MAP_H - 1)
    land = is_land(u % MAP_W, v)
    # Left-lit lambert shading, quantized to 3 bands via stable Bayer dither
    light = max(0.0, -0.55 * nx - 0.2 * ny + 0.8 * nz)
    band = light + (bayer(px, py) - 0.5) * 0.45
    if land:
        return LAND_LIT if band > 0.62 else (LAND_MID if band > 0.3 else LAND_DARK)
    return OCEAN_LIT if band > 0.62 else (OCEAN_MID if band > 0.3 else OCEAN_DARK)


def putpix(img, x, y, color):
    if 0 <= x < SIZE and 0 <= y < SIZE:
        img.putpixel((x, y), color)


def draw_comet(img, frame, layer):
    """layer: 'front' or 'behind'. Tail = older positions along the orbit."""
    t = frame / FRAMES
    head_x, head_y, head_front = comet_pos(t)
    # Tail segments trail the head
    for i, col in reversed(list(enumerate(COMET_TAIL, start=1))):
        tx, ty, tf = comet_pos((t - i * 0.035) % 1.0)
        if (tf and layer == "front") or (not tf and layer == "behind"):
            putpix(img, round(tx), round(ty), col)
    if (head_front and layer == "front") or (not head_front and layer == "behind"):
        hx, hy = round(head_x), round(head_y)
        for ox, oy in ((0, 0), (1, 0), (0, 1), (1, 1)):
            putpix(img, hx + ox, hy + oy, COMET_HEAD)
        putpix(img, hx - 1, hy, COMET_HEAD2)
        putpix(img, hx + 2, hy + 1, COMET_HEAD2)


def render_frame(frame, comet=True):
    img = Image.new("RGB", (SIZE, SIZE), BG)
    # Stars (twinklers alternate every 3 frames)
    for sx, sy, twinkles in STARS:
        col = STAR_DIM if (twinkles and (frame // 3) % 2) else STAR_BRIGHT
        img.putpixel((sx, sy), col)
    if comet:
        draw_comet(img, frame, "behind")
    for py in range(SIZE):
        for px in range(SIZE):
            c = shade_globe_pixel(px, py, frame)
            if c:
                img.putpixel((px, py), c)
    if comet:
        draw_comet(img, frame, "front")
    return img


def main():
    frames = [render_frame(f) for f in range(FRAMES)]
    quantized = [f.quantize(colors=32, dither=Image.Dither.NONE) for f in frames]
    quantized[0].save(
        "throbber.gif",
        save_all=True,
        append_images=quantized[1:],
        duration=DELAY_MS,
        loop=0,
        optimize=False,
    )
    # Static idle companion: same globe, no comet, non-twinkle star state
    still = render_frame(0, comet=False).quantize(colors=32, dither=Image.Dither.NONE)
    still.save("throbber-static.gif", optimize=False)
    # 8x contact sheet for review
    scale = 8
    sheet = Image.new("RGB", (SIZE * scale * 6, SIZE * scale * 2), (64, 64, 64))
    for i, f in enumerate(frames):
        big = f.resize((SIZE * scale, SIZE * scale), Image.Resampling.NEAREST)
        sheet.paste(big, ((i % 6) * SIZE * scale, (i // 6) * SIZE * scale))
    sheet.save("throbber_sheet.png")
    print("wrote throbber.gif + throbber-static.gif + throbber_sheet.png")


if __name__ == "__main__":
    main()
