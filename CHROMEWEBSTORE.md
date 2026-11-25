# Chrome Web Store Listing — Nuvio Quick Add

> Last Updated: 2026-11-25

## Store Listing

**Extension Name**
Nuvio Quick Add

**Short Description**
Add movies and series from posters, Letterboxd, IMDb, TMDB, or any webpage directly to your Trakt Watchlist or Nuvio Library.

**Detailed Description**
Nuvio Quick Add lets you build your Trakt Watchlist and Nuvio Library directly while browsing the web in Chrome or Opera GX.

Key features:
Quick-add overlay buttons directly on movie and series posters across catalogs, search grids, and download sites.
One-click Watchlist/Library button inside Letterboxd film pages and a non-intrusive floating pill on single-movie detail pages.
Zero-setup Trakt.tv browser session sync (no developer API keys required), plus optional Nuvio Cloud Library, Official Trakt API, or Both modes.
Right-click any highlighted movie title on any website to add it straight to your Watchlist.
Built-in popup search to manually find and add any movie or series.

How to use:
1. Sign in to trakt.tv in your browser (or sign in to Nuvio Cloud in Settings).
2. Click the + button on any movie poster, on Letterboxd, or via the extension popup.
3. Highlight any movie title on any website, right-click, and choose "Add to Trakt Watchlist".

Privacy note:
Your session preferences stay stored locally in your browser. The extension only contacts Trakt, Nuvio, and public metadata catalogs (Cinemeta, or TMDB if you enter your own key) when resolving or saving a title.

**Category**
Productivity

**Single Purpose**
Detect movies and series on web pages and poster grids and add them to the user's Trakt Watchlist or Nuvio Library.

**Primary Language**
English

## Graphics & Assets

| Asset | Dimensions | Status | Filename |
|-------|-----------|--------|----------|
| Store Icon | 128×128 PNG | ✅ Ready | `icons/icon-128.png` |
| Screenshot 1 | 1280×800 or 640×400 | ⬜ Not created | |
| Small Promo Tile | 440×280 | ⬜ Not created | |

## Permissions Justification

| Permission | Type | Justification |
|------------|------|---------------|
| `storage` | permissions | Stores the user's session tokens, active profile selection, watchlist/library status cache, and extension preferences locally. |
| `activeTab` | permissions | Reads the active tab's title/URL when the user clicks the extension popup or invokes the context menu. |
| `tabs` | permissions | Opens Trakt sign-in pages, queries the active tab URL, and refreshes in-page poster/button state after adding or removing an item. |
| `contextMenus` | permissions | Adds "Add to Trakt Watchlist / Nuvio" options to the browser right-click menu for selected text and movie pages. |
| `scripting` | permissions | Supports safe interaction with active tabs when triggered by user actions. |
| `alarms` | permissions | Clears temporary toolbar badge confirmations and polls optional Trakt device authorization status without keeping the background worker running. |
| `declarativeNetRequest` | permissions | Sets same-site `Cookie`, `Origin`, and `Referer` headers solely on extension-initiated requests to `https://trakt.tv/` and `https://app.trakt.tv/` so CSRF and session validation succeed using the user's active browser session. |
| `cookies` | permissions | Reads active `trakt.tv` and `app.trakt.tv` session cookies so the background worker can detect whether the user is signed in without requiring developer API keys. |
| `webRequest` | permissions | Observes outgoing `api.trakt.tv` request headers from the user's open Trakt web session to reuse their active session token for watchlist sync. |
| `https://trakt.tv/*`, `https://app.trakt.tv/*`, `https://*.trakt.tv/*` | host_permissions | Detects the user's active Trakt.tv / Trakt V3 browser session and syncs watchlist items without requiring developer API keys. |
| `https://api.trakt.tv/*` | host_permissions | Optional Trakt Official API OAuth & watchlist sync when the user supplies a personal Trakt Client ID. |
| `https://api.nuvio.tv/*` | host_permissions | Authenticates the user's Nuvio account, fetches profiles, and syncs library items when Nuvio Cloud mode is selected. |
| `https://v3-cinemeta.strem.io/*` | host_permissions | Resolves movie/series titles and IMDb metadata with zero configuration. |
| `https://api.themoviedb.org/*` | host_permissions | Optional metadata lookup when the user provides a personal TMDB API key in Settings. |
| `http://*/*`, `https://*/*` | host_permissions | Allows the content script to detect movie posters and single-movie identifiers on arbitrary film and download websites. |

## Privacy & Data Use

**Does the extension collect user data?** No (requests go only to Trakt, the user's configured Nuvio server, and metadata catalogs; no developer telemetry or third-party analytics).

- [x] Data is NOT sold to third parties
- [x] Data is NOT used for purposes unrelated to the extension's core functionality
- [x] Data is NOT used for creditworthiness or lending purposes

## Version History

| Version | Date | Changes | Status |
|---------|------|---------|--------|
| 1.2.3 | 2026-11-25 | Fixed Opera GX Trakt V3 session detection, removed /watchlist 404 probe, and added SvelteKit SSR + session-scoped DNR support | Draft |
| 1.2.2 | 2026-11-25 | Added MAIN-world Trakt V3 bridge for Opera GX, multi-store cookie lookup, and Trakt multilingual search fallback | Draft |
| 1.2.1 | 2026-11-25 | Fixed Trakt V3 (app.trakt.tv) and SameSite=Lax cookie session detection in MV3 Service Worker | Draft |
| 1.2.0 | 2026-11-25 | Added zero-API-key Trakt.tv Web Session sync and in-poster quick-add overlay buttons | Draft |
| 1.1.0 | 2026-11-25 | Added direct Trakt Watchlist sync via Device OAuth | Draft |
| 1.0.0 | 2026-11-25 | Initial Manifest V3 release for Chrome and Opera GX | Draft |
