#!/usr/bin/env python3
"""Render README media from output captured by capture-package-media.mjs."""

import json
import shutil
import subprocess
import sys
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
CAPTURE = Path(sys.argv[1]).resolve()
FONT = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
FONT_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"
# DejaVu has no CJK glyphs, so lines with Chinese text are drawn with Noto instead.
FONT_CJK = "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"
FONT_CJK_BOLD = "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc"


def has_cjk(text):
    return any("\u2e80" <= character <= "\u9fff" or "\uff00" <= character <= "\uffef"
               for character in text)

PACKAGES = {
    "todo": ("Pi Todo", "Production state-machine output"),
    "scheduler": ("Pi Scheduler", "Production scheduler with deterministic time"),
    "codex-edit": ("Pi Codex Edit", "Production parser and patch application"),
    "worktree": ("Pi Worktree", "Shipped CLI running in a temporary Git repository"),
    "openai-account-pool": ("Pi OpenAI Account Pool",
                            "Production wizard, status and failover over a temporary agent dir"),
}


def font(path, size):
    return ImageFont.truetype(path, size)


def line_font(line, size, bold):
    if has_cjk(line):
        return font(FONT_CJK_BOLD if bold else FONT_CJK, size)
    return font(FONT_BOLD if bold else FONT, size)


def wrapped_lines(text, width=96):
    result = []
    for line in text.splitlines():
        if not line:
            result.append("")
            continue
        # Chinese glyphs are twice as wide, so those lines wrap at half the column count.
        columns = width // 2 if has_cjk(line) else width
        result.extend(textwrap.wrap(line, width=columns, replace_whitespace=False,
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
    for line in wrapped_lines(text):
        if line.startswith("$") or line.startswith("***"):
            color, face = "#7dd3fc", line_font(line, 18, True)
        elif line.startswith("+"):
            color, face = "#86efac", line_font(line, 18, False)
        elif line.startswith("Result:") or line.endswith("successfully."):
            color, face = "#4ade80", line_font(line, 18, True)
        else:
            color, face = "#e2e8f0", line_font(line, 18, False)
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


def render_background_tasks():
    source = CAPTURE / "background-herdr"
    result = json.loads((source / "result.json").read_text())
    if result.get("passed") is not True:
        raise RuntimeError("Background Tasks Herdr recording did not pass")
    gif_frames = source / "gif-frames"
    shutil.rmtree(gif_frames, ignore_errors=True)
    gif_frames.mkdir()
    subprocess.run([
        "gst-launch-1.0", "-q", "filesrc", f"location={source / 'demo.webm'}",
        "!", "matroskademux", "!", "vp8dec", "!", "videorate",
        "!", "video/x-raw,framerate=2/1", "!", "videoscale",
        "!", "video/x-raw,width=1120,height=637,pixel-aspect-ratio=1/1", "!", "videoconvert",
        "!", "pngenc", "!", "multifilesink", f"location={gif_frames / 'frame-%04d.png'}",
    ], check=True, timeout=60)
    frames = [Image.open(path).convert("RGB").quantize(colors=96)
              for path in sorted(gif_frames.glob("frame-*.png"))]
    if len(frames) < 10:
        raise RuntimeError("Background Tasks GIF needs the actual full recorded flow")
    docs = ROOT / "packages" / "background-tasks" / "docs"
    docs.mkdir(parents=True, exist_ok=True)
    Image.open(source / "parent-widget.png").convert("RGB").save(
        docs / "screenshot.png", optimize=True)
    Image.open(source / "tests-focused.png").convert("RGB").save(
        docs / "task-panes.png", optimize=True)
    frames[0].save(docs / "demo.gif", save_all=True, append_images=frames[1:],
                   duration=500, loop=0, optimize=True)
    shutil.copyfile(source / "demo.webm", docs / "demo.webm")


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
    # Publish the active parent view so the persistent Fleet footer is visible.
    Image.open(CAPTURE / "herdr-fleet.png").convert("RGB").save(
        docs / "screenshot.png", optimize=True)
    (docs / "demo.gif").unlink(missing_ok=True)
    shutil.copyfile(CAPTURE / "herdr-demo.webm", docs / "demo.webm")


selected = set(sys.argv[2:])
for package_slug, metadata in PACKAGES.items():
    if not selected or package_slug in selected:
        render_terminal_package(package_slug, *metadata)
if not selected or "background-tasks" in selected:
    render_background_tasks()
if not selected or "herdr-subagents" in selected:
    render_herdr_subagents()
if not selected or "cache-export" in selected:
    render_cache_export()
if selected:
    print(f"Rendered package media for {', '.join(sorted(selected))}")
else:
    print("Rendered all package screenshots and demos, including the Herdr screenshot and WebM recording")
