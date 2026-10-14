# My Feed

My own feed: the things I follow, newest first, in one list. No algorithm, no ads, no account.

Live: https://nolimitnexus.github.io/my-feed/

## How it works
- `sources.json` is the list of what I follow: a name, a topic (the filter buttons) and an RSS or Atom feed URL.
- Every hour GitHub Actions runs `build.mjs`, which fetches every source and publishes the page in `site/`
  with the newest items (`site/data/items.json`) and an OPML copy of the list (`site/feeds.opml`).
- A source that can't be reached keeps its last items until it comes back.

## Adding a source
Edit `sources.json` (on GitHub: the "Add or remove a source" link at the bottom of the page) and save.
The page rebuilds within a minute or two.

Feeds that work well:
- A GitHub project's releases: `https://github.com/<owner>/<repo>/releases.atom`
- A GitHub project's commits: `https://github.com/<owner>/<repo>/commits.atom`
- Trending repos per language: `https://mshibanami.github.io/GitHubTrendingRSS/daily/<language>.xml`
- A Discourse forum category: the category page URL with `.rss` on the end

## By hand
```
npm ci
npm run build
```
`npm run icons` redraws the home-screen icons.
