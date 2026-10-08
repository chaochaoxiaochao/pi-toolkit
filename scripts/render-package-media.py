#!/usr/bin/env python3
"""Render README media from output captured by capture-package-media.mjs."""

import json
import shutil
import sys
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
CAPTURE = Path(sys.argv[1]).resolve()
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"

PACKAGES = {
    "todo": ("Pi Todo", "Production state-machine output"),
    "codex-edit": ("Pi Codex Edit", "Production parser and patch application"),
    "worktree": ("Pi Worktree", "Shipped CLI running in a temporary Git repository"),
}


def font(path, size):
    return ImageFont.truetype(path, size)


def wrapped_lines(text, width=96):
    result = []
    for line in text.splitlines():
        if not line:
            result.append("")
            continue
        result.extend(textwrap.wrap(line, width=width, replace_whitespace=False,
                                    drop_whitespace=False) or [""])
    return result


def terminal_frame(title, subtitle, text, height):
    image = Image.new("RGB", (1280, height), "#0b1020")
    draw = ImageDraw.Draw(image)
    draw.rounded_rectangle((24, 24, 1256, height - 24), radius=20,
                           fill="#111827", outline="#334155", width=2)
    for index, color in enumerate(("#fb7185", "#fbbf24", "#4ade80")):
        x = 58 + index * 28
        draw.ellipse((x, 54, x + 14, 68), fill=color)
    draw.text((154, 46), title, font=font(FONT_BOLD, 24), fill="#f8fafc")
    draw.text((58, 91), subtitle, font=font(FONT, 16), fill="#94a3b8")
    draw.text((58, 121), "CAPTURED FROM REAL PACKAGE EXECUTION",
              font=font(FONT_BOLD, 14), fill="#38bdf8")

    y = 168
    regular = font(FONT, 18)
    bold = font(FONT_BOLD, 18)
    for line in wrapped_lines(text):
        if line.startswith("$") or line.startswith("***"):
            color, face = "#7dd3fc", bold
        elif line.startswith("+"):
            color, face = "#86efac", regular
        elif line.startswith("Result:") or line.endswith("successfully."):
            color, face = "#4ade80", bold
        else:
            color, face = "#e2e8f0", regular
        draw.text((58, y), line, font=face, fill=color)
        y += 27
    return image


def render_terminal_package(slug, title, subtitle):
    pages = json.loads((CAPTURE / f"{slug}.json").read_text(encoding="utf-8"))
    max_lines = max(len(wrapped_lines(page)) for page in pages)
    height = max(620, 210 + max_lines * 27)
    frames = [terminal_frame(title, subtitle, page, height) for page in pages]
    docs = ROOT / "packages" / slug / "docs"
    docs.mkdir(parents=True, exist_ok=True)
    frames[-1].save(docs / "screenshot.png", optimize=True)
    frames[0].save(docs / "demo.gif", save_all=True,
                   append_images=frames[1:], duration=[1500, 1600, 2200],
                   loop=0, optimize=True)


def render_cache_export():
    docs = ROOT / "packages" / "cache-export" / "docs"
    docs.mkdir(parents=True, exist_ok=True)
    names = ("cache-latest", "cache-all", "cache-tooltip")
    frames = [Image.open(CAPTURE / f"{name}.png").convert("RGB") for name in names]
    frames[0].save(docs / "screenshot.png", optimize=True)
    frames[0].save(docs / "demo.gif", save_all=True,
                   append_images=frames[1:], duration=[1800, 1800, 2400],
                   loop=0, optimize=True)


def render_herdr_subagents():
    source = CAPTURE / "herdr-live"
    paths = sorted(source.glob("frame-*.png"))
    if len(paths) < 5:
        raise RuntimeError("Herdr UI capture must contain parent, running panes, and final response frames")
    full_frames = []
    for path in paths:
        image = Image.open(path).convert("RGB")
        image.thumbnail((1280, 800), Image.LANCZOS)
        full_frames.append(image)
    docs = ROOT / "packages" / "herdr-subagents" / "docs"
    docs.mkdir(parents=True, exist_ok=True)
    # The penultimate frame is the settled three-pane run; the last returns to the parent Pi.
    full_frames[-2].save(docs / "screenshot.png", optimize=True)
    selected = sorted(set([0, 1, 2, *range(3, max(3, len(paths) - 2), 2),
                           len(paths) - 2, len(paths) - 1]))
    frames = []
    for index in selected:
        image = Image.open(paths[index]).convert("RGB")
        image.thumbnail((1024, 640), Image.LANCZOS)
        frames.append(image)
    paletted = [frame.quantize(colors=96, method=Image.MEDIANCUT,
                               dither=Image.FLOYDSTEINBERG) for frame in frames]
    durations = [1400, 1800, 900] + [900] * max(0, len(frames) - 5) + [1600, 2600]
    paletted[0].save(docs / "demo.gif", save_all=True,
                     append_images=paletted[1:], duration=durations,
                     loop=0, optimize=True, disposal=2)
    shutil.copyfile(CAPTURE / "herdr-demo.webm", docs / "demo.webm")


for package_slug, metadata in PACKAGES.items():
    render_terminal_package(package_slug, *metadata)
render_herdr_subagents()
render_cache_export()
print("Rendered package screenshots and demos, including the Herdr WebM recording")
