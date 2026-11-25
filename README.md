# Nuvio Quick Add (Chrome & Opera GX)

Add any movie or series from **Letterboxd**, **IMDb**, **TMDB**, **download/torrent catalogs**, or **movie poster grids** directly to your **Trakt Watchlist** (synced automatically into Nuvio) or your **Nuvio Cloud Library** — **no API keys or GitHub verification required**.

## Quick path

1. Open `chrome://extensions` (Chrome) or `opera://extensions` (Opera GX).
2. Enable **Developer mode** and click **Load unpacked** (or click **Reload** if updating).
3. Sign in normally to `https://trakt.tv` in your browser.
4. Click the **Nuvio Quick Add** extension icon — it automatically detects your `trakt.tv` session and enables **+** buttons on movie posters, Letterboxd pages, floating pills, and right-click menus.

## Features

| Feature | Where it works |
|---------|----------------|
| Zero-key Trakt.tv Web Session (default) | Uses your active `trakt.tv` browser session — no Developer App, API key, or GitHub account needed |
| In-poster `+` quick-add buttons | Movie & series poster grids on Letterboxd, IMDb, TMDB, FilmAffinity, and download/streaming catalogs |
| Native sidebar button | Letterboxd film pages (`letterboxd.com/film/*`) |
| Floating Shadow DOM pill | Single-movie & download detail pages |
| Right-click context menu | Highlight any movie title on any page (`Add "..." to Trakt Watchlist`) or right-click a page |
| Nuvio Cloud / Official Trakt API / Both | Switchable anytime in **Settings → Sync Destination** |

## Verification

Run the local unit test suite with Node 24+:

```bash
node --test tests/*.test.js
```
