# FF News bot

Posts Forex Factory's USD red and orange folder news to your Discord channel. All times are ET.

| When | What it posts |
|---|---|
| Weekdays 7:00 AM | Today's news, split into before the open, your 9:30–11:00 session, and later, plus what ran overnight in Asia and Europe |
| Weekdays 9:30 AM | What's still ahead today, with an @everyone ping (no ping if nothing's left) |
| Sundays 5:00 PM | The week ahead, day by day |

Fed and Treasury speakers are always included, even when Forex Factory tags them low impact.

It runs free on GitHub, so your computer doesn't need to be on.

## Setup (about 10 minutes)

**1. Make a Discord webhook**
In your server, hover over the channel and click the gear (Edit Channel). Then go to Integrations → Webhooks → New Webhook, click the new webhook and hit **Copy Webhook URL**.

**2. Make a GitHub repo**
Go to github.com/new, name it `ff-news-bot`, pick **Public** and click Create repository. Public keeps the Actions minutes free, and nothing secret lives in the repo — the webhook goes in as a secret in step 5.

**3. Add the script**
On the new repo page, click **uploading an existing file**, drag in `ff_news.py`, then click Commit changes.

**4. Add the schedule**
Click Add file → **Create new file**. In the name box, type `.github/workflows/ff-news.yml` (each `/` makes a folder). Paste in everything from `ff-news.yml`, then click Commit changes.

**5. Add the webhook as a secret**
Go to Settings → Secrets and variables → Actions → **New repository secret**. Set the name to `DISCORD_WEBHOOK_URL`, paste the webhook URL as the secret, and click Add secret.

**6. Test it**
Go to the Actions tab, pick **FF News** on the left, click **Run workflow**, choose `week` and click Run. The post should show up in your channel within about a minute.

After that it runs on its own. If a run ever fails, GitHub emails you.

## The live feeds (feed_watch.py)

A second workflow checks two feeds every 5 minutes and posts anything new:

| Feed | What lands | Webhook secret |
|---|---|---|
| Trump · Truth Social | every post, from the trumpstruth.org archive | `DISCORD_TRUMP_WEBHOOK` |
| InvestingLive | macro headlines: Fed, Treasury, tariffs, data reactions | `DISCORD_HEADLINES_WEBHOOK` |

Both feeds in one channel: make one webhook and add it as a single secret called `DISCORD_NEWS_WEBHOOK`. Posts still say which feed they came from. Want them split later? Add `DISCORD_TRUMP_WEBHOOK` and `DISCORD_HEADLINES_WEBHOOK` — each one takes over for its feed. With no secret at all, the watcher just skips. The first check posts a short "watching this" line and nothing else — the backlog stays quiet.

Expect posts a few minutes behind real time: the Trump archive checks Truth Social every few minutes and GitHub runs the 5-minute schedule when it gets to it, so call it 5–15 minutes. Good for context, not for trading the headline. A $3/month relay like TweetShift gets that to about a minute if the lag starts costing you.

## Terminal shortcut (if you use the `gh` CLI)

```bash
gh repo create ff-news-bot --private --clone && cd ff-news-bot
mkdir -p .github/workflows
cp /path/to/ff_news.py . && cp /path/to/ff-news.yml .github/workflows/
git add . && git commit -m "FF news bot" && git push -u origin HEAD
gh secret set DISCORD_WEBHOOK_URL        # paste the URL when asked
gh workflow run "FF News" -f post=week
```

## Changing it

Edit the `env:` block at the bottom of `.github/workflows/ff-news.yml`:

- `CURRENCIES`: `"USD"`, or something like `"USD,EUR"`
- `IMPACTS`: `"High"` for red only, `"High,Medium"` for red and orange
- `SESSION`: your trading window, used to split the morning list
- `OPEN_PING`: who the 9:30 post pings. Use `""` for no ping, or `"<@YOUR_USER_ID>"` to ping just you
- `SPEAKERS`: title words that get included whatever the folder color (Fed and Treasury talks)
- `GLOBAL_IMPACTS`: what counts for the overnight block from other currencies. `""` drops the block
- `OVERNIGHT_FROM`: when the overnight block starts the evening before

To change the post times, edit the cron lines **and** the matching `SCHEDULES` table in `ff_news.py`. GitHub cron runs on UTC, so each time has one line for summer (EDT) and one for winter (EST).

## Good to know

- GitHub sometimes starts scheduled runs a few minutes late. To stay on time, the bot starts 10 minutes early and waits.
- The runs use about 600 of the 2,000 free GitHub Actions minutes a month that private repos get.
- The Forex Factory feed has no "actual" numbers, only forecast and previous.
