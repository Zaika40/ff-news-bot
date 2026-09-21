#!/usr/bin/env python3
"""FF News -> Discord.

Posts Forex Factory calendar events (USD red + orange folders by default)
to a Discord channel through a webhook:

  morning   weekdays 7:00 AM ET   today's events, split around your session
  open      weekdays 9:30 AM ET   what's still ahead today (pings the channel)
  week      Sundays  5:00 PM ET   the week ahead, day by day

Built to run on GitHub Actions (.github/workflows/ff-news.yml), but it runs
anywhere with Python 3.9+. Standard library only.

Test locally without posting:
  python3 ff_news.py --post morning --dry-run
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime, time as dtime, timedelta
from zoneinfo import ZoneInfo

FEED_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"
ET = ZoneInfo("America/New_York")
FEED_UA = "Mozilla/5.0 (compatible; ff-news-bot/1.0)"
DISCORD_UA = "DiscordBot (https://github.com, 1.0)"
BOT_NAME = "FF News"

# ---- settings (change them in the workflow's env: block) ------------------
CURRENCIES = [c.strip().upper() for c in os.getenv("CURRENCIES", "USD").split(",") if c.strip()]
IMPACTS = [i.strip().capitalize() for i in os.getenv("IMPACTS", "High,Medium").split(",") if i.strip()]
SESSION = os.getenv("SESSION", "09:30-11:00")
OPEN_PING = os.getenv("OPEN_PING", "").strip()
# Talks that move the tape even when Forex Factory tags them low impact:
SPEAKERS = [s.strip().lower() for s in os.getenv("SPEAKERS", "FOMC,Fed Chair,Fed Gov,Treasury Sec").split(",") if s.strip()]
# Everything outside your currencies that ran overnight, so you know what set the tone:
GLOBAL_IMPACTS = [i.strip().capitalize() for i in os.getenv("GLOBAL_IMPACTS", "High").split(",") if i.strip()]
OVERNIGHT_FROM = os.getenv("OVERNIGHT_FROM", "17:00")  # previous day, ET

# GitHub cron runs on UTC, so every post has one cron line for EDT (UTC-4) and
# one for EST (UTC-5). The line that doesn't match today's clock exits right
# away. The other one starts 10 minutes early and waits for the exact post
# time, because GitHub often starts scheduled runs a few minutes late.
# These strings must match the cron lines in ff-news.yml exactly.
SCHEDULES = {
    "50 10 * * 1-5": ("morning", -4),
    "50 11 * * 1-5": ("morning", -5),
    "20 13 * * 1-5": ("open", -4),
    "20 14 * * 1-5": ("open", -5),
    "50 20 * * 0": ("week", -4),
    "50 21 * * 0": ("week", -5),
}
POST_TIMES = {"morning": dtime(7, 0), "open": dtime(9, 30), "week": dtime(17, 0)}
MAX_LATE = timedelta(hours=2)  # skip a scheduled post if GitHub starts it later than this

IMPACT_DOT = {"High": "🔴", "Medium": "🟠", "Low": "🟡"}
IMPACT_WORD = {"High": "red", "Medium": "orange", "Low": "yellow"}
RED, ORANGE, GRAY = 0xE03E3E, 0xF08C2E, 0x7F8C8D


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


# ---- calendar data ---------------------------------------------------------
def fetch_feed(attempts: int = 5, pause: int = 75) -> list:
    """Download this week's calendar (Sun-Sat, times in ET).

    Forex Factory allows about 2 downloads per 5 minutes per IP and answers
    with an HTML "Request Denied" page past that, so retry slowly.
    """
    error: object = None
    for attempt in range(1, attempts + 1):
        try:
            req = urllib.request.Request(FEED_URL, headers={"User-Agent": FEED_UA})
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8", "replace"))
            if isinstance(data, list):
                return data
            error = "unexpected response"
        except (OSError, ValueError) as exc:  # network error, HTTP error, or HTML instead of JSON
            error = exc
        if attempt < attempts:
            log(f"Feed attempt {attempt} failed ({error}); retrying in {pause}s")
            time.sleep(pause)
    raise RuntimeError(f"Couldn't load the Forex Factory feed: {error}")


def parse_events(raw: list) -> list[dict]:
    events = []
    for item in raw:
        try:
            when = datetime.fromisoformat(item["date"]).astimezone(ET)
        except (KeyError, TypeError, ValueError):
            continue
        events.append({
            "title": str(item.get("title") or "").strip(),
            "country": str(item.get("country") or "").strip().upper(),
            "impact": str(item.get("impact") or "").strip().capitalize(),
            "when": when,
            "forecast": str(item.get("forecast") or "").strip(),
            "previous": str(item.get("previous") or "").strip(),
        })
    events.sort(key=lambda e: e["when"])
    return events


def is_speaker(e: dict) -> bool:
    title = e["title"].lower()
    return e["country"] in CURRENCIES and any(word in title for word in SPEAKERS)


def is_wanted(e: dict) -> bool:
    return (e["country"] in CURRENCIES and e["impact"] in IMPACTS) or is_speaker(e)


def is_global(e: dict) -> bool:
    return e["country"] not in CURRENCIES and e["impact"] in GLOBAL_IMPACTS


def overnight(events: list[dict], day: date) -> list[dict]:
    """Everything outside your currencies between yesterday evening and the open."""
    start = datetime.combine(day - timedelta(days=1), dtime.fromisoformat(OVERNIGHT_FROM), ET)
    end = session_window(day)[0]
    return [e for e in events if is_global(e) and start <= e["when"] < end]


def is_holiday(e: dict) -> bool:
    return e["country"] in CURRENCIES and e["impact"] == "Holiday"


def on_day(events: list[dict], day: date) -> list[dict]:
    return [e for e in events if e["when"].date() == day]


# ---- formatting ------------------------------------------------------------
def md(text: str) -> str:
    """Escape Discord markdown characters that show up in feed text."""
    for ch in "\\*_~`|":
        text = text.replace(ch, "\\" + ch)
    return text


def clock(dt: datetime) -> str:
    if (dt.hour, dt.minute) == (0, 0):
        return "All day"
    return dt.strftime("%I:%M %p").lstrip("0")


def currency_label() -> str:
    return "/".join(CURRENCIES)


def folders_label() -> str:
    words = [IMPACT_WORD.get(i, i.lower()) for i in IMPACTS]
    return words[0] if len(words) == 1 else ", ".join(words[:-1]) + " or " + words[-1]


def day_label(day: date) -> str:
    return f"{day:%a %b} {day.day}"


def dot_for(e: dict) -> str:
    if e["impact"] in IMPACTS:
        return IMPACT_DOT.get(e["impact"], "•")
    return "🎙️" if is_speaker(e) else IMPACT_DOT.get(e["impact"], "•")


def event_line(e: dict, show_country: bool | None = None, day: date | None = None) -> str:
    if show_country is None:
        show_country = len(CURRENCIES) > 1
    when = clock(e["when"])
    if day is not None and e["when"].date() != day:  # e.g. an Asia release from last night
        when = f"{e['when']:%a} {when}"
    line = f"{dot_for(e)} **{when}** — {md(e['title'])}"
    if show_country:
        line += f" ({e['country']})"
    numbers = []
    if e["forecast"]:
        numbers.append(f"fcst {md(e['forecast'])}")
    if e["previous"]:
        numbers.append(f"prev {md(e['previous'])}")
    if numbers:
        line += "  ·  " + " · ".join(numbers)
    return line


def done_line(e: dict) -> str:
    return f"~~{clock(e['when'])} — {md(e['title'])}~~"


def holiday_lines(events: list[dict]) -> list[str]:
    lines = []
    for e in events:
        if is_holiday(e):
            suffix = f" ({e['country']})" if len(CURRENCIES) > 1 else ""
            lines.append(f"🏦 {md(e['title'])}{suffix}")
    return lines


def add_section(lines: list[str], header: str, items: list[str]) -> None:
    if lines:
        lines.append("")
    lines.append(f"**{header}**")
    lines.extend(items)


def session_window(day: date) -> tuple[datetime, datetime]:
    start, end = (dtime.fromisoformat(part.strip()) for part in SESSION.split("-"))
    return datetime.combine(day, start, ET), datetime.combine(day, end, ET)


def session_label() -> str:
    start, end = (part.strip().lstrip("0") for part in SESSION.split("-"))
    return f"{start}–{end}"


def make_embed(title: str, lines: list[str], events: list[dict]) -> dict:
    impacts = {e["impact"] for e in events}
    color = RED if "High" in impacts else ORANGE if "Medium" in impacts else GRAY
    description = "\n".join(lines).strip()
    if len(description) > 4000:  # Discord's embed limit is 4096
        description = description[:3990].rsplit("\n", 1)[0] + "\n…"
    return {
        "title": title,
        "description": description,
        "color": color,
        "footer": {"text": "Forex Factory · times in ET"},
    }


# ---- the three posts -------------------------------------------------------
def build_morning(events: list[dict], day: date) -> dict:
    todays = on_day(events, day)
    wanted = [e for e in todays if is_wanted(e)]
    lines = holiday_lines(todays)
    if not wanted:
        lines.append(f"No {folders_label()} {currency_label()} news today.")
    else:
        start, end = session_window(day)
        groups = [
            ("Before the open", [e for e in wanted if e["when"] < start]),
            (f"Your session · {session_label()}", [e for e in wanted if start <= e["when"] <= end]),
            ("Later today", [e for e in wanted if e["when"] > end]),
        ]
        for header, group in groups:
            if group:
                add_section(lines, header, [event_line(e) for e in group])
    overnight_events = overnight(events, day)
    if overnight_events:
        add_section(lines, "Overnight, rest of the world",
                    [event_line(e, show_country=True, day=day) for e in overnight_events])
    title = f"📅 {currency_label()} news · {day_label(day)}"
    return {"embeds": [make_embed(title, lines, wanted)]}


def build_open(events: list[dict], day: date, now: datetime) -> dict:
    todays = on_day(events, day)
    wanted = [e for e in todays if is_wanted(e)]
    cutoff = now - timedelta(minutes=1)  # a 9:30 release still counts as ahead at 9:30
    ahead = [e for e in wanted if e["when"] > cutoff]
    done = [e for e in wanted if e["when"] <= cutoff]
    lines = holiday_lines(todays)
    if not wanted:
        lines.append(f"No {folders_label()} {currency_label()} news today.")
    else:
        add_section(lines, "Still ahead", [event_line(e) for e in ahead] or ["Nothing else today."])
        if done:
            add_section(lines, "Already out", [done_line(e) for e in done])
    payload = {"embeds": [make_embed(f"🔔 NY open · {day_label(day)}", lines, ahead)]}
    if OPEN_PING and ahead:  # only ping when there's still news to trade around
        payload["content"] = OPEN_PING
    return payload


def week_monday(day: date) -> date:
    if day.weekday() == 6:  # Sunday -> the week starting tomorrow
        return day + timedelta(days=1)
    if day.weekday() == 5:  # Saturday -> next week
        return day + timedelta(days=2)
    return day - timedelta(days=day.weekday())


def week_in_feed(events: list[dict], monday: date) -> bool:
    friday = monday + timedelta(days=4)
    return any(monday <= e["when"].date() <= friday for e in events)


def build_week(events: list[dict], day: date) -> dict | None:
    monday = week_monday(day)
    if not week_in_feed(events, monday):
        return None  # Forex Factory hasn't rolled the feed over to this week yet
    lines: list[str] = []
    shown: list[dict] = []
    for offset in range(5):
        d = monday + timedelta(days=offset)
        todays = on_day(events, d)
        wanted = [e for e in todays if is_wanted(e)]
        shown += wanted
        items = holiday_lines(todays) + [event_line(e) for e in wanted]
        add_section(lines, f"{d:%a} {d.month}/{d.day}", items or [f"*No {folders_label()} news*"])
    title = f"🗓️ {currency_label()} news · week of {monday:%b} {monday.day}"
    return {"embeds": [make_embed(title, lines, shown)]}


def week_unavailable(day: date) -> dict:
    monday = week_monday(day)
    lines = ["Forex Factory hasn't published this week's calendar yet. "
             "The daily 7:00 AM list will still post."]
    return {"embeds": [make_embed(f"🗓️ {currency_label()} news · week of {monday:%b} {monday.day}", lines, [])]}


def build(post: str, events: list[dict], day: date, now: datetime) -> dict | None:
    if post == "morning":
        return build_morning(events, day)
    if post == "open":
        return build_open(events, day, now)
    return build_week(events, day)


# ---- Discord ---------------------------------------------------------------
def send(webhook: str, payload: dict) -> None:
    pinging = bool(payload.get("content"))
    body = {
        "username": BOT_NAME,
        "allowed_mentions": {"parse": ["everyone", "roles", "users"] if pinging else []},
        **payload,
    }
    data = json.dumps(body).encode("utf-8")
    url = webhook + ("&" if "?" in webhook else "?") + "wait=true"
    for attempt in range(4):
        req = urllib.request.Request(
            url, data=data, method="POST",
            headers={"Content-Type": "application/json", "User-Agent": DISCORD_UA},
        )
        try:
            with urllib.request.urlopen(req, timeout=30):
                return
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            if exc.code == 429 and attempt < 3:
                try:
                    retry_after = float(json.loads(detail).get("retry_after", 2))
                except (ValueError, AttributeError):
                    retry_after = 2.0
                time.sleep(retry_after + 0.5)
                continue
            raise RuntimeError(f"Discord rejected the post (HTTP {exc.code}): {detail[:300]}") from None


# ---- scheduling --------------------------------------------------------------
def plan(cron: str, now: datetime) -> tuple[str | None, str]:
    """Which post a cron line should send right now, or (None, reason) to skip."""
    if cron not in SCHEDULES:
        raise ValueError(f"Unknown schedule {cron!r} — the cron lines in ff-news.yml "
                         "and SCHEDULES in ff_news.py must match.")
    post, offset = SCHEDULES[cron]
    if now.utcoffset() != timedelta(hours=offset):
        return None, f"{post}: this cron line is for UTC{offset:+d}; the clock is on the other one"
    target = datetime.combine(now.date(), POST_TIMES[post], ET)
    if now - target > MAX_LATE:
        return None, f"{post}: GitHub started this run {now - target} late"
    return post, "ok"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Post Forex Factory news to Discord.")
    parser.add_argument("--post", choices=list(POST_TIMES),
                        help="send this post right now (default: decide from the GitHub schedule)")
    parser.add_argument("--date", help="pretend today is YYYY-MM-DD (testing)")
    parser.add_argument("--now", help="pretend the time is HH:MM ET (testing the 9:30 split)")
    parser.add_argument("--feed-file", help="read the calendar from a saved JSON file (testing)")
    parser.add_argument("--dry-run", action="store_true", help="print the Discord payload instead of posting")
    args = parser.parse_args(argv)

    now = datetime.now(ET)
    post = args.post or os.getenv("MANUAL_POST", "").strip() or None
    scheduled = post is None
    if scheduled:
        post, reason = plan(os.getenv("SCHEDULE", "").strip(), now)
        if post is None:
            log(f"Skipping — {reason}.")
            return 0

    webhook = os.getenv("DISCORD_WEBHOOK_URL", "").strip()
    if not args.dry_run and not webhook.startswith("https://"):
        log("The DISCORD_WEBHOOK_URL secret is missing. Add it in the repo under "
            "Settings → Secrets and variables → Actions.")
        return 1

    def load() -> list[dict]:
        if args.feed_file:
            with open(args.feed_file, encoding="utf-8") as fh:
                return parse_events(json.load(fh))
        return parse_events(fetch_feed())

    events = load()  # fetch before waiting, so feed retries have time to work
    day = date.fromisoformat(args.date) if args.date else now.date()

    if scheduled:
        wait = (datetime.combine(day, POST_TIMES[post], ET) - datetime.now(ET)).total_seconds()
        if wait > 0:
            log(f"Waiting {wait / 60:.1f} min to post at {POST_TIMES[post]:%H:%M} ET")
            time.sleep(wait)

    if args.now:
        ref = datetime.combine(day, dtime.fromisoformat(args.now), ET)
    elif args.date:
        ref = datetime.combine(day, POST_TIMES[post], ET)
    else:
        ref = datetime.now(ET)

    payload = build(post, events, day, ref)
    if payload is None and scheduled:
        log("This week isn't in the feed yet; fetching it once more")
        events = load()
        payload = build(post, events, day, ref)
    if payload is None:
        payload = week_unavailable(day)

    if args.dry_run:
        print(json.dumps(payload, indent=2, ensure_ascii=False))
        return 0
    send(webhook, payload)
    log(f"Posted the {post} update for {day}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
