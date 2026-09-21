/**
 * FF news watcher — Cloudflare Worker.
 *
 * Checks the feeds every minute and posts anything new to Discord. Same job as
 * feed_watch.py, just on a one-minute clock instead of GitHub's five.
 *
 * Bindings it needs:
 *   STATE            KV namespace, remembers what it has already posted
 *   DISCORD_WEBHOOK  secret, the webhook for your news channel
 *   TRUMP_WEBHOOK    optional secret, Trump posts go here instead
 *   HEADLINES_WEBHOOK optional secret, headlines go here instead
 */

export const FEEDS = [
  {
    key: "trump",
    name: "Trump · Truth Social",
    url: "https://www.trumpstruth.org/feed",
    webhook: "TRUMP_WEBHOOK",
    botName: "Truth Social",
    fixedTitle: "Trump posted on Truth Social",
    color: 0xe03e3e,
  },
  {
    key: "investinglive",
    name: "InvestingLive",
    url: "https://investinglive.com/feed",
    webhook: "HEADLINES_WEBHOOK",
    botName: "Macro headlines",
    fixedTitle: null, // the headline is the title
    color: 0x2e86de,
  },
];

const STATE_KEY = "state";
const MAX_PER_RUN = 6; // a backlog can't flood the channel
const MAX_ITEMS = 25; // only the newest slice of each feed is parsed (CPU is capped)
const REMEMBER = 120; // ids kept per feed

const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  if (!m) return "";
  return m[1].replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "").trim();
};

const entities = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " ", "#8217": "’", "#8216": "‘", "#8220": "“", "#8221": "”" };

export function clean(raw, limit = 400) {
  let text = (raw || "")
    .replace(/<br\s*\/?>|<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#?\w+);/g, (whole, code) => (code in entities ? entities[code] : whole))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length > limit) text = text.slice(0, limit - 1).trimEnd() + "…";
  return text;
}

export function parseItems(xml) {
  const items = [];
  const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = re.exec(xml)) && items.length < MAX_ITEMS) {
    const block = match[1];
    const link = tag(block, "link") || tag(block, "guid");
    const id = tag(block, "guid") || link;
    if (!id) continue;
    const pub = tag(block, "pubDate");
    const when = pub ? Date.parse(pub) : NaN;
    items.push({
      id,
      link,
      title: clean(tag(block, "title"), 250),
      body: tag(block, "description"),
      when: Number.isNaN(when) ? 0 : when,
    });
  }
  return items;
}

export function buildEmbed(feed, item) {
  const body = clean(item.body);
  const title = item.title.startsWith("[No Title]") ? "" : item.title;
  const heading = feed.fixedTitle || title || feed.name;
  const description = feed.fixedTitle
    ? body || title || "(image or video post — open it to see)"
    : body;
  const embed = {
    title: heading.slice(0, 250),
    url: item.link,
    description: description.slice(0, 1500),
    color: feed.color,
    footer: { text: feed.name },
  };
  if (item.when) embed.timestamp = new Date(item.when).toISOString();
  return embed;
}

async function postToDiscord(webhook, payload) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "DiscordBot (https://workers.dev, 1.0)" },
      body: JSON.stringify({ allowed_mentions: { parse: [] }, ...payload }),
    });
    if (res.ok) return;
    if (res.status === 429) {
      const info = await res.json().catch(() => ({}));
      await new Promise((r) => setTimeout(r, (info.retry_after || 2) * 1000 + 500));
      continue;
    }
    throw new Error(`Discord ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  throw new Error("Discord kept rate limiting the webhook");
}

async function checkFeed(feed, state, env) {
  const webhook = (env[feed.webhook] || "").trim() || (env.DISCORD_WEBHOOK || "").trim();
  if (!webhook) return { feed: feed.key, skipped: "no webhook" };

  const res = await fetch(feed.url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; ff-news-bot/1.0)" } });
  if (!res.ok) throw new Error(`${feed.name}: feed returned ${res.status}`);
  const items = parseItems(await res.text());
  if (!items.length) return { feed: feed.key, skipped: "empty feed" };

  const previous = state[feed.key];
  const seen = new Set(previous ? previous.seen : []);
  const fresh = items.filter((i) => !seen.has(i.id)).sort((a, b) => a.when - b.when);

  let posted = 0;
  if (!previous) {
    await postToDiscord(webhook, {
      username: feed.botName,
      content: `Watching **${feed.name}** — new posts land here.`,
    });
  } else {
    for (const item of fresh.slice(-MAX_PER_RUN)) {
      await postToDiscord(webhook, { username: feed.botName, embeds: [buildEmbed(feed, item)] });
      posted++;
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  const ids = items.map((i) => i.id).concat(previous ? previous.seen : []);
  const kept = [...new Set(ids)].slice(0, REMEMBER);
  // Untouched state means no KV write: the free plan allows 1,000 a day and this runs 1,440 times.
  if (!previous || kept.join("\n") !== previous.seen.join("\n")) {
    state[feed.key] = { seen: kept, updated: new Date().toISOString() };
  }
  return { feed: feed.key, posted, fresh: fresh.length, inFeed: items.length };
}

export async function check(env) {
  const state = (await env.STATE.get(STATE_KEY, "json")) || {};
  const before = JSON.stringify(state);
  const report = [];
  for (const feed of FEEDS) {
    try {
      report.push(await checkFeed(feed, state, env));
    } catch (err) {
      report.push({ feed: feed.key, error: String(err).slice(0, 200) });
    }
  }
  // Only write when something changed: the free KV plan allows 1,000 writes a day.
  if (JSON.stringify(state) !== before) await env.STATE.put(STATE_KEY, JSON.stringify(state));
  return report;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(check(env).then((r) => console.log(JSON.stringify(r))));
  },
  async fetch(request, env) {
    const state = (await env.STATE.get(STATE_KEY, "json")) || {};
    const status = Object.fromEntries(
      FEEDS.map((f) => [f.key, state[f.key] ? { lastNewPost: state[f.key].updated, remembered: state[f.key].seen.length } : "not started"]),
    );
    return new Response(JSON.stringify({ watcher: "ff-news", status }, null, 1), {
      headers: { "Content-Type": "application/json" },
    });
  },
};
