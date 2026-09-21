#!/usr/bin/env python3
"""Feed watch -> Discord.

Checks news feeds every few minutes and posts anything new to Discord:

  Trump · Truth Social   every post, from the trumpstruth.org archive
  InvestingLive          macro headlines: Fed, Treasury, tariffs, data reactions

Each feed posts to its own channel through its own webhook, and a feed with no
webhook set is skipped. What it has already posted is kept in state/feeds.json,
which the workflow commits after each run. Standard library only.

Test locally without posting:
  python3 feed_watch.py --dry-run
"""
from __future__ import annotations

import argparse
import html
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

FEEDS = [
    {
        "key": "trump",
        "name": "Trump · Truth Social",
        "url": "https://www.trumpstruth.org/feed",
        "webhook_env": "DISCORD_TRUMP_WEBHOOK",
        "bot_name": "Truth Social",
        "title": "Trump posted on Truth Social",
        "color": 0xE03E3E,
    },
    {
        "key": "investinglive",
        "name": "InvestingLive",
        "url": "https://investinglive.com/feed",
        "webhook_env": "DISCORD_HEADLINES_WEBHOOK",
        "bot_name": "Macro headlines",
        "title": None,  # use the headline itself
        "color": 0x2E86DE,
    },
]

STATE_FILE = Path(os.getenv("STATE_FILE", "state/feeds.json"))
MAX_PER_RUN = int(os.getenv("MAX_PER_RUN", "8"))  # stops a backlog from flooding the channel
REMEMBER = 300  # ids kept per feed
USER_AGENT = "Mozilla/5.0 (compatible; ff-news-bot/1.0)"
DISCORD_UA = "DiscordBot (https://github.com, 1.0)"


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def fetch(url: str, attempts: int = 3, pause: int = 20) -> bytes:
    error: object = None
    for attempt in range(1, attempts + 1):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=30) as resp:
                return resp.read()
        except (OSError, ValueError) as exc:
            error = exc
            if attempt < attempts:
                log(f"  attempt {attempt} failed ({exc}); retrying in {pause}s")
                time.sleep(pause)
    raise RuntimeError(f"Couldn't load {url}: {error}")


def clean(raw: str, limit: int = 400) -> str:
    text = re.sub(r"<br\s*/?>|</p>", "\n", raw or "", flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text).strip()
    return text if len(text) <= limit else text[: limit - 1].rstrip() + "…"


def parse_items(xml_bytes: bytes) -> list[dict]:
    root = ET.fromstring(xml_bytes)
    items = []
    for node in root.iter("item"):
        def text(tag: str, node: ET.Element = node) -> str:
            found = node.find(tag)
            return (found.text or "").strip() if found is not None else ""

        link = text("link") or text("guid")
        item_id = text("guid") or link
        if not item_id:
            continue
        when = None
        if text("pubDate"):
            try:
                when = parsedate_to_datetime(text("pubDate"))
                if when.tzinfo is None:
                    when = when.replace(tzinfo=timezone.utc)
            except (TypeError, ValueError):
                when = None
        items.append({
            "id": item_id,
            "link": link,
            "title": html.unescape(text("title")),
            "body": text("description"),
            "when": when,
        })
    return items


def build_embed(feed: dict, item: dict) -> dict:
    body = clean(item["body"])
    title = item["title"].strip()
    if title.startswith("[No Title]"):  # a Truth Social post that's only an image or video
        title = ""
    if feed["title"]:  # one fixed title, the post text goes in the body
        description = body or title or "(image or video post — open it to see)"
        heading = feed["title"]
    else:
        heading = title or feed["name"]
        description = body
    embed = {
        "title": heading[:250],
        "url": item["link"],
        "description": description[:1500],
        "color": feed["color"],
        "footer": {"text": feed["name"]},
    }
    if item["when"]:
        embed["timestamp"] = item["when"].astimezone(timezone.utc).isoformat().replace("+00:00", "Z")
    return embed


def post(webhook: str, payload: dict) -> None:
    body = json.dumps({"username": payload.pop("bot_name", None) or "Feed", "allowed_mentions": {"parse": []}, **payload})
    url = webhook + ("&" if "?" in webhook else "?") + "wait=true"
    for attempt in range(4):
        req = urllib.request.Request(
            url, data=body.encode("utf-8"), method="POST",
            headers={"Content-Type": "application/json", "User-Agent": DISCORD_UA},
        )
        try:
            with urllib.request.urlopen(req, timeout=30):
                return
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            if exc.code == 429 and attempt < 3:
                try:
                    wait = float(json.loads(detail).get("retry_after", 2))
                except (ValueError, AttributeError):
                    wait = 2.0
                time.sleep(wait + 0.5)
                continue
            raise RuntimeError(f"Discord rejected the post (HTTP {exc.code}): {detail[:300]}") from None


def load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def save_state(state: dict) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=1, sort_keys=True) + "\n", encoding="utf-8")


def run_feed(feed: dict, state: dict, dry_run: bool) -> int:
    # its own channel if you gave it one, otherwise the shared news channel
    webhook = os.getenv(feed["webhook_env"], "").strip() or os.getenv("DISCORD_NEWS_WEBHOOK", "").strip()
    if not webhook and not dry_run:
        log(f"{feed['name']}: no {feed['webhook_env']} secret set — skipping")
        return 0
    items = parse_items(fetch(feed["url"]))
    if not items:
        log(f"{feed['name']}: feed had no items")
        return 0
    seen = state.get(feed["key"], {}).get("seen", [])
    first_run = feed["key"] not in state

    fresh = [i for i in items if i["id"] not in set(seen)]
    fresh.sort(key=lambda i: i["when"] or datetime.min.replace(tzinfo=timezone.utc))
    posted = 0
    if first_run:
        log(f"{feed['name']}: first run, marking {len(items)} items as seen")
        if not dry_run:
            post(webhook, {"bot_name": feed["bot_name"], "content": f"Watching **{feed['name']}** — new posts land here.",
                           "embeds": []})
    else:
        skipped = max(0, len(fresh) - MAX_PER_RUN)
        for item in fresh[-MAX_PER_RUN:]:
            payload = {"bot_name": feed["bot_name"], "embeds": [build_embed(feed, item)]}
            if dry_run:
                print(json.dumps(payload, indent=2, ensure_ascii=False))
            else:
                post(webhook, payload)
                time.sleep(1.2)  # stay under Discord's webhook rate limit
            posted += 1
        if skipped:
            log(f"{feed['name']}: {skipped} older items skipped to avoid a flood")
    ids = [i["id"] for i in items] + seen
    state[feed["key"]] = {"seen": list(dict.fromkeys(ids))[:REMEMBER], "checked": datetime.now(timezone.utc).isoformat()}
    log(f"{feed['name']}: {posted} posted, {len(fresh)} new, {len(items)} in feed")
    return posted


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Post new feed items to Discord.")
    parser.add_argument("--dry-run", action="store_true", help="print what would be posted, don't post or save state")
    parser.add_argument("--feed", help="only run this feed key (trump, investinglive)")
    args = parser.parse_args(argv)

    state = load_state()
    failures = []
    for feed in FEEDS:
        if args.feed and feed["key"] != args.feed:
            continue
        try:
            run_feed(feed, state, args.dry_run)
        except Exception as exc:  # one broken feed shouldn't stop the other
            failures.append(f"{feed['name']}: {exc}")
            log(f"{feed['name']}: FAILED — {exc}")
    if not args.dry_run:
        save_state(state)
    if failures:
        log("Finished with errors:\n  " + "\n  ".join(failures))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
