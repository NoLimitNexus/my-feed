// Builds the feed: reads sources.json, fetches every source, writes site/data/items.json
// (newest first) and site/feeds.opml (the same list for any RSS reader app).
// GitHub Actions runs this every hour (.github/workflows/build.yml); by hand: npm run build
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import Parser from 'rss-parser';

const PER_SOURCE = 30;   // newest items kept from each source
const MAX_ITEMS = 400;   // newest items kept overall
const SITE_URL = process.env.SITE_URL || '';   // the live site: a source that fails this hour keeps its last items

const root = new URL('./', import.meta.url);
const sources = JSON.parse(await readFile(new URL('sources.json', root), 'utf8'));
const builtAt = new Date();
const parser = new Parser({
  timeout: 20000,
  headers: { 'User-Agent': 'my-feed/1.0 (+https://github.com/NoLimitNexus/my-feed)' },
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
    const src = decode((tag.match(/\ssrc=["']([^"']+)["']/i) || [])[1] || '');
    if (!/^https:\/\//i.test(src)) continue;
    if (/\.svg(\?|$)|shields\.io|badge|favicon|emoji|\/assets\/icons\//i.test(src)) continue;
    if (/class=["'][^"']*(site-icon|emoji)/i.test(tag)) continue;
    const width = Number((tag.match(/\swidth=["']?(\d+)/i) || [])[1] || 0);
    if (width && width < 120) continue;
    return src;
  }
  return '';
}

async function lastBuild() {
  if (!SITE_URL) return null;
  try {
    const res = await fetch(`${SITE_URL}/data/items.json`, { signal: AbortSignal.timeout(15000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function fetchSource(src) {
  const feed = await parser.parseURL(src.url);
  const feedDate = feed.lastBuildDate || feed.pubDate;   // trending lists date the list, not each repo
  return (feed.items || [])
    .map((it) => {
      const html = it['content:encoded'] || it.content || it.summary || it.description || '';
      const d = new Date(it.isoDate || it.pubDate || feedDate || builtAt);
      return {
        title: toText(it.title) || '(no title)',
        link: /^https?:\/\//i.test(it.link || '') ? it.link : feed.link || src.url,
        date: (isNaN(d) ? builtAt : d).toISOString(),
        source: src.name,
        topic: src.topic,
        summary: summaryOf(html),
        image: imageOf(html),
      };
    })
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, PER_SOURCE);
}

const previous = await lastBuild();
const report = [];
const seen = new Set();
let items = [];

const fetched = await Promise.all(sources.map((src) => fetchSource(src).then(
  (list) => ({ src, list }),
  (err) => ({ src, error: String(err?.message || err).slice(0, 200) }),
)));

for (const { src, list, error } of fetched) {
  let kept = list;
  if (error) {
    kept = (previous?.items || []).filter((it) => it.source === src.name);
    console.warn(`! ${src.name}: ${error} (kept ${kept.length} from the last build)`);
  } else {
    console.log(`  ${src.name}: ${list.length}`);
  }
  report.push({ name: src.name, topic: src.topic, url: src.url, ok: !error, count: kept.length, ...(error && { error }) });
  for (const it of kept) {
    if (seen.has(it.link)) continue;   // the same repo can trend in two lists
    seen.add(it.link);
    items.push(it);
  }
}

if (report.every((r) => !r.ok)) {
  console.error('Every source failed; the live site is left as it was.');
  process.exit(1);
}

items = items.sort((a, b) => b.date.localeCompare(a.date)).slice(0, MAX_ITEMS);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const topics = [...new Set(sources.map((s) => s.topic))];
const opml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head><title>My Feed</title><dateCreated>${builtAt.toUTCString()}</dateCreated></head>
  <body>
${topics.map((t) => `    <outline text="${esc(t)}" title="${esc(t)}">
${sources.filter((s) => s.topic === t).map((s) => `      <outline type="rss" text="${esc(s.name)}" title="${esc(s.name)}" xmlUrl="${esc(s.url)}"/>`).join('\n')}
    </outline>`).join('\n')}
  </body>
</opml>
`;

await mkdir(new URL('site/data/', root), { recursive: true });
await writeFile(new URL('site/data/items.json', root), JSON.stringify({ builtAt: builtAt.toISOString(), sources: report, items }));
await writeFile(new URL('site/feeds.opml', root), opml);
console.log(`Wrote ${items.length} items from ${report.filter((r) => r.ok).length}/${report.length} sources.`);
