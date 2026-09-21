#!/usr/bin/env python3
"""Save the Forex Factory weekly calendar into data/calendar.json.

Forex Factory rate limits by IP, and Cloudflare Workers go out through shared
addresses that are permanently over that limit — the worker gets a 429 every
time. GitHub's runners aren't, so this snapshots the feed into the repo and the
worker reads the snapshot instead. The feed covers a whole week (Sun–Sat), so
even a snapshot from this morning still has the rest of the week in it.
"""
import json
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json"
OUT = Path("data/calendar.json")
USER_AGENT = "Mozilla/5.0 (compatible; ff-news-bot/1.0)"


def fetch(attempts: int = 5, pause: int = 70) -> list:
    error: object = None
    for attempt in range(1, attempts + 1):
        try:
            req = urllib.request.Request(URL, headers={"User-Agent": USER_AGENT})
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read().decode("utf-8", "replace"))
            if isinstance(data, list) and data:
                return data
            error = "unexpected response"
        except (OSError, ValueError) as exc:  # network, HTTP error, or the HTML "Request Denied" page
            error = exc
        if attempt < attempts:
            print(f"attempt {attempt} failed ({error}); retrying in {pause}s", file=sys.stderr)
            time.sleep(pause)
    raise SystemExit(f"Couldn't download the calendar: {error}")


events = fetch()
OUT.parent.mkdir(parents=True, exist_ok=True)
snapshot = {"fetched": datetime.now(timezone.utc).isoformat(timespec="seconds"), "events": events}
OUT.write_text(json.dumps(snapshot) + "\n", encoding="utf-8")
print(f"saved {len(events)} events to {OUT}")
