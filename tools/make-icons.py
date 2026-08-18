#!/usr/bin/env python3
# =============================================================================
# SUPERMINE ADVENTURE — tools/make-icons.py
# -----------------------------------------------------------------------------
# ASSET GENERATOR. NOT PART OF THE GAME AND NOT PART OF ANY BUILD STEP.
#
# The game itself is still plain HTML/CSS/JS with no build, no libraries and no
# network: it never runs Python and it never imports anything this file touches.
# This script exists only to (re)generate the three PNGs in ../icons/ offline,
# on a developer machine, and to keep that art in version control as CODE rather
# than as three opaque binaries nobody can edit.
#
#   python3 tools/make-icons.py            # writes ../icons/*.png
#
# Requires Pillow (developed against 11.3). Nothing else. If Pillow is missing,
# do NOT add it to the game — install it locally, or leave the icons alone.
#
# -----------------------------------------------------------------------------
# THE MARK — "the light going down"
#
# SUPERMINE (the 60-second time attack) is drilling: its icon is one big machine
# filling the frame, boring straight at you, hazard stripes at the bottom edge.
# ADVENTURE is the same world seen from much further away. The signature of this
# game is not the machine, it is DARKNESS AND WHAT THE HEADLIGHT FINDS IN IT, so
# the icon inverts its sibling deliberately:
#
#   * the rig is SMALL and sits at the top, a tracked block with the same grey
#     hull, the same cyan viewport and the same amber band — the family resemblance
#   * the HEADLIGHT CONE is the mark: a wide warm wedge falling away downward and
#     dissolving into black, which is what every minute of this game looks like
#   * the rock is drawn TWICE — once nearly black, once warm and bright — and the
#     bright copy is masked by the cone. That is not a gradient trick for its own
#     sake: it is literally how the game renders (effects.renderDarkness composites
#     a light pool over a dark world), so the icon is made the way the game is
#   * HORIZONTAL STRATA cross the cone. Levels are sealed bands of rock in this
#     game and the lift is the only way between them; the bands say "depth" and
#     "there is more below this" in one shape
#   * ORE GLINTS — gold, and one cyan — sit in the rock and only catch fire where
#     the beam reaches them. Off-beam ore is drawn too, almost invisibly: there is
#     always more out there than the lamp is showing you
#
# COLOUR IS DELIBERATELY SHARED WITH THE APP. The bottom of the icon's background
# gradient is exactly #0b0a0d — the canvas clear colour in js/main.js, --sm-bg in
# style.css, and theme_color/background_color in the manifest. The icon's deepest
# rock and the app's background are the same black on purpose: an installed PWA
# fades from the splash into the game with no seam.
#
# LEGIBILITY RULES THIS ART OBEYS
#   * no text anywhere, no line thinner than ~4 design units (≈1.5 px at 192)
#   * one dominant silhouette (the wedge) that survives being shrunk to 48 px
#   * ore glints and strata are TEXTURE: they may vanish at 48 px, and do, and the
#     icon still reads. Nothing load-bearing is smaller than the rig's hull.
#
# HOW IT IS DRAWN
#   Everything is composited at SS× the 512 design canvas and downsampled with
#   LANCZOS, so every edge is antialiased without a single ImageDraw AA hack.
#   All geometry is written in 512-unit DESIGN COORDINATES and pushed through
#   `View`, which scales about the centre. That is what makes the maskable
#   variant a one-line change: same drawing, scale 0.74, full-bleed background,
#   no rounded corners — everything that matters lands inside the 80% safe circle.
# =============================================================================

import math
import os
import random

from PIL import Image, ImageChops, ImageDraw, ImageFilter

# -----------------------------------------------------------------------------
# Output
# -----------------------------------------------------------------------------
HERE = os.path.dirname(os.path.abspath(__file__))
ICON_DIR = os.path.join(os.path.dirname(HERE), 'icons')

DESIGN = 512      # every coordinate below is in this space
SS = 4            # supersample factor; 512 * 4 = 2048 px working canvas

# =============================================================================
# Palette
# =============================================================================
BG_TOP = '#191c22'     # cleared rock at the top of the frame
BG_BOT = '#0b0a0d'     # == --sm-bg == the canvas clear colour. Not a coincidence.

# The rock, unlit. Barely above the background — this is the "darkness" half.
ROCK_DIM = {
    'bands': ['#15171d', '#121419', '#0f1115', '#0c0d11', '#0a0b0e'],
    'edge':  '#1d2129',
    'shard': ('#101218', '#0c0e12'),
    'ore':   0.13,            # how much of the ore's real colour survives unlit
}

# The same rock under the lamp. Warm, because the headlight is warm — but kept
# MID-TONE on purpose. An earlier pass ran these near white and the lit region
# turned into a shapeless amber fog: the strata edges had nothing left to sit
# against. Rock in a headlight is brown, not bright.
ROCK_LIT = {
    'bands': ['#8a7048', '#6d5836', '#7d6640', '#54452c', '#3b3020'],
    'edge':  '#f0d79c',
    'shard': ('#9d8459', '#5d4c31'),
    'ore':   1.0,
}

ORE_COLORS = {
    'gold':  (255, 203, 49),    # materials.js gold
    'cyan':  (72, 188, 255),    # materials.js sapphire
    'green': (51, 221, 128),    # materials.js emerald
}

# =============================================================================
# Geometry — design coordinates (0..512, +y is DOWN, as in the game)
# =============================================================================

# The rig. Small on purpose: this game is about the dark, not the machine.
# CHASSIS is a single dark body under both tracks and the hull — without it the
# tracks float either side of the block and read as two barcodes.
CHASSIS = (104, 124, 408, 236)
HULL = (162, 116, 350, 240)          # x0, y0, x1, y1
HULL_R = 26
TRACK_L = (100, 128, 156, 232)
TRACK_R = (356, 128, 412, 232)
VIEWPORT = (226, 138, 286, 178)
BAND = (170, 188, 342, 206)          # the amber band, straight off the sibling
# ONE light bar, not a pair. Two lamp housings at this size read as teeth, and
# a mouth is the last thing this silhouette needs.
LAMP = (196, 220, 316, 238)

# The cone. Apex spans the lamp bar; it opens to well past the frame edge so
# there is never a visible "end of beam" — it dies by fading, not by stopping.
BEAM_APEX_Y = 240
BEAM_POLY = [(190, BEAM_APEX_Y), (322, BEAM_APEX_Y), (470, 560), (42, 560)]
# A hot core inside the cone. A single flat wedge lights the rock evenly and the
# result reads as sand; a lamp has a bright middle and dimmer edges, and that
# alone is what stops the lit area from going flat.
BEAM_CORE = [(214, BEAM_APEX_Y), (298, BEAM_APEX_Y), (382, 560), (130, 560)]

# Rock strata. Each entry is the y of a band's TOP edge; bands are painted top
# down, each one covering everything below it, so only the top edges show.
# The first one is kept well clear of the beam's apex: put it right under the
# lamp and its lit edge draws one hard bright line across the whole cone, and
# the rig ends up looking like it is parked on a table.
BAND_TOPS = [284, 336, 388, 436, 482]

# Ore bodies: (x, y, radius, colour). The first three sit inside the cone and
# are the ones that light up; the rest are outside it, or too deep for the lamp
# to reach, and stay nearly black. Four is already the ceiling — a fifth glint
# turns the mark into a sticker.
ORE = [
    (178, 368, 23, 'gold'),
    (330, 330, 20, 'cyan'),
    (268, 430, 18, 'gold'),
    (96,  306, 19, 'gold'),
    (438, 322, 16, 'green'),
    (206, 486, 15, 'gold'),
]


# =============================================================================
# Small helpers
# =============================================================================
def rgb(h):
    h = h.lstrip('#')
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def mix(a, b, t):
    return tuple(int(round(a[i] + (b[i] - a[i]) * t)) for i in range(3))


class View:
    """Design coordinates -> canvas pixels, scaled about the centre.

    Scale is the ONLY difference between the plain icon and the maskable one:
    at 0.74 the whole composition retreats inside the 80% safe circle while the
    background keeps bleeding to all four edges.
    """

    def __init__(self, scale, px):
        self.s = scale * (px / float(DESIGN))
        self.c = px / 2.0
        self.px = px

    def p(self, x, y):
        return (self.c + (x - DESIGN / 2.0) * self.s,
                self.c + (y - DESIGN / 2.0) * self.s)

    def n(self, v):
        """A length."""
        return max(1.0, v * self.s)

    def box(self, b):
        x0, y0 = self.p(b[0], b[1])
        x1, y1 = self.p(b[2], b[3])
        return [x0, y0, x1, y1]

    def poly(self, pts):
        return [self.p(x, y) for x, y in pts]

    def inv_y(self, cy):
        """Canvas row -> design y. Used to build gradients in design space."""
        return DESIGN / 2.0 + (cy - self.c) / self.s


def ramp(view, size, stops):
    """A full-canvas vertical RGBA gradient whose stops are DESIGN y values.

    Built one pixel column tall and stretched, which is both exact and instant —
    a per-pixel loop over a 2048² canvas is not.
    """
    w, h = size
    strip = Image.new('RGBA', (1, h))
    px = strip.load()
    for cy in range(h):
        px[0, cy] = _sample(stops, view.inv_y(cy + 0.5))
    return strip.resize((w, h), Image.NEAREST)


def _sample(stops, y):
    if y <= stops[0][0]:
        return stops[0][1]
    if y >= stops[-1][0]:
        return stops[-1][1]
    for i in range(len(stops) - 1):
        y0, c0 = stops[i]
        y1, c1 = stops[i + 1]
        if y0 <= y <= y1:
            t = 0.0 if y1 == y0 else (y - y0) / float(y1 - y0)
            return tuple(int(round(c0[k] + (c1[k] - c0[k]) * t)) for k in range(4))
    return stops[-1][1]


def masked(paint, mask):
    """Multiply an RGBA layer's alpha by an L mask."""
    out = paint.copy()
    out.putalpha(ImageChops.multiply(out.getchannel('A'), mask))
    return out


def add_light(base, layer):
    """Composite `layer` ADDITIVELY onto an opaque base.

    Headlights, glints and glows are light, and light adds. Alpha compositing a
    warm wedge over dark rock greys it out; adding it makes the rock glow, which
    is the entire point of the mark. `base` is always fully opaque here — the
    rounded-corner alpha is applied once, at the very end.
    """
    a = layer.getchannel('A')
    prem = Image.merge('RGB', [
        ImageChops.multiply(layer.getchannel(c), a) for c in ('R', 'G', 'B')
    ])
    return ImageChops.add(base.convert('RGB'), prem).convert('RGBA')


# The rock is generated well OUTSIDE the 0..512 design frame. The maskable
# variant shrinks the whole composition about the centre, so geometry that only
# just reached the design edge leaves a bare gutter down both sides of the
# canvas — and a rectangle of rock floating on the background is exactly what a
# full-bleed icon must not have. These bounds cover scales down to ~0.55.
OVERSCAN_X = (-160.0, 672.0)
OVERSCAN_Y = 800.0


def jag_edge(seed, y, amp=7.0, step=44.0):
    """A rough horizontal rock edge, spanning the overscanned width."""
    rnd = random.Random(seed)
    pts = []
    x = OVERSCAN_X[0]
    while x < OVERSCAN_X[1]:
        pts.append((x, y + rnd.uniform(-amp, amp)))
        x += step * rnd.uniform(0.7, 1.3)
    pts.append((OVERSCAN_X[1], y + rnd.uniform(-amp, amp)))
    return pts


def shards(seed=1207):
    """Angular rubble scattered over the rock face. Fixed seed => fixed art.

    The last dozen are thrown up the LEFT AND RIGHT EDGES above the rock line —
    the walls of the space the rig is sitting in. They are outside the cone, so
    the lit pass never reveals them; all they do is stop the top third of the
    icon from being a flat black rectangle.
    """
    rnd = random.Random(seed)
    out = []
    for k in range(74):
        if k < 58:
            cx = rnd.uniform(OVERSCAN_X[0] + 20, OVERSCAN_X[1] - 20)
            cy = rnd.uniform(268, 700)
        else:
            cx = rnd.choice([rnd.uniform(OVERSCAN_X[0], 84),
                             rnd.uniform(428, OVERSCAN_X[1])])
            cy = rnd.uniform(-120, 268)
        r = rnd.uniform(13, 38)
        n = rnd.randint(5, 7)
        a0 = rnd.uniform(0, math.tau)
        pts = []
        for j in range(n):
            a = a0 + math.tau * j / n + rnd.uniform(-0.22, 0.22)
            rr = r * rnd.uniform(0.62, 1.0)
            pts.append((cx + math.cos(a) * rr, cy + math.sin(a) * rr * 0.72))
        out.append((pts, rnd.random()))
    return out


SHARDS = shards()


# =============================================================================
# The drawing passes
# =============================================================================
def draw_rock(d, view, pal):
    """The rock face. Called TWICE — once with ROCK_DIM over the whole frame,
    once with ROCK_LIT masked to the light cone. Same geometry both times, which
    is what makes the lit region read as the SAME rock rather than a highlight
    painted on top of it."""

    # --- strata. Painted top down, each band covering everything below it, so
    #     only its jagged top edge is ever visible. ---
    for i, top in enumerate(BAND_TOPS):
        col = rgb(pal['bands'][min(i, len(pal['bands']) - 1)])
        edge = jag_edge(4001 + i * 17, top)
        poly = view.poly(edge + [(OVERSCAN_X[1], OVERSCAN_Y), (OVERSCAN_X[0], OVERSCAN_Y)])
        d.polygon(poly, fill=col + (255,))
        # A lit edge on top of each band is the whole "beam catching rock" read.
        d.line(view.poly(edge), fill=rgb(pal['edge']) + (118,),
               width=int(view.n(3.5)), joint='curve')

    # --- rubble ---
    lo, hi = rgb(pal['shard'][0]), rgb(pal['shard'][1])
    for pts, t in SHARDS:
        d.polygon(view.poly(pts), fill=mix(lo, hi, t) + (255,))

    # --- ore bodies, cut as blunt gems into the rock ---
    #     Each one sits in a SOCKET of darker rock. Without it the deposit is a
    #     flat diamond pasted on the surface and the mark starts to look like
    #     jewellery instead of stone with something valuable in it.
    for (x, y, r, key) in ORE:
        col = ORE_COLORS[key]
        body = mix(rgb(pal['bands'][2]), col, pal['ore'])
        face = mix(body, (255, 255, 255), 0.26 * pal['ore'])
        sock = mix(rgb(pal['bands'][2]), (0, 0, 0), 0.45)
        s = r * 1.26
        d.polygon(view.poly([(x, y - s), (x + s * 0.9, y), (x, y + s), (x - s * 0.9, y)]),
                  fill=sock + (255,))
        d.polygon(view.poly([(x, y - r), (x + r * 0.82, y), (x, y + r), (x - r * 0.82, y)]),
                  fill=body + (255,))
        d.polygon(view.poly([(x, y - r), (x + r * 0.82, y), (x, y)]), fill=face + (255,))


def draw_rig(img, view):
    """The machine. Same DNA as the SUPERMINE icon — grey hull, cyan viewport,
    amber band, slatted tracks — at a fraction of the size, because here it is
    the thing HOLDING the light rather than the subject."""
    d = ImageDraw.Draw(img, 'RGBA')
    ink = (7, 9, 12, 255)
    w = int(view.n(9))

    # one body first, so the tracks are part of the machine rather than two
    # separate objects parked either side of it
    d.rounded_rectangle(view.box(CHASSIS), radius=view.n(16), fill=(13, 15, 19, 255))

    # tracks: dark block, bright slats
    for tb in (TRACK_L, TRACK_R):
        d.rounded_rectangle(view.box(tb), radius=view.n(10),
                            fill=(22, 25, 31, 255), outline=ink, width=w)
        x0, y0, x1, y1 = tb
        for k in range(5):
            sy = y0 + 12 + k * ((y1 - y0 - 24) / 4.0)
            d.rounded_rectangle(view.box((x0 + 12, sy - 4.5, x1 - 12, sy + 4.5)),
                                radius=view.n(3), fill=(129, 140, 154, 255))

    # hull: a vertical metal gradient, then a darker right flank so the block
    # reads as lit from the left exactly like the sibling icon's does. The amber
    # band goes on BEFORE the outline — painted after it, it ran straight over
    # the hull's own black edge and the silhouette came apart.
    hull = ramp(view, img.size, [
        (HULL[1], rgb('#cfd8e3') + (255,)),
        (HULL[3], rgb('#78828f') + (255,)),
    ])
    m = Image.new('L', img.size, 0)
    ImageDraw.Draw(m).rounded_rectangle(view.box(HULL), radius=view.n(HULL_R), fill=255)
    over = Image.new('RGBA', img.size, (0, 0, 0, 0))
    od = ImageDraw.Draw(over, 'RGBA')
    od.rectangle(view.box((256, HULL[1] - 4, HULL[2] + 4, HULL[3] + 4)), fill=(0, 0, 0, 46))
    od.rectangle(view.box(BAND), fill=rgb('#e09a10') + (255,))
    od.rectangle(view.box((BAND[0], BAND[1], BAND[2], BAND[1] + 5)),
                 fill=rgb('#ffc94d') + (255,))
    hull = Image.alpha_composite(hull, over)
    img.alpha_composite(masked(hull, m))

    d.rounded_rectangle(view.box(HULL), radius=view.n(HULL_R), outline=ink, width=w)
    d.rounded_rectangle(view.box(VIEWPORT), radius=view.n(9),
                        fill=rgb('#79dcff') + (255,), outline=ink, width=int(view.n(7)))

    # the lamp — the source of everything below it. Set INTO the hull's front
    # edge: hung underneath it it reads as feet.
    d.rounded_rectangle(view.box(LAMP), radius=view.n(7),
                        fill=rgb('#fff6d2') + (255,), outline=ink, width=int(view.n(7)))


def cone_mask(view, size, poly=None, blur=7.0):
    m = Image.new('L', size, 0)
    ImageDraw.Draw(m).polygon(view.poly(poly or BEAM_POLY), fill=255)
    return m.filter(ImageFilter.GaussianBlur(view.n(blur)))


# =============================================================================
# Compose
# =============================================================================
def render(scale=1.0, px=DESIGN * SS):
    view = View(scale, px)
    size = (px, px)

    # 1. background: cleared rock at the top falling to the app's own black.
    img = ramp(view, size, [
        (-120, rgb(BG_TOP) + (255,)),
        (250, rgb('#101218') + (255,)),
        (620, rgb(BG_BOT) + (255,)),
    ])

    # 2. the rock, unlit. This is what the player would see with the lamp off.
    dim = Image.new('RGBA', size, (0, 0, 0, 0))
    draw_rock(ImageDraw.Draw(dim, 'RGBA'), view, ROCK_DIM)
    img = Image.alpha_composite(img, dim)

    cone = cone_mask(view, size)

    # 3. the SAME rock, lit, clipped to the cone and falling off with depth.
    #    Alpha-composited (not added) because rock reflecting light is still
    #    rock: it replaces the dark surface, it does not glow through it.
    lit = Image.new('RGBA', size, (0, 0, 0, 0))
    draw_rock(ImageDraw.Draw(lit, 'RGBA'), view, ROCK_LIT)
    falloff = ramp(view, size, [
        (BEAM_APEX_Y, (255, 255, 255, 255)),
        (320, (255, 255, 255, 214)),
        (390, (255, 255, 255, 132)),
        (450, (255, 255, 255, 52)),
        (505, (255, 255, 255, 0)),
    ]).getchannel('A')
    img = Image.alpha_composite(img, masked(lit, ImageChops.multiply(cone, falloff)))

    # 4. the beam itself: airborne dust in the light. Added, because it is light.
    #    Kept LOW. Cranked up it stops being a beam and becomes a fog that
    #    swallows the rock the beam is supposed to be revealing.
    haze = ramp(view, size, [
        (BEAM_APEX_Y - 10, (255, 244, 208, 132)),
        (300, (255, 198, 108, 54)),
        (390, (255, 162, 52, 24)),
        (470, (255, 140, 20, 5)),
        (540, (255, 140, 20, 0)),
    ])
    img = add_light(img, masked(haze, cone))
    img = add_light(img, masked(haze, cone.filter(ImageFilter.GaussianBlur(view.n(26)))))
    img = add_light(img, masked(haze, cone_mask(view, size, BEAM_CORE, blur=26.0)))

    # 5. ore glints. Drawn for every deposit, then clipped to the cone — so the
    #    ore outside the light simply never sparkles, which is the point.
    glint = Image.new('RGBA', size, (0, 0, 0, 0))
    gd = ImageDraw.Draw(glint, 'RGBA')
    for (x, y, r, key) in ORE:
        col = ORE_COLORS[key]
        gd.polygon(view.poly([(x, y - r * 0.5), (x + r * 0.38, y), (x, y + r * 0.5), (x - r * 0.38, y)]),
                   fill=col + (255,))
        # Short cross-flare, not a four-pointed star: long arms read as clip-art
        # sparkle and stop looking like a stone catching a lamp.
        s = r * 1.25
        gd.polygon(view.poly([(x, y - s), (x + s * 0.16, y), (x, y + s), (x - s * 0.16, y)]),
                   fill=col + (110,))
        gd.polygon(view.poly([(x - s, y), (x, y - s * 0.16), (x + s, y), (x, y + s * 0.16)]),
                   fill=col + (110,))
    glint = glint.filter(ImageFilter.GaussianBlur(view.n(2.0)))
    img = add_light(img, masked(glint, ImageChops.multiply(cone, falloff)))

    # 6. the machine, over everything — nothing occludes the rig.
    rig = Image.new('RGBA', size, (0, 0, 0, 0))
    draw_rig(rig, view)
    img = Image.alpha_composite(img, rig)

    # 7. the lamp flare, last, so it spills over the hull's own outline.
    flare = Image.new('RGBA', size, (0, 0, 0, 0))
    fd = ImageDraw.Draw(flare, 'RGBA')
    cx = (LAMP[0] + LAMP[2]) / 2.0
    cy = (LAMP[1] + LAMP[3]) / 2.0
    for rr, a in ((84, 40), (52, 76), (28, 150)):
        fd.ellipse(view.box((cx - rr, cy - rr * 0.42, cx + rr, cy + rr * 0.42)),
                   fill=(255, 240, 200, a))
    img = add_light(img, flare.filter(ImageFilter.GaussianBlur(view.n(8))))

    # 8. vignette — pulls the eye to the wedge and keeps the corners from
    #    competing with it at 48 px.
    vig = Image.new('L', size, 0)
    ImageDraw.Draw(vig).ellipse([-px * 0.22, -px * 0.30, px * 1.22, px * 1.30], fill=255)
    vig = vig.filter(ImageFilter.GaussianBlur(px * 0.10))
    dark = Image.new('RGBA', size, (0, 0, 0, 168))
    img = Image.alpha_composite(img, masked(dark, ImageChops.invert(vig)))

    return img


def rounded(img, radius_design=112):
    """Transparent corners, matching the sibling icon's plate shape."""
    px = img.size[0]
    m = Image.new('L', img.size, 0)
    r = radius_design * px / float(DESIGN)
    ImageDraw.Draw(m).rounded_rectangle([0, 0, px - 1, px - 1], radius=r, fill=255)
    out = img.copy()
    out.putalpha(m)
    return out


def down(img, size):
    return img.resize((size, size), Image.LANCZOS)


def main():
    os.makedirs(ICON_DIR, exist_ok=True)

    # Plain icons: rounded plate, transparent corners, art at full scale.
    plate = rounded(render(scale=1.0))
    for size in (512, 192):
        path = os.path.join(ICON_DIR, 'icon-%d.png' % size)
        down(plate, size).save(path)
        print('wrote', path)

    # Maskable: full bleed to all four edges and the art pulled in to 82%.
    # The rig's outermost corner then sits 172 units from the centre and the
    # deepest lit ore 143, against a safe-zone radius of 205 — everything that
    # carries the mark survives even the most aggressive circular crop. Only the
    # outer haze of the beam is ever cut, and it is already fading to nothing.
    mask_img = render(scale=0.82).convert('RGB').convert('RGBA')
    path = os.path.join(ICON_DIR, 'icon-maskable-512.png')
    down(mask_img, 512).save(path)
    print('wrote', path)


if __name__ == '__main__':
    main()
