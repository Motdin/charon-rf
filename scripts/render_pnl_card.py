#!/usr/bin/env python3
"""Render a shareable daily PnL card (PNG) for X/Twitter from charon-rh sqlite.

Usage:
  python scripts/render_pnl_card.py --db charon-rh.sqlite --out pnl_card.png [--date YYYY-MM-DD]

Reads dry_run_positions (closed trades) for the target day and draws a
social-ready card: net PnL, win rate, trades, best/worst, strategy, sparkline.
"""
from __future__ import annotations

import argparse
import json
import math
import sqlite3
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


# ── palette (charon-rh / trench aesthetic) ──────────────────────
BG = (12, 12, 16)
CARD = (22, 24, 32)
ACCENT = (120, 255, 180)       # mint green
ACCENT_DIM = (60, 160, 110)
RED = (255, 95, 110)
TEXT = (235, 238, 245)
MUTED = (140, 148, 165)
GOLD = (255, 210, 110)
LINE = (40, 44, 56)

W, H = 1200, 675   # 16:9 — good for X


def load_fonts():
    candidates = [
        # Linux (VPS)
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
        "/usr/share/fonts/TTF/DejaVuSans.ttf",
        # Windows (local dev)
        "C:/Windows/Fonts/segoeui.ttf",
        "C:/Windows/Fonts/arial.ttf",
        "C:/Windows/Fonts/calibri.ttf",
    ]
    bold_candidates = [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf",
        "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
        "C:/Windows/Fonts/segoeuib.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
        "C:/Windows/Fonts/calibrib.ttf",
    ]

    def pick(lst, size):
        for p in lst:
            if Path(p).exists():
                try:
                    return ImageFont.truetype(p, size)
                except Exception:
                    continue
        # last resort — default bitmap font
        try:
            return ImageFont.load_default(size=size)
        except TypeError:
            return ImageFont.load_default()

    return {
        "xs": pick(candidates, 22),
        "sm": pick(candidates, 26),
        "md": pick(candidates, 32),
        "lg": pick(bold_candidates, 48),
        "xl": pick(bold_candidates, 72),
        "huge": pick(bold_candidates, 96),
        "bold_sm": pick(bold_candidates, 26),
        "bold_md": pick(bold_candidates, 34),
    }


def fetch_stats(db_path: str, day: str):
    con = sqlite3.connect(db_path)
    con.row_factory = sqlite3.Row
    # Day window in local time (Asia/Jakarta-ish offset passed by caller via day string)
    # We treat day as YYYY-MM-DD UTC for simplicity, expand to ±14h to be safe.
    start = datetime.strptime(day, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    end = start + timedelta(days=1)
    start_ms = int(start.timestamp() * 1000)
    end_ms = int(end.timestamp() * 1000)

    rows = con.execute(
        """
        SELECT id, symbol, mint, status, opened_at_ms, closed_at_ms,
               size_eth, entry_mcap, exit_mcap, exit_reason,
               pnl_percent, pnl_eth, strategy_id, execution_mode
        FROM dry_run_positions
        WHERE status = 'closed'
          AND closed_at_ms IS NOT NULL
          AND closed_at_ms >= ? AND closed_at_ms < ?
        ORDER BY closed_at_ms ASC
        """,
        (start_ms, end_ms),
    ).fetchall()

    open_rows = con.execute(
        "SELECT COUNT(*) c FROM dry_run_positions WHERE status = 'open'"
    ).fetchone()["c"]

    con.close()

    trades = [dict(r) for r in rows]
    wins = [t for t in trades if (t["pnl_percent"] or 0) > 0]
    losses = [t for t in trades if (t["pnl_percent"] or 0) <= 0]
    net_pct = sum((t["pnl_percent"] or 0) for t in trades)
    net_eth = sum((t["pnl_eth"] or 0) for t in trades)
    best = max(trades, key=lambda t: (t["pnl_percent"] or 0), default=None)
    worst = min(trades, key=lambda t: (t["pnl_percent"] or 0), default=None)
    win_rate = (len(wins) / len(trades) * 100) if trades else 0.0
    strategies = sorted({t["strategy_id"] for t in trades if t.get("strategy_id")})
    modes = sorted({t["execution_mode"] for t in trades if t.get("execution_mode")})

    return {
        "date": day,
        "trades": trades,
        "trade_count": len(trades),
        "wins": len(wins),
        "losses": len(losses),
        "win_rate": win_rate,
        "net_percent": net_pct,
        "net_eth": net_eth,
        "best": best,
        "worst": worst,
        "open_positions": open_rows,
        "strategies": strategies,
        "modes": modes,
    }


def fmt_pct(v):
    return f"{v:+.1f}%"


def fmt_eth(v):
    return f"{v:+.4f} ETH"


def draw_sparkline(draw, trades, box, font):
    x0, y0, x1, y1 = box
    draw.rounded_rectangle(box, radius=12, fill=CARD)
    if len(trades) < 2:
        draw.text(((x0 + x1) // 2, (y0 + y1) // 2), "n/a", font=font, fill=MUTED, anchor="mm")
        return
    # cumulative pnl curve
    cum = []
    acc = 0.0
    for t in trades:
        acc += (t["pnl_percent"] or 0)
        cum.append(acc)
    lo, hi = min(cum), max(cum)
    span = (hi - lo) or 1.0
    pad = 18
    pts = []
    n = len(cum)
    for i, v in enumerate(cum):
        x = x0 + pad + (x1 - x0 - 2 * pad) * (i / max(1, n - 1))
        y = y1 - pad - (y1 - y0 - 2 * pad) * ((v - lo) / span)
        pts.append((x, y))
    # baseline
    base_y = y1 - pad - (y1 - y0 - 2 * pad) * ((0 - lo) / span)
    draw.line([(x0 + pad, base_y), (x1 - pad, base_y)], fill=LINE, width=2)
    color = ACCENT if cum[-1] >= 0 else RED
    if len(pts) >= 2:
        draw.line(pts, fill=color, width=4, joint="curve")
    draw.ellipse([pts[-1][0] - 6, pts[-1][1] - 6, pts[-1][0] + 6, pts[-1][1] + 6], fill=color)
    draw.text((x0 + pad, y0 + 10), "cumulative PnL", font=font, fill=MUTED)


def render_card(stats, out_path: str):
    fonts = load_fonts()
    img = Image.new("RGB", (W, H), BG)
    draw = ImageDraw.Draw(img)

    # header strip
    draw.rectangle([0, 0, W, 8], fill=ACCENT)

    # brand
    draw.text((56, 36), "CHARON-RH", font=fonts["bold_md"], fill=ACCENT)
    draw.text((56, 78), "Robinhood Chain  ·  trench agent", font=fonts["sm"], fill=MUTED)

    # date badge
    date_label = stats["date"]
    badge = f"📅  {date_label}"
    bw = draw.textlength(badge, font=fonts["sm"])
    draw.rounded_rectangle([W - 56 - bw - 28, 40, W - 56, 88], radius=20, fill=CARD)
    draw.text((W - 56 - bw - 14, 50), badge, font=fonts["sm"], fill=TEXT)

    # ── hero net PnL ────────────────────────────────────────────
    net = stats["net_percent"]
    net_color = ACCENT if net >= 0 else RED
    hero_y = 130
    draw.text((56, hero_y), "NET PnL", font=fonts["sm"], fill=MUTED)
    draw.text((56, hero_y + 34), fmt_pct(net), font=fonts["huge"], fill=net_color)
    draw.text((56 + draw.textlength(fmt_pct(net), font=fonts["huge"]) + 24, hero_y + 90),
              fmt_eth(stats["net_eth"]), font=fonts["md"], fill=net_color)

    # win rate ring-ish
    wr = stats["win_rate"]
    wr_color = ACCENT if wr >= 50 else (GOLD if wr >= 35 else RED)
    ring_box = (W - 280, 130, W - 56, 292)
    draw.rounded_rectangle(ring_box, radius=24, fill=CARD)
    draw.text(((ring_box[0] + ring_box[2]) // 2, ring_box[1] + 28),
              "WIN RATE", font=fonts["sm"], fill=MUTED, anchor="mm")
    draw.text(((ring_box[0] + ring_box[2]) // 2, ring_box[1] + 86),
              f"{wr:.1f}%", font=fonts["xl"], fill=wr_color, anchor="mm")
    draw.text(((ring_box[0] + ring_box[2]) // 2, ring_box[1] + 132),
              f"{stats['wins']}W / {stats['losses']}L", font=fonts["sm"], fill=MUTED, anchor="mm")

    # ── stat tiles ──────────────────────────────────────────────
    tiles = [
        ("TRADES", str(stats["trade_count"]), TEXT),
        ("BEST", fmt_pct(stats["best"]["pnl_percent"]) if stats["best"] else "—",
         ACCENT if stats["best"] and stats["best"]["pnl_percent"] >= 0 else MUTED),
        ("WORST", fmt_pct(stats["worst"]["pnl_percent"]) if stats["worst"] else "—",
         RED if stats["worst"] and stats["worst"]["pnl_percent"] < 0 else MUTED),
        ("OPEN", str(stats["open_positions"]), TEXT),
    ]
    tile_y = 318
    tile_w = 250
    gap = 18
    x = 56
    for label, value, color in tiles:
        box = [x, tile_y, x + tile_w, tile_y + 100]
        draw.rounded_rectangle(box, radius=16, fill=CARD)
        draw.text((x + 18, tile_y + 16), label, font=fonts["xs"], fill=MUTED)
        draw.text((x + 18, tile_y + 46), value, font=fonts["bold_md"], fill=color)
        x += tile_w + gap

    # ── sparkline + strategy badge ──────────────────────────────
    draw_sparkline(draw, stats["trades"], [56, 430, 760, 580], fonts["xs"])

    strat_txt = " · ".join(stats["strategies"]) if stats["strategies"] else "—"
    mode_txt = " · ".join(stats["modes"]) if stats["modes"] else "dry_run"
    draw.rounded_rectangle([790, 430, W - 56, 580], radius=16, fill=CARD)
    draw.text((812, 450), "STRATEGY", font=fonts["xs"], fill=MUTED)
    draw.text((812, 478), strat_txt, font=fonts["bold_sm"], fill=TEXT)
    draw.text((812, 522), "MODE", font=fonts["xs"], fill=MUTED)
    draw.text((812, 550), mode_txt, font=fonts["bold_sm"], fill=GOLD)

    # footer
    draw.line([56, 610, W - 56, 610], fill=LINE, width=2)
    draw.text((56, 624), "not financial advice  ·  mamayu / charon-rh  ·  dry-run first",
              font=fonts["xs"], fill=MUTED)
    # best trade ticker
    if stats["best"] and stats["best"].get("symbol"):
        right = f"best: {stats['best']['symbol']}"
        tw = draw.textlength(right, font=fonts["xs"])
        draw.text((W - 56 - tw, 624), right, font=fonts["xs"], fill=ACCENT)

    outp = Path(out_path)
    outp.parent.mkdir(parents=True, exist_ok=True)
    img.save(str(outp), "PNG", optimize=True)
    return str(outp)


def render_text_card(stats) -> str:
    net = stats["net_percent"]
    emoji = "🟢" if net >= 0 else "🔴"
    lines = [
        f"{emoji} **{stats['date']} · CHARON-RH**",
        f"Net PnL: `{fmt_pct(net)}` ({fmt_eth(stats['net_eth'])})",
        f"Win rate: `{stats['win_rate']:.1f}%` ({stats['wins']}W / {stats['losses']}L)",
        f"Trades: {stats['trade_count']}  ·  Open: {stats['open_positions']}",
    ]
    if stats["best"] and stats["best"].get("symbol"):
        lines.append(f"Best: {stats['best']['symbol']} `{fmt_pct(stats['best']['pnl_percent'])}`")
    if stats["worst"] and stats["worst"].get("symbol"):
        lines.append(f"Worst: {stats['worst']['symbol']} `{fmt_pct(stats['worst']['pnl_percent'])}`")
    if stats["strategies"]:
        lines.append(f"Strategy: {', '.join(stats['strategies'])}")
    lines.append("")
    lines.append("not financial advice · dry-run first")
    return "\n".join(lines)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default="./charon-rh.sqlite")
    ap.add_argument("--out", default="./pnl_card.png")
    ap.add_argument("--date", default=None, help="YYYY-MM-DD (default: today UTC)")
    ap.add_argument("--text", action="store_true", help="print text card only")
    args = ap.parse_args()

    day = args.date or datetime.now(timezone.utc).strftime("%Y-%m-%d")
    if not Path(args.db).exists():
        print(json.dumps({"error": f"db not found: {args.db}"}))
        sys.exit(1)

    stats = fetch_stats(args.db, day)

    if args.text:
        print(render_text_card(stats))
        return

    out = render_card(stats, args.out)
    print(json.dumps({
        "ok": True,
        "out": out,
        "date": day,
        "trade_count": stats["trade_count"],
        "net_percent": stats["net_percent"],
        "win_rate": stats["win_rate"],
        "text": render_text_card(stats),
    }))


if __name__ == "__main__":
    main()
