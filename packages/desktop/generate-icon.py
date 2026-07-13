#!/usr/bin/env python3
"""
Generate Build Studio app icon.
Cute robot sitting at a laptop — purple/navy theme, polished style.
Inspired by a 3D-rendered chibi robot.
"""

from PIL import Image, ImageDraw, ImageFilter
import math
import os

SIZE = 1024
CENTER = SIZE // 2

# Dark navy-purple gradient background
BG_TOP = (18, 14, 40)
BG_BOT = (30, 24, 65)

# Robot colors — white/silver body with purple accents
BODY_WHITE = (220, 225, 235)
BODY_LIGHT = (240, 242, 248)
BODY_SHADOW = (170, 178, 200)
BODY_DARK = (140, 150, 175)

# Purple/magenta accents
PURPLE = (180, 60, 220)
PURPLE_LIGHT = (210, 120, 250)
PURPLE_DARK = (130, 40, 170)
PURPLE_GLOW = (200, 100, 255)

# Eye color — green/cyan
EYE_GREEN = (0, 230, 160)
EYE_BRIGHT = (100, 255, 200)
EYE_DARK = (0, 160, 110)

# Laptop
LAPTOP_TOP = (180, 170, 210)
LAPTOP_SCREEN = (60, 50, 100)
LAPTOP_BODY = (200, 190, 220)
LAPTOP_GLOW = (140, 120, 200)

# Floor/surface
FLOOR_COLOR = (45, 35, 90)
FLOOR_LIGHT = (60, 48, 110)

# Code on screen
CODE_CYAN = (80, 240, 220)
CODE_PINK = (255, 120, 200)
CODE_YELLOW = (255, 220, 100)
CODE_WHITE = (200, 200, 220)


def lerp(c1, c2, t):
    return tuple(int(a + (b - a) * t) for a, b in zip(c1, c2))


def draw_aa_ellipse(img, bbox, fill=None, outline=None, width=1):
    x0, y0, x1, y1 = [int(v) for v in bbox]
    w, h = x1 - x0, y1 - y0
    if w <= 0 or h <= 0:
        return
    scale = 3
    big = Image.new("RGBA", (w * scale, h * scale), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    d.ellipse([0, 0, w * scale - 1, h * scale - 1], fill=fill, outline=outline, width=width * scale)
    small = big.resize((w, h), Image.LANCZOS)
    img.paste(small, (x0, y0), small)


def draw_aa_rrect(img, bbox, radius, fill=None, outline=None, width=1):
    x0, y0, x1, y1 = [int(v) for v in bbox]
    w, h = x1 - x0, y1 - y0
    if w <= 0 or h <= 0:
        return
    scale = 3
    big = Image.new("RGBA", (w * scale, h * scale), (0, 0, 0, 0))
    d = ImageDraw.Draw(big)
    d.rounded_rectangle([0, 0, w * scale - 1, h * scale - 1], radius=radius * scale, fill=fill, outline=outline, width=width * scale)
    small = big.resize((w, h), Image.LANCZOS)
    img.paste(small, (x0, y0), small)


def main():
    img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    # === Background gradient ===
    corner_r = int(SIZE * 0.2237)
    bg = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    bg_draw = ImageDraw.Draw(bg)
    for y in range(SIZE):
        t = y / SIZE
        color = lerp(BG_TOP, BG_BOT, t)
        bg_draw.line([(0, y), (SIZE, y)], fill=(*color, 255))
    mask = Image.new("L", (SIZE, SIZE), 0)
    mask_draw = ImageDraw.Draw(mask)
    mask_draw.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=corner_r, fill=255)
    bg.putalpha(mask)
    img = Image.alpha_composite(img, bg)

    # === Ambient glow behind robot ===
    glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    for r in range(350, 0, -3):
        alpha = int(6 * (1 - r / 350))
        ImageDraw.Draw(glow).ellipse(
            [CENTER - r, 400 - r // 2, CENTER + r, 400 + r // 2],
            fill=(*PURPLE_GLOW, alpha))
    img = Image.alpha_composite(img, glow)

    # === Floor surface (subtle) ===
    floor = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    fd = ImageDraw.Draw(floor)
    # Elliptical floor
    draw_aa_ellipse(floor, [150, 730, 874, 870], fill=(*FLOOR_COLOR, 150))
    draw_aa_ellipse(floor, [200, 745, 824, 840], fill=(*FLOOR_LIGHT, 80))
    img = Image.alpha_composite(img, floor)

    # Robot center
    rcx = CENTER
    rcy = 480

    # === Laptop (in front of robot, on floor) ===
    laptop = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    # Laptop base (keyboard)
    draw_aa_rrect(laptop, [rcx - 180, 700, rcx + 180, 750], radius=8, fill=LAPTOP_BODY)
    draw_aa_rrect(laptop, [rcx - 160, 708, rcx + 160, 742], radius=4, fill=(*BODY_SHADOW, 100))

    # Laptop screen (angled back)
    screen_left = rcx - 170
    screen_right = rcx + 170
    screen_top = 490
    screen_bot = 700
    draw_aa_rrect(laptop, [screen_left - 6, screen_top - 6, screen_right + 6, screen_bot + 4], radius=12, fill=LAPTOP_TOP)
    draw_aa_rrect(laptop, [screen_left, screen_top, screen_right, screen_bot], radius=6, fill=LAPTOP_SCREEN)

    # Screen glow
    for g in range(30, 0, -1):
        alpha = int(5 * (1 - g / 30))
        ImageDraw.Draw(laptop).ellipse(
            [rcx - 100 - g, screen_top + 60 - g, rcx + 100 + g, screen_top + 60 + g],
            fill=(*LAPTOP_GLOW, alpha))

    # Code lines on screen
    ld = ImageDraw.Draw(laptop)
    code = [
        (CODE_CYAN, 0.5, 0), (CODE_PINK, 0.35, 14), (CODE_WHITE, 0.45, 14),
        (CODE_YELLOW, 0.3, 28), (CODE_CYAN, 0.55, 0), (CODE_PINK, 0.4, 14),
        (CODE_WHITE, 0.5, 14), (CODE_YELLOW, 0.35, 28), (CODE_CYAN, 0.45, 0),
        (CODE_PINK, 0.3, 14),
    ]
    for i, (color, wpct, indent) in enumerate(code):
        ly = screen_top + 20 + i * 18
        if ly + 5 > screen_bot - 15:
            break
        lx = screen_left + 16 + indent
        lw = int((screen_right - screen_left - 40) * wpct)
        ld.rounded_rectangle([lx, ly, lx + lw, ly + 5], radius=2, fill=(*color, 100))

    img = Image.alpha_composite(img, laptop)

    # === Robot body (sitting behind laptop) ===
    body = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    # Torso — rounded pill shape
    torso_top = 380
    torso_bot = 680
    draw_aa_rrect(body, [rcx - 100, torso_top, rcx + 100, torso_bot], radius=45, fill=BODY_WHITE)
    # Left highlight
    draw_aa_rrect(body, [rcx - 100, torso_top, rcx - 50, torso_bot - 40], radius=45, fill=BODY_LIGHT)
    # Right shadow
    draw_aa_rrect(body, [rcx + 40, torso_top + 20, rcx + 100, torso_bot], radius=45, fill=BODY_SHADOW)

    # Chest detail — purple accent stripe
    draw_aa_rrect(body, [rcx - 45, torso_top + 50, rcx + 45, torso_top + 110], radius=10, fill=(*PURPLE, 60))
    draw_aa_rrect(body, [rcx - 40, torso_top + 55, rcx + 40, torso_top + 105], radius=8, fill=(*PURPLE_DARK, 40))

    # Purple chest light
    draw_aa_ellipse(body, [rcx - 14, torso_top + 70, rcx + 14, torso_top + 90], fill=PURPLE)
    draw_aa_ellipse(body, [rcx - 7, torso_top + 75, rcx + 5, torso_top + 83], fill=PURPLE_LIGHT)

    img = Image.alpha_composite(img, body)

    # === Arms (reaching to laptop) ===
    arms = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    # Left arm
    draw_aa_rrect(arms, [rcx - 140, torso_top + 60, rcx - 95, torso_top + 190], radius=20, fill=BODY_WHITE)
    # Left forearm
    draw_aa_rrect(arms, [rcx - 155, torso_top + 160, rcx - 100, torso_top + 280], radius=18, fill=BODY_SHADOW)
    # Left hand
    draw_aa_ellipse(arms, [rcx - 160, 685, rcx - 115, 720], fill=BODY_WHITE)

    # Right arm
    draw_aa_rrect(arms, [rcx + 95, torso_top + 60, rcx + 140, torso_top + 190], radius=20, fill=BODY_WHITE)
    # Right forearm
    draw_aa_rrect(arms, [rcx + 100, torso_top + 160, rcx + 155, torso_top + 280], radius=18, fill=BODY_SHADOW)
    # Right hand
    draw_aa_ellipse(arms, [rcx + 115, 685, rcx + 160, 720], fill=BODY_WHITE)

    img = Image.alpha_composite(img, arms)

    # === Legs (crossed, sitting) ===
    legs = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    # Left leg
    draw_aa_rrect(legs, [rcx - 110, torso_bot - 40, rcx - 50, torso_bot + 80], radius=22, fill=BODY_SHADOW)
    draw_aa_ellipse(legs, [rcx - 120, torso_bot + 50, rcx - 55, torso_bot + 95], fill=BODY_DARK)
    # Right leg
    draw_aa_rrect(legs, [rcx + 50, torso_bot - 40, rcx + 110, torso_bot + 80], radius=22, fill=BODY_SHADOW)
    draw_aa_ellipse(legs, [rcx + 55, torso_bot + 50, rcx + 120, torso_bot + 95], fill=BODY_DARK)

    img = Image.alpha_composite(img, legs)

    # === Head ===
    head = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))

    head_cx = rcx
    head_cy = 280
    head_rx = 135
    head_ry = 120

    # Head shape — large rounded
    draw_aa_ellipse(head, [head_cx - head_rx, head_cy - head_ry, head_cx + head_rx, head_cy + head_ry],
                    fill=BODY_WHITE)
    # Highlight on top-left
    draw_aa_ellipse(head, [head_cx - head_rx + 15, head_cy - head_ry + 10, head_cx - 20, head_cy - 20],
                    fill=BODY_LIGHT)
    # Shadow on bottom-right
    draw_aa_ellipse(head, [head_cx + 20, head_cy + 10, head_cx + head_rx - 10, head_cy + head_ry - 15],
                    fill=(*BODY_SHADOW, 120))

    # === Ear accents (purple circles on sides) ===
    for side in [-1, 1]:
        ex = head_cx + side * (head_rx - 8)
        ey = head_cy + 10
        # Outer glow
        for g in range(20, 0, -1):
            alpha = int(8 * (1 - g / 20))
            ImageDraw.Draw(head).ellipse(
                [ex - 30 - g, ey - 30 - g, ex + 30 + g, ey + 30 + g],
                fill=(*PURPLE_GLOW, alpha))
        draw_aa_ellipse(head, [ex - 28, ey - 28, ex + 28, ey + 28], fill=PURPLE)
        draw_aa_ellipse(head, [ex - 18, ey - 18, ex + 18, ey + 18], fill=PURPLE_DARK)
        draw_aa_ellipse(head, [ex - 10, ey - 6, ex + 2, ey + 2], fill=(*PURPLE_LIGHT, 150))

    # === Eyes (large, green/cyan, expressive) ===
    eye_y = head_cy + 5
    eye_sep = 55

    for side in [-1, 1]:
        ex = head_cx + side * eye_sep

        # Eye socket (dark)
        draw_aa_ellipse(head, [ex - 35, eye_y - 30, ex + 35, eye_y + 30], fill=(30, 25, 50))

        # Eye (green)
        draw_aa_ellipse(head, [ex - 28, eye_y - 24, ex + 28, eye_y + 24], fill=EYE_GREEN)

        # Eye inner gradient
        draw_aa_ellipse(head, [ex - 20, eye_y - 16, ex + 20, eye_y + 16], fill=EYE_DARK)

        # Pupil
        draw_aa_ellipse(head, [ex - 10, eye_y - 8, ex + 10, eye_y + 8], fill=(10, 15, 30))

        # Eye highlight (bright spot)
        draw_aa_ellipse(head, [ex - 14, eye_y - 18, ex - 2, eye_y - 8], fill=EYE_BRIGHT)
        draw_aa_ellipse(head, [ex + 4, eye_y + 6, ex + 12, eye_y + 12], fill=(*EYE_GREEN, 150))

    # Subtle mouth area
    hd = ImageDraw.Draw(head)
    hd.arc([head_cx - 25, head_cy + 50, head_cx + 25, head_cy + 75],
           start=10, end=170, fill=BODY_SHADOW, width=3)

    # === Antenna ===
    antenna_top = head_cy - head_ry - 40
    hd.line([(head_cx, head_cy - head_ry + 10), (head_cx, antenna_top + 10)],
            fill=BODY_SHADOW, width=4)
    draw_aa_ellipse(head, [head_cx - 10, antenna_top - 5, head_cx + 10, antenna_top + 15],
                    fill=BODY_WHITE)
    # Antenna glow
    for g in range(15, 0, -1):
        alpha = int(10 * (1 - g / 15))
        ImageDraw.Draw(head).ellipse(
            [head_cx - 10 - g, antenna_top - 5 - g, head_cx + 10 + g, antenna_top + 15 + g],
            fill=(*PURPLE_GLOW, alpha))

    img = Image.alpha_composite(img, head)

    # === Screen glow on robot face ===
    face_glow = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    for r in range(80, 0, -1):
        alpha = int(3 * (1 - r / 80))
        ImageDraw.Draw(face_glow).ellipse(
            [head_cx - r, head_cy + 40 - r // 2, head_cx + r, head_cy + 40 + r // 2],
            fill=(*LAPTOP_GLOW, alpha))
    img = Image.alpha_composite(img, face_glow)

    # === Apply mask ===
    final = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    final.paste(img, mask=mask)

    # Save
    out_dir = os.path.dirname(os.path.abspath(__file__))
    out_path = os.path.join(out_dir, "icon.png")
    final.save(out_path, "PNG")
    print(f"Saved {out_path} ({SIZE}x{SIZE})")
    for s in [512, 256, 128]:
        small = final.resize((s, s), Image.LANCZOS)
        small.save(os.path.join(out_dir, f"icon_{s}.png"), "PNG")
        print(f"Saved icon_{s}.png")


if __name__ == "__main__":
    main()
