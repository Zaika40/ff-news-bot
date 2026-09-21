/**
 * FF news bot — Cloudflare Worker. Runs every minute.
 *
 * Two jobs:
 *   1. Calendar posts to the calendar channel, on Eastern time:
 *        weekdays 7:00 AM   today's USD news, split around your session
 *        weekdays 9:30 AM   what's still ahead, with a ping
 *        Sundays  5:00 PM   the week ahead
 *   2. Live feeds to the news channel: Trump's Truth Social and InvestingLive.
 *      These only post inside your live windows (weekdays 7:00–12:00 and
 *      Sunday 6–10 PM). Anything that lands while muted is held and posted as
 *      one catch-up list when the next window opens.
 *
 * Bindings:
 *   STATE              KV namespace
 *   DISCORD_WEBHOOK    news channel (feeds)
 *   CALENDAR_WEBHOOK   calendar channel
 *   TRUMP_WEBHOOK / HEADLINES_WEBHOOK   optional, split the feeds up
 */

const ET = "America/New_York";
const STATE_KEY = "state";
const FEED_UA = "Mozilla/5.0 (compatible; ff-news-bot/1.0)";
const DISCORD_UA = "DiscordBot (https://workers.dev, 1.0)";

// ---- when things happen (Eastern, minutes past midnight) -------------------
const LIVE_WINDOWS = [
  { days: [1, 2, 3, 4, 5], from: 7 * 60, to: 12 * 60 }, // weekdays 7:00 AM – noon
  { days: [0], from: 18 * 60, to: 22 * 60 }, // Sunday 6–10 PM, the futures open
];

const CALENDAR_POSTS = [
  { key: "morning", days: [1, 2, 3, 4, 5], at: 7 * 60 },
  { key: "open", days: [1, 2, 3, 4, 5], at: 9 * 60 + 30 },
  { key: "week", days: [0], at: 17 * 60 },
];
const CATCH_UP_MINUTES = 30; // how long a missed calendar post may still go out

// ---- feeds -----------------------------------------------------------------
const FEEDS = [
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
    fixedTitle: null,
    color: 0x2e86de,
  },
];
const MAX_PER_RUN = 6; // live posts per check
const MAX_HELD = 40; // items held per feed while muted
const CATCH_UP_LINES = 15; // lines in the catch-up list
const REMEMBER = 120; // post ids remembered per feed
const MAX_ITEMS = 25; // newest items parsed per feed

// ---- calendar --------------------------------------------------------------
const CALENDAR_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const CURRENCIES = ["USD"];
const IMPACTS = ["High", "Medium"];
const SPEAKERS = ["fomc", "fed chair", "fed gov", "treasury sec"];
const GLOBAL_IMPACTS = ["High"]; // other currencies, overnight block
const OVERNIGHT_FROM = 17 * 60; // 5 PM the evening before
const SESSION = { from: 9 * 60 + 30, to: 11 * 60, label: "9:30–11:00" };
const OPEN_PING = "@everyone"; // "" for no ping on the 9:30 post
const DOT = { High: "🔴", Medium: "🟠", Low: "🟡" };
const RED = 0xe03e3e;
const ORANGE = 0xf08c2e;
const GRAY = 0x7f8c8d;

// ---- time ------------------------------------------------------------------
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function etNow(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: ET, hour12: false, weekday: "short",
      year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  const hour = Number(parts.hour) % 24;
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    dow: DAYS.indexOf(parts.weekday),
    minutes: hour * 60 + Number(parts.minute),
  };
}

export const inLiveWindow = (t) =>
  LIVE_WINDOWS.some((w) => w.days.includes(t.dow) && t.minutes >= w.from && t.minutes < w.to);

export function dueCalendarPost(t, done) {
  for (const post of CALENDAR_POSTS) {
    if (!post.days.includes(t.dow)) continue;
    const late = t.minutes - post.at;
    if (late < 0 || late >= CATCH_UP_MINUTES) continue;
    if (late % 5 !== 0) continue; // retry every 5 min, not every minute
    if (done[post.key] === t.date) continue;
    return post.key;
  }
  return null;
}

const shiftDate = (date, days) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const clock = (minutes) => {
  if (minutes === 0) return "All day";
  const h = Math.floor(minutes / 60);
  const m = String(minutes % 60).padStart(2, "0");
  const suffix = h < 12 ? "AM" : "PM";
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${m} ${suffix}`;
};

const prettyDate = (date) => {
  const [y, m, d] = date.split("-").map(Number);
  const dow = DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
  return `${dow} ${MONTHS[m - 1]} ${d}`;
};

// ---- text ------------------------------------------------------------------
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " ", "#8217": "’", "#8216": "‘", "#8220": "“", "#8221": "”" };

export function clean(raw, limit = 400) {
  let text = (raw || "")
    .replace(/<br\s*\/?>|<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&(#?\w+);/g, (whole, code) => (code in ENTITIES ? ENTITIES[code] : whole))
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (text.length > limit) text = text.slice(0, limit - 1).trimEnd() + "…";
  return text;
}

const md = (text) => (text || "").replace(/([\\*_~`|])/g, "\\$1");

// ---- http ------------------------------------------------------------------
async function getText(url) {
  const res = await fetch(url, { headers: { "User-Agent": FEED_UA } });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  return res.text();
}

export async function postToDiscord(webhook, payload) {
  const body = { allowed_mentions: { parse: payload.content ? ["everyone", "roles", "users"] : [] }, ...payload };
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": DISCORD_UA },
      body: JSON.stringify(body),
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

// ---- feeds -----------------------------------------------------------------
const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1].replace(/^\s*<!\[CDATA\[/, "").replace(/\]\]>\s*$/, "").trim() : "";
};

export function parseItems(xml) {
  const items = [];
  const re = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
  let match;
  while ((match = re.exec(xml)) && items.length < MAX_ITEMS) {
    const block = match[1];
    const link = tag(block, "link") || tag(block, "guid");
    const id = tag(block, "guid") || link;
    if (!id) continue;
    const when = Date.parse(tag(block, "pubDate"));
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

const postText = (feed, item) => {
  const title = item.title.startsWith("[No Title]") ? "" : item.title;
  const body = clean(item.body);
  return feed.fixedTitle ? body || title || "(image or video post)" : title || body;
};

export function buildEmbed(feed, item) {
  const body = clean(item.body);
  const title = item.title.startsWith("[No Title]") ? "" : item.title;
  const embed = {
    title: (feed.fixedTitle || title || feed.name).slice(0, 250),
    url: item.link,
    description: (feed.fixedTitle ? body || title || "(image or video post — open it to see)" : body).slice(0, 1500),
    color: feed.color,
    footer: { text: feed.name },
  };
  if (item.when) embed.timestamp = new Date(item.when).toISOString();
  return embed;
}

function catchUpEmbed(feed, held) {
  const lines = held.slice(-CATCH_UP_LINES).map((item) => {
    const when = item.when
      ? new Intl.DateTimeFormat("en-US", { timeZone: ET, weekday: "short", hour: "numeric", minute: "2-digit" }).format(new Date(item.when))
      : "";
    const text = md((item.text || "").slice(0, 120));
    return `**${when}** — ${item.link ? `[${text || "post"}](${item.link})` : text}`;
  });
  const extra = held.length - lines.length;
  if (extra > 0) lines.unshift(`*…and ${extra} older ${extra === 1 ? "one" : "ones"} not shown*`);
  return {
    title: `While you were away · ${held.length} from ${feed.name}`,
    description: lines.join("\n").slice(0, 3500),
    color: feed.color,
    footer: { text: "Muted hours catch-up" },
  };
}

async function checkFeed(feed, state, env, live) {
  const webhook = (env[feed.webhook] || "").trim() || (env.DISCORD_WEBHOOK || "").trim();
  if (!webhook) return { feed: feed.key, skipped: "no webhook" };

  const items = parseItems(await getText(feed.url));
  if (!items.length) return { feed: feed.key, skipped: "empty feed" };

  const previous = state[feed.key];
  const seen = new Set(previous ? previous.seen : []);
  const fresh = items.filter((i) => !seen.has(i.id)).sort((a, b) => a.when - b.when);
  const held = previous && previous.held ? previous.held.slice() : [];
  let posted = 0;
  let caughtUp = 0;

  if (!previous) {
    await postToDiscord(webhook, { username: feed.botName, content: `Watching **${feed.name}** — new posts land here.` });
  } else if (live) {
    if (held.length) {
      await postToDiscord(webhook, { username: feed.botName, embeds: [catchUpEmbed(feed, held)] });
      caughtUp = held.length;
      held.length = 0;
      await new Promise((r) => setTimeout(r, 400));
    }
    for (const item of fresh.slice(-MAX_PER_RUN)) {
      await postToDiscord(webhook, { username: feed.botName, embeds: [buildEmbed(feed, item)] });
      posted++;
      await new Promise((r) => setTimeout(r, 300));
    }
  } else {
    for (const item of fresh) held.push({ text: postText(feed, item).slice(0, 140), link: item.link, when: item.when });
    if (held.length > MAX_HELD) held.splice(0, held.length - MAX_HELD);
  }

  const ids = items.map((i) => i.id).concat(previous ? previous.seen : []);
  const kept = [...new Set(ids)].slice(0, REMEMBER);
  const changed = !previous || kept.join("\n") !== previous.seen.join("\n") || JSON.stringify(held) !== JSON.stringify(previous.held || []);
  if (changed) state[feed.key] = { seen: kept, held, updated: new Date().toISOString() };
  return { feed: feed.key, posted, held: held.length, caughtUp, fresh: fresh.length };
}

// ---- calendar --------------------------------------------------------------
export function parseEvents(raw) {
  return raw
    .map((item) => {
      const iso = String(item.date || "");
      const [date, rest] = iso.split("T");
      if (!date || !rest) return null;
      const [h, m] = rest.slice(0, 5).split(":").map(Number);
      return {
        title: String(item.title || "").trim(),
        country: String(item.country || "").trim().toUpperCase(),
        impact: String(item.impact || "").trim(),
        forecast: String(item.forecast || "").trim(),
        previous: String(item.previous || "").trim(),
        date,
        minutes: h * 60 + m,
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.date === b.date ? a.minutes - b.minutes : a.date < b.date ? -1 : 1));
}

const isSpeaker = (e) => CURRENCIES.includes(e.country) && SPEAKERS.some((w) => e.title.toLowerCase().includes(w));
const isWanted = (e) => (CURRENCIES.includes(e.country) && IMPACTS.includes(e.impact)) || isSpeaker(e);
const isHoliday = (e) => CURRENCIES.includes(e.country) && e.impact === "Holiday";
const isGlobal = (e) => !CURRENCIES.includes(e.country) && GLOBAL_IMPACTS.includes(e.impact);
const onDay = (events, date) => events.filter((e) => e.date === date);
const foldersLabel = () => IMPACTS.map((i) => ({ High: "red", Medium: "orange", Low: "yellow" })[i] || i.toLowerCase()).join(" or ");

const dotFor = (e) => (IMPACTS.includes(e.impact) ? DOT[e.impact] || "•" : isSpeaker(e) ? "🎙️" : DOT[e.impact] || "•");

function eventLine(e, { country = false, day = null } = {}) {
  let when = clock(e.minutes);
  if (day && e.date !== day) when = `${prettyDate(e.date).split(" ")[0]} ${when}`;
  let line = `${dotFor(e)} **${when}** — ${md(e.title)}`;
  if (country) line += ` (${e.country})`;
  const numbers = [];
  if (e.forecast) numbers.push(`fcst ${md(e.forecast)}`);
  if (e.previous) numbers.push(`prev ${md(e.previous)}`);
  if (numbers.length) line += "  ·  " + numbers.join(" · ");
  return line;
}

const holidayLines = (events) => events.filter(isHoliday).map((e) => `🏦 ${md(e.title)}`);

function section(lines, header, items) {
  if (lines.length) lines.push("");
  lines.push(`**${header}**`);
  lines.push(...items);
}

function calendarEmbed(title, lines, events) {
  const impacts = new Set(events.map((e) => e.impact));
  return {
    title,
    description: lines.join("\n").trim().slice(0, 4000),
    color: impacts.has("High") ? RED : impacts.has("Medium") ? ORANGE : GRAY,
    footer: { text: "Forex Factory · times in ET" },
  };
}

export function buildMorning(events, date) {
  const todays = onDay(events, date);
  const wanted = todays.filter(isWanted);
  const lines = holidayLines(todays);
  if (!wanted.length) {
    lines.push(`No ${foldersLabel()} ${CURRENCIES.join("/")} news today.`);
  } else {
    const groups = [
      ["Before the open", wanted.filter((e) => e.minutes < SESSION.from)],
      [`Your session · ${SESSION.label}`, wanted.filter((e) => e.minutes >= SESSION.from && e.minutes <= SESSION.to)],
      ["Later today", wanted.filter((e) => e.minutes > SESSION.to)],
    ];
    for (const [header, group] of groups) if (group.length) section(lines, header, group.map((e) => eventLine(e)));
  }
  const yesterday = shiftDate(date, -1);
  const overnight = events.filter(
    (e) => isGlobal(e) && ((e.date === yesterday && e.minutes >= OVERNIGHT_FROM) || (e.date === date && e.minutes < SESSION.from)),
  );
  if (overnight.length) section(lines, "Overnight, rest of the world", overnight.map((e) => eventLine(e, { country: true, day: date })));
  return { embeds: [calendarEmbed(`📅 ${CURRENCIES.join("/")} news · ${prettyDate(date)}`, lines, wanted)] };
}

export function buildOpen(events, date, minutes) {
  const todays = onDay(events, date);
  const wanted = todays.filter(isWanted);
  const ahead = wanted.filter((e) => e.minutes >= minutes);
  const done = wanted.filter((e) => e.minutes < minutes);
  const lines = holidayLines(todays);
  if (!wanted.length) {
    lines.push(`No ${foldersLabel()} ${CURRENCIES.join("/")} news today.`);
  } else {
    section(lines, "Still ahead", ahead.length ? ahead.map((e) => eventLine(e)) : ["Nothing else today."]);
    if (done.length) section(lines, "Already out", done.map((e) => `~~${clock(e.minutes)} — ${md(e.title)}~~`));
  }
  const payload = { embeds: [calendarEmbed(`🔔 NY open · ${prettyDate(date)}`, lines, ahead)] };
  if (OPEN_PING && ahead.length) payload.content = OPEN_PING;
  return payload;
}

export function buildWeek(events, sunday) {
  const monday = shiftDate(sunday, 1);
  const days = [0, 1, 2, 3, 4].map((i) => shiftDate(monday, i));
  if (!events.some((e) => days.includes(e.date))) return null;
  const lines = [];
  const shown = [];
  for (const date of days) {
    const todays = onDay(events, date);
    const wanted = todays.filter(isWanted);
    shown.push(...wanted);
    const items = holidayLines(todays).concat(wanted.map((e) => eventLine(e)));
    const [dow, mon, day] = prettyDate(date).split(" ");
    section(lines, `${dow} ${Number(date.slice(5, 7))}/${day}`, items.length ? items : [`*No ${foldersLabel()} news*`]);
    void mon;
  }
  const [, mon, day] = prettyDate(monday).split(" ");
  return { embeds: [calendarEmbed(`🗓️ ${CURRENCIES.join("/")} news · week of ${mon} ${day}`, lines, shown)] };
}

async function runCalendar(key, t, env) {
  const webhook = (env.CALENDAR_WEBHOOK || "").trim();
  if (!webhook) return { calendar: key, skipped: "no CALENDAR_WEBHOOK" };
  const events = parseEvents(JSON.parse(await getText(CALENDAR_URL)));
  const payload =
    key === "morning" ? buildMorning(events, t.date)
    : key === "open" ? buildOpen(events, t.date, t.minutes)
    : buildWeek(events, t.date);
  if (!payload) return { calendar: key, skipped: "week not published yet" }; // retried next minute
  await postToDiscord(webhook, { username: "FF News", ...payload });
  return { calendar: key, posted: true };
}

// ---- the minute ------------------------------------------------------------
export async function check(env, now = new Date()) {
  const state = (await env.STATE.get(STATE_KEY, "json")) || {};
  const before = JSON.stringify(state);
  const t = etNow(now);
  const live = inLiveWindow(t);
  const report = [];

  state.calendar = state.calendar || {};
  const due = dueCalendarPost(t, state.calendar);
  if (due) {
    try {
      const result = await runCalendar(due, t, env);
      report.push(result);
      if (result.posted) state.calendar[due] = t.date;
    } catch (err) {
      report.push({ calendar: due, error: String(err).slice(0, 200) });
    }
  }

  for (const feed of FEEDS) {
    try {
      report.push(await checkFeed(feed, state, env, live));
    } catch (err) {
      report.push({ feed: feed.key, error: String(err).slice(0, 200) });
    }
  }

  const failures = report.filter((r) => r.error);
  if (failures.length) state.lastError = { at: new Date().toISOString(), report: failures };
  if (JSON.stringify(state) !== before) await env.STATE.put(STATE_KEY, JSON.stringify(state));
  return report;
}

/** /debug — is the calendar feed reachable, and are the webhooks real? Posts nothing. */
async function debugReport(env, state) {
  const out = { lastError: state.lastError || null };
  try {
    const res = await fetch(CALENDAR_URL, { headers: { "User-Agent": FEED_UA } });
    const body = await res.text();
    out.calendarFeed = { status: res.status, bytes: body.length, looksLikeJson: body.trimStart().startsWith("["), sample: body.slice(0, 120) };
  } catch (err) {
    out.calendarFeed = { error: String(err).slice(0, 200) };
  }
  for (const name of ["CALENDAR_WEBHOOK", "DISCORD_WEBHOOK"]) {
    const value = (env[name] || "").trim();
    if (!value) { out[name] = "not set"; continue; }
    try {
      const res = await fetch(value, { headers: { "User-Agent": DISCORD_UA } }); // GET only reads the webhook
      const info = await res.json().catch(() => ({}));
      out[name] = { status: res.status, webhookName: info.name || null, channel: info.channel_id || null };
    } catch (err) {
      out[name] = { error: String(err).slice(0, 200) };
    }
  }
  return out;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(check(env).then((r) => console.log(JSON.stringify(r))));
  },
  async fetch(request, env) {
    const state = (await env.STATE.get(STATE_KEY, "json")) || {};
    const t = etNow();
    if (new URL(request.url).pathname === "/debug") {
      return new Response(JSON.stringify(await debugReport(env, state), null, 1), { headers: { "Content-Type": "application/json" } });
    }
    return new Response(
      JSON.stringify(
        {
          watcher: "ff-news",
          easternTime: `${t.date} ${clock(t.minutes)}`,
          live: inLiveWindow(t) ? "posting live" : "muted, holding new items",
          calendarPosted: state.calendar || {},
          feeds: Object.fromEntries(
            FEEDS.map((f) => [
              f.key,
              state[f.key] ? { lastChange: state[f.key].updated, held: (state[f.key].held || []).length, remembered: state[f.key].seen.length } : "not started",
            ]),
          ),
        },
        null,
        1,
      ),
      { headers: { "Content-Type": "application/json" } },
    );
  },
};
