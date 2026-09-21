# FF News bot

Posts Forex Factory's USD red and orange folder news to your calendar channel, plus Trump's Truth Social posts and macro headlines to your news channel. All times are ET.

| When | Channel | What it posts |
|---|---|---|
| Weekdays 7:00 AM | calendar | Today's news, split into before the open, your 9:30–11:00 session, and later, plus what ran overnight in Asia and Europe |
| Weekdays 9:30 AM | calendar | What's still ahead today, with an @everyone ping (no ping if nothing's left) |
| Sundays 5:00 PM | calendar | The week ahead, day by day |
| Weekdays 7:00 AM – noon | news | Trump posts and macro headlines, live, within a minute or two |
| Sundays 6–10 PM | news | Same, for the futures open |
| Everything else | — | Muted. New items are held and arrive as one catch-up list when the next window opens |

Fed and Treasury speakers are always included, even when Forex Factory tags them low impact.

All of it runs on a Cloudflare Worker (`worker.js`) that fires every minute, so your computer doesn't need to be on.

## How it's wired

| Piece | Where |
|---|---|
| `worker.js` | the whole bot — calendar posts and live feeds |
| `wrangler.toml` | worker config: the every-minute cron and the KV namespace |
| `snapshot_calendar.py` | GitHub Action, every 4 hours: saves the Forex Factory week into `data/calendar.json` |
| Cloudflare secrets | `CALENDAR_WEBHOOK` (calendar channel), `DISCORD_WEBHOOK` (news channel) |
| Optional secrets | `TRUMP_WEBHOOK`, `HEADLINES_WEBHOOK` to split the two feeds into separate channels |
| KV `STATE` | what it has already posted, and anything held during muted hours |
| GitHub Actions | manual backup only. `ff_news.py` and `feed_watch.py` still work from the Actions tab, on the `DISCORD_WEBHOOK_URL` and `DISCORD_NEWS_WEBHOOK` secrets in this repo |

Pushing to `main` redeploys the worker automatically.

## Changing it

Edit the settings block at the top of `worker.js`:

- `LIVE_WINDOWS` — when the feeds are allowed to post
- `CALENDAR_POSTS` — the times of the three calendar posts
- `CURRENCIES` / `IMPACTS` — which events make the cut
- `SPEAKERS` — title words that get in whatever the folder color
- `GLOBAL_IMPACTS` — what counts for the overnight block
- `SESSION` — your trading window, used to split the morning list
- `OPEN_PING` — who the 9:30 post pings. `""` for no ping, `"<@YOUR_USER_ID>"` to ping just you

## Good to know

- Forex Factory rate limits by IP, and Cloudflare's shared addresses are always over the line — the worker gets a 429 every time it asks. That's why the calendar comes from `data/calendar.json`, which a GitHub Action refreshes every 4 hours. The feed covers a full week, so a missed refresh costs nothing.
- The Forex Factory feed has no "actual" numbers, only forecast and previous.
- `/debug` on the worker URL shows whether the calendar loaded, which source it came from, and the last error it hit. It posts nothing.
- If a calendar post fails (feed down, rate limited), the worker retries every 5 minutes for half an hour, then gives up until the next scheduled post.
- Trump posts land 1–3 minutes late. The floor isn't the worker, it's the trumpstruth.org archive checking Truth Social every few minutes.
- Opening the worker's URL shows a status page: Eastern time, whether it's live or muted, what it's posted today, and how many items are held.

## The GitHub backup

Before the worker, this ran on GitHub Actions. Those workflows are still here with their schedules switched off, so you can fire either one by hand from the **Actions** tab if Cloudflare ever goes quiet:

| Workflow | Run it with | Uses secret |
|---|---|---|
| FF News | `morning`, `open` or `week` | `DISCORD_WEBHOOK_URL` (calendar channel) |
| Feed watch | no input | `DISCORD_NEWS_WEBHOOK` (news channel) |

Those two repo secrets are separate from the Cloudflare ones — same webhooks, stored twice.

`ff_news.py` and `feed_watch.py` are the Python versions of what the worker does. They read their settings from the `env:` block in each workflow file.

## If you ever need to rebuild it

1. Discord: a webhook in the calendar channel and one in the news channel (channel gear → Integrations → Webhooks → New Webhook → Copy Webhook URL).
2. Cloudflare: a Worker deployed from this repo, a KV namespace bound as `STATE`, the two webhook secrets, and a `* * * * *` cron trigger. `wrangler.toml` carries the cron and the KV id.
3. Push to `main` — the worker redeploys itself.
