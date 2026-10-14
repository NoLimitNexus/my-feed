// Builds the feed: reads sources.json (categories and every source, on or off), fetches each source,
// and writes site/data/items.json plus site/feeds.opml (the same list for any RSS reader app).
// Every source is fetched, even ones that start off, so turning one on in the app is instant.
// GitHub Actions runs this every hour (.github/workflows/build.yml); by hand: npm run build
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import Parser from 'rss-parser';

const PER_SOURCE = 25;   // newest items kept from each source
const MAX_AGE_DAYS = 30; // older items are left out (a pinned post from years ago is not news)
const SITE_URL = process.env.SITE_URL || '';   // the live site: a source that fails this hour keeps its last items
const UA = 'my-feed/2.0 (+https://github.com/NoLimitNexus/my-feed)';

const root = new URL('./', import.meta.url);
const catalog = JSON.parse(await readFile(new URL('sources.json', root), 'utf8'));
const builtAt = new Date();
const oldest = builtAt.getTime() - MAX_AGE_DAYS * 86400000;
const parser = new Parser({
  timeout: 20000,
  headers: { 'User-Agent': UA },
  customFields: { item: [['media:group', 'mediaGroup'], ['media:content', 'mediaContent', { keepArray: true }]] },
});

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', middot: '·', hellip: '…',
  mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };

function decode(s) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== '#') return ENTITIES[e.toLowerCase()] ?? m;
    const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
  });
}

function toText(html) {
  return decode(String(html || '').replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ').trim();
}

function clip(s, n) {
  return s.length > n ? s.slice(0, n - 1).replace(/\s+\S*$/, '') + '…' : s;
}

// The opening paragraphs read better than the whole post squashed together;
// a short greeting ("Hi everyone!") takes the next paragraph with it.
function summaryOf(html) {
  const paras = [...String(html).matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)].map((m) => toText(m[1])).filter((t) => t.length >= 3);
  let text = '';
  for (const p of paras) {
    text = text ? `${text} ${p}` : p;
    if (text.length >= 60) break;
  }
  return clip(text || toText(html), 260);
}

// First picture worth showing: skips site icons, emoji, badges and other small images.
function imageOf(html) {
  for (const [tag] of String(html).matchAll(/<img\b[^>]*>/gi)) {
    const src = decode((tag.match(/\ssrc=["']([^"']+)["']/i) || [])[1] || '').replace(/^\/\//, 'https://');
    if (!/^https:\/\//i.test(src)) continue;
    if (/\.svg(\?|$)|shields\.io|badge|favicon|emoji|\/assets\/icons\/|feeds\.feedburner|pixel\.wp\.com/i.test(src)) continue;
    if (/class=["'][^"']*(site-icon|emoji)/i.test(tag)) continue;
    const width = Number((tag.match(/\swidth=["']?(\d+)/i) || [])[1] || 0);
    if (width && width < 120) continue;
    return src;
  }
  return '';
}

// A video the page can play in place: a YouTube or Vimeo link or embed anywhere in the text.
function videoOf(text) {
  const s = decode(String(text || ''));
  const yt = s.match(/(?:youtube(?:-nocookie)?\.com\/(?:embed\/|watch\?(?:[^"'\s<>]*?&)?v=|shorts\/|live\/)|youtu\.be\/)([\w-]{11})/i);
  if (yt) return { kind: 'youtube', id: yt[1], ...( /shorts\//i.test(yt[0]) && { tall: true }) };
  const vm = s.match(/(?:player\.vimeo\.com\/video\/|vimeo\.com\/)(\d{6,})/i);
  if (vm) return { kind: 'vimeo', id: vm[1] };
  return null;
}

const youtubeThumb = (id) => `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
const idOf = (link) => createHash('sha1').update(link).digest('hex').slice(0, 12);

async function lastBuild() {
  if (!SITE_URL) return null;
  try {
    const res = await fetch(`${SITE_URL}/data/items.json`, { signal: AbortSignal.timeout(15000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

// Last resort for an RSS file that is not valid XML (NASA's carries raw HTML): read each
// <item> with plain patterns.
function looseRss(xml) {
  const field = (block, tag) => {
    const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i'));
    return m ? m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1').trim() : '';
  };
  return {
    title: field(xml, 'title'),
    link: field(xml, 'link'),
    items: [...xml.matchAll(/<item\b[\s\S]*?<\/item>/gi)].map(([block]) => {
      const pubDate = field(block, 'pubDate');
      const d = new Date(pubDate);
      return { title: decode(field(block, 'title')), link: decode(field(block, 'link')), pubDate,
        isoDate: isNaN(d) ? undefined : d.toISOString(), content: field(block, 'description') };
    }),
  };
}

// Some feeds carry a bare "&" or raw HTML that strict XML readers refuse: repair and read again,
// and if that still fails, read the items loosely.
async function parseFeed(url) {
  try {
    return await parser.parseURL(url);
  } catch (err) {
    if (/^Status code/.test(err.message)) throw err;
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`Status code ${res.status}`);
    const xml = (await res.text()).replace(/&(?![a-z]+;|#\d+;|#x[0-9a-f]+;)/gi, '&amp;');
    try {
      return await parser.parseString(xml);
    } catch {
      const feed = looseRss(xml);
      if (!feed.items.length) throw err;
      return feed;
    }
  }
}

async function fetchFeed(src) {
  const feed = await parseFeed(src.url);
  const feedDate = feed.lastBuildDate || feed.pubDate;   // trending lists date the list, not each repo
  return (feed.items || []).map((it) => {
    const group = it.mediaGroup || {};
    const ytDescription = group['media:description']?.[0];
    const html = it['content:encoded'] || it.content || it.summary || it.description || ytDescription || '';
    const link = /^https?:\/\//i.test(it.link || '') ? it.link : feed.link || src.url;
    const attached = [...(it.mediaContent || []).map((m) => m?.$?.url), it.enclosure?.url].filter(Boolean).join(' ');
    const video = videoOf(link) || videoOf(attached) || videoOf(html);
    let image = imageOf(html);
    if (video?.kind === 'youtube') image = youtubeThumb(video.id);
    const redditPicture = src.url.includes('reddit.com') && html.match(/href="(https:\/\/i\.redd\.it\/[^"]+\.(?:jpe?g|png|gif))"/i);
    if (redditPicture) image = redditPicture[1];
    const d = new Date(it.isoDate || it.pubDate || feedDate || builtAt);
    return {
      title: toText(it.title),
      text: src.summary === false ? '' : clip(ytDescription ? toText(ytDescription) : summaryOf(html), 260),
      link,
      date: (isNaN(d) ? builtAt : d).toISOString(),
      image,
      ...(video && { video }),
    };
  });
}

// Bluesky: public posts through its open API (no account). Replies, reposts and anything carrying
// an adult or graphic label are left out.
const HIDDEN_LABELS = new Set(['porn', 'sexual', 'nudity', 'sexual-figurative', 'graphic-media', 'gore', 'nsfl',
  'corpse', 'self-harm', 'intolerant', 'rude', 'spam', 'impersonation']);
const flagged = (p) => [...(p.labels || []), ...(p.author?.labels || [])]
  .some((l) => HIDDEN_LABELS.has(l.val) || String(l.val).startsWith('!'));

async function fetchBluesky(src) {
  const api = 'https://public.api.bsky.app/xrpc/';
  const url = src.bluesky.startsWith('at://')
    ? `${api}app.bsky.feed.getFeed?feed=${encodeURIComponent(src.bluesky)}&limit=40`
    : `${api}app.bsky.feed.getAuthorFeed?actor=${encodeURIComponent(src.bluesky)}&limit=40&filter=posts_no_replies`;
  const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Status code ${res.status}`);
  const data = await res.json();
  return (data.feed || [])
    .filter((f) => !f.reason && f.post?.record && !f.post.record.reply && !flagged(f.post))
    .map(({ post: p }) => {
      const handle = p.author.handle;
      const e = p.embed || {};
      const media = e.$type === 'app.bsky.embed.recordWithMedia#view' ? e.media || {} : e;
      let image = '';
      let video = null;
      if (media.$type === 'app.bsky.embed.images#view' && media.images?.length) {
        image = media.images[0].fullsize || media.images[0].thumb || '';
      } else if (media.$type === 'app.bsky.embed.video#view' && media.playlist) {
        const ar = media.aspectRatio;
        video = { kind: 'hls', src: media.playlist, ...(ar?.width && ar?.height && { ratio: +(ar.width / ar.height).toFixed(3) }) };
        image = media.thumbnail || '';
      } else if (media.$type === 'app.bsky.embed.external#view' && media.external) {
        video = videoOf(media.external.uri);
        image = video?.kind === 'youtube' ? youtubeThumb(video.id) : media.external.thumb || '';
      }
      return {
        title: '',
        text: clip(String(p.record.text || '').trim(), 600),
        author: p.author.displayName ? `${p.author.displayName} @${handle}` : `@${handle}`,
        link: `https://bsky.app/profile/${handle}/post/${p.uri.split('/').pop()}`,
        date: new Date(p.indexedAt || p.record.createdAt || builtAt).toISOString(),
        image,
        ...(video && { video }),
      };
    });
}

const previous = await lastBuild();
const report = [];
const seen = new Set();
let items = [];

// A source that hangs must not hold up the rest: each one gets 25 seconds.
const inTime = (promise) => Promise.race([promise, new Promise((_, fail) => setTimeout(() => fail(new Error('No answer in 25 seconds')), 25000).unref())]);
const fetched = await Promise.all(catalog.sources.map((src) => inTime(src.bluesky ? fetchBluesky(src) : fetchFeed(src)).then(
  (list) => ({ src, list }),
  (err) => ({ src, error: String(err?.message || err).slice(0, 200) }),
)));

for (const { src, list, error } of fetched) {
  let kept;
  if (error) {
    kept = (previous?.items || []).filter((it) => it.source === src.id);
    console.warn(`! ${src.id}: ${error} (kept ${kept.length} from the last build)`);
  } else {
    kept = list
      .filter((it) => src.keepOld || new Date(it.date).getTime() >= oldest)
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, PER_SOURCE)
      .map((it) => ({ id: idOf(it.link), source: src.id, ...it }));
    console.log(`  ${src.id}: ${kept.length} (videos ${kept.filter((it) => it.video).length}, pictures ${kept.filter((it) => it.image && !it.video).length})`);
  }
  const { url, bluesky, keepOld, ...info } = src;
  report.push({ ...info, link: bluesky ? 'https://bsky.app' : url, ok: !error, count: kept.length, ...(error && { error }) });
  for (const it of kept) {
    if (seen.has(it.link)) continue;   // the same thing can come from two sources
    seen.add(it.link);
    items.push(it);
  }
}

if (report.every((r) => !r.ok)) {
  console.error('Every source failed; the live site is left as it was.');
  process.exit(1);
}

items = items.sort((a, b) => b.date.localeCompare(a.date));

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const feedUrl = (s) => (s.bluesky ? (s.bluesky.startsWith('at://') ? '' : `https://bsky.app/profile/${s.bluesky}/rss`) : s.url);
const opml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>My Feed</title><dateCreated>${builtAt.toUTCString()}</dateCreated></head>
  <body>
${catalog.categories.map((c) => `    <outline text="${esc(c.name)}" title="${esc(c.name)}">
${catalog.sources.filter((s) => s.category === c.id && feedUrl(s)).map((s) => `      <outline type="rss" text="${esc(s.name)}" title="${esc(s.name)}" xmlUrl="${esc(feedUrl(s))}"/>`).join('\n')}
    </outline>`).join('\n')}
  </body>
</opml>
`;

await mkdir(new URL('site/data/', root), { recursive: true });
await writeFile(new URL('site/data/items.json', root),
  JSON.stringify({ version: 2, builtAt: builtAt.toISOString(), categories: catalog.categories, sources: report, items }));
await writeFile(new URL('site/feeds.opml', root), opml);
const ok = report.filter((r) => r.ok).length;
console.log(`Wrote ${items.length} items (${items.filter((it) => it.video).length} videos) from ${ok}/${report.length} sources.`);
// The files are written; leftover open connections from slow servers must not keep the job running.
process.exit(0);
