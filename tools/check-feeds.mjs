// Opens each feed URL given on the command line and prints: ok/fail, feed title, item count, newest date,
// and how many items carry a video or a picture. Used to check a source before it goes in sources.json.
import Parser from 'rss-parser';
const parser = new Parser({ timeout: 20000, headers: { 'User-Agent': 'my-feed/1.0 (+https://github.com/NoLimitNexus/my-feed)' },
  customFields: { item: [['media:group', 'mediaGroup'], ['media:content', 'mediaContent', { keepArray: true }]] } });
for (const url of process.argv.slice(2)) {
  try {
    const f = await parser.parseURL(url);
    const items = f.items || [];
    const html = (it) => `${it['content:encoded'] || ''} ${it.content || ''} ${JSON.stringify(it.mediaContent || '')} ${it.link || ''}`;
    const vids = items.filter((it) => /youtube\.com\/(embed|watch|shorts)|youtu\.be\/|vimeo\.com|\.mp4/i.test(html(it))).length;
    const pics = items.filter((it) => /<img|media:thumbnail|"image\//i.test(html(it)) || it.enclosure?.type?.startsWith('image')).length;
    const newest = items.map((it) => it.isoDate || '').sort().at(-1) || '-';
    console.log(`ok   | ${(f.title || '').slice(0, 40).padEnd(40)} | ${String(items.length).padStart(3)} items | newest ${newest.slice(0, 10)} | video ${vids} | pics ${pics} | ${url}`);
  } catch (e) {
    console.log(`FAIL | ${String(e.message).slice(0, 60)} | ${url}`);
  }
}
