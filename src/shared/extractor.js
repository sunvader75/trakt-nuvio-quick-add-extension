/**
 * Extracts movie or series identifiers and metadata from any DOM Document + URL.
 * Works cleanly with both browser DOMs and lightweight test mocks.
 */

import { cleanMediaTitle } from './title-cleaner.js';

const IMDB_URL_RE = /imdb\.com\/title\/(tt\d{6,10})/i;
const TMDB_URL_RE = /themoviedb\.org\/(movie|tv)\/(\d+)/i;

const MOVIE_INDICATOR_RE =
  /\b(?:imdb|tmdb|sinopsis|synopsis|reparto|cast|director|g[eé]nero|genre|duraci[oó]n|runtime|1080p|2160p|720p|bluray|web-?dl|torrent|magnet|descargar|trailer)\b/i;

function getAttr(el, attr) {
  if (!el || typeof el.getAttribute !== 'function') return '';
  return (el.getAttribute(attr) || '').trim();
}

function getText(el) {
  if (!el || typeof el.textContent !== 'string') return '';
  return el.textContent.trim();
}

function queryFirst(doc, selector) {
  if (!doc || typeof doc.querySelector !== 'function') return null;
  return doc.querySelector(selector);
}

function queryAll(doc, selector) {
  if (!doc || typeof doc.querySelectorAll !== 'function') return [];
  return Array.from(doc.querySelectorAll(selector) || []);
}

function parseJsonLdBlocks(doc) {
  const scripts = queryAll(doc, 'script[type="application/ld+json"]');
  const results = [];

  for (const script of scripts) {
    const raw = getText(script);
    if (!raw) continue;
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        results.push(...parsed);
      } else if (parsed && Array.isArray(parsed['@graph'])) {
        results.push(...parsed['@graph']);
      } else if (parsed && typeof parsed === 'object') {
        results.push(parsed);
      }
    } catch {
      // Ignore malformed JSON-LD blocks on third-party websites
    }
  }

  return results;
}

function extractFromJsonLd(doc) {
  const blocks = parseJsonLdBlocks(doc);
  for (const node of blocks) {
    const rawType = Array.isArray(node['@type'])
      ? node['@type'].join(' ')
      : String(node['@type'] || '');

    if (!/\b(?:Movie|TVSeries)\b/i.test(rawType)) continue;

    const type = /TVSeries/i.test(rawType) ? 'series' : 'movie';
    const name = typeof node.name === 'string' ? node.name.trim() : '';
    const dateRaw = String(node.datePublished || node.dateCreated || '');
    const yearMatch = dateRaw.match(/\b(19\d{2}|20\d{2})\b/);
    let poster = '';
    if (typeof node.image === 'string') {
      poster = node.image;
    } else if (node.image && typeof node.image.url === 'string') {
      poster = node.image.url;
    }

    let imdbId = null;
    const sameAsList = []
      .concat(node.sameAs || [])
      .concat(node.url || [])
      .map(String);
    for (const candidate of sameAsList) {
      const m = candidate.match(IMDB_URL_RE);
      if (m) {
        imdbId = m[1];
        break;
      }
    }

    return {
      hasMovieJsonLd: true,
      type,
      title: name,
      year: yearMatch ? yearMatch[1] : null,
      poster,
      imdbId
    };
  }

  return {
    hasMovieJsonLd: false,
    type: null,
    title: '',
    year: null,
    poster: '',
    imdbId: null
  };
}

function collectCanonicalLinkIds(doc) {
  const imdbSet = new Set();
  const tmdbEntries = [];

  const imdbAnchors = queryAll(doc, 'a[href*="imdb.com/title/tt"]');
  for (const a of imdbAnchors) {
    const match = getAttr(a, 'href').match(IMDB_URL_RE);
    if (match) imdbSet.add(match[1]);
  }

  const tmdbAnchors = queryAll(
    doc,
    'a[href*="themoviedb.org/movie/"], a[href*="themoviedb.org/tv/"]'
  );
  for (const a of tmdbAnchors) {
    const match = getAttr(a, 'href').match(TMDB_URL_RE);
    if (match) {
      tmdbEntries.push({
        type: match[1].toLowerCase() === 'tv' ? 'series' : 'movie',
        tmdbId: match[2]
      });
    }
  }

  const uniqueImdbIds = Array.from(imdbSet);
  const uniqueTmdb = tmdbEntries.filter(
    (entry, idx, arr) =>
      arr.findIndex(
        (other) => other.tmdbId === entry.tmdbId && other.type === entry.type
      ) === idx
  );

  return {
    imdbId: uniqueImdbIds.length === 1 ? uniqueImdbIds[0] : uniqueImdbIds[0] || null,
    hasSingleImdbLink: uniqueImdbIds.length === 1,
    tmdbId: uniqueTmdb[0]?.tmdbId || null,
    tmdbType: uniqueTmdb[0]?.type || null,
    hasSingleTmdbLink: uniqueTmdb.length === 1
  };
}

function detectKnownSource(pageUrl) {
  if (!pageUrl) return 'generic';
  if (/^https?:\/\/(?:www\.)?letterboxd\.com\/film\//i.test(pageUrl)) {
    return 'letterboxd';
  }
  if (/^https?:\/\/(?:www\.|m\.)?imdb\.com\/title\/tt\d+/i.test(pageUrl)) {
    return 'imdb';
  }
  if (/^https?:\/\/(?:www\.)?themoviedb\.org\/(?:movie|tv)\/\d+/i.test(pageUrl)) {
    return 'tmdb';
  }
  if (
    /^https?:\/\/(?:www\.)?(?:trakt\.tv\/(?:movies|shows)\/|filmaffinity\.com\/|justwatch\.com\/.*\/(?:movie|tv-show|pelicula|serie)\/)/i.test(
      pageUrl
    )
  ) {
    return 'database';
  }
  return 'generic';
}

/**
 * Extracts structured movie/series candidate data from a DOM document.
 * @param {Document} doc
 * @param {string} pageUrl
 * @returns {{
 *   isMoviePage: boolean,
 *   source: string,
 *   imdbId: string | null,
 *   tmdbId: string | null,
 *   type: 'movie' | 'series',
 *   title: string,
 *   year: string | null,
 *   poster: string,
 *   url: string
 * }}
 */
export function extractMediaFromDocument(doc, pageUrl = '') {
  const source = detectKnownSource(pageUrl);
  const urlImdb = pageUrl.match(IMDB_URL_RE)?.[1] || null;
  const urlTmdbMatch = pageUrl.match(TMDB_URL_RE);
  const urlTmdbId = urlTmdbMatch ? urlTmdbMatch[2] : null;
  const urlTmdbType = urlTmdbMatch
    ? urlTmdbMatch[1].toLowerCase() === 'tv'
      ? 'series'
      : 'movie'
    : null;

  const jsonLd = extractFromJsonLd(doc);
  const linkIds = collectCanonicalLinkIds(doc);

  const ogType = getAttr(queryFirst(doc, 'meta[property="og:type"]'), 'content');
  const ogTitle = getAttr(queryFirst(doc, 'meta[property="og:title"]'), 'content');
  const ogImage = getAttr(queryFirst(doc, 'meta[property="og:image"]'), 'content');

  let rawTitle = '';
  let explicitYear = null;

  if (source === 'letterboxd') {
    rawTitle =
      getText(
        queryFirst(
          doc,
          'h1.headline-1, h1.filmtitle, section#featured-film-header h1'
        )
      ) ||
      ogTitle ||
      doc?.title ||
      '';
    const yearText = getText(
      queryFirst(doc, '.releaseyear a, span.releasedate a')
    );
    if (/^(19\d{2}|20\d{2})$/.test(yearText)) {
      explicitYear = yearText;
    }
  } else {
    const h1Text = getText(queryFirst(doc, 'h1'));
    rawTitle = jsonLd.title || ogTitle || h1Text || doc?.title || '';
    if (h1Text && h1Text.length > 3 && source === 'generic') {
      // On download/torrent sites, H1 often carries the release title & year
      const cleanedH1 = cleanMediaTitle(h1Text);
      if (cleanedH1.title) {
        rawTitle = h1Text;
      }
    }
    const yearElText = getText(queryFirst(doc, '.year, [class*="year"], time'));
    const yearElMatch = yearElText.match(/\b(19\d{2}|20\d{2})\b/);
    if (yearElMatch) {
      explicitYear = yearElMatch[1];
    } else {
      const slugYearMatch = pageUrl.match(/[-/](19\d{2}|20\d{2})(?:\/|\?|$)/);
      if (slugYearMatch) {
        explicitYear = slugYearMatch[1];
      }
    }
  }

  const cleaned = cleanMediaTitle(rawTitle);
  const fallbackCleaned =
    !cleaned.title && doc?.title ? cleanMediaTitle(doc.title) : null;

  const title = cleaned.title || fallbackCleaned?.title || '';
  const year =
    explicitYear || jsonLd.year || cleaned.year || fallbackCleaned?.year || null;

  const imdbId = urlImdb || jsonLd.imdbId || linkIds.imdbId || null;
  const tmdbId = urlTmdbId || linkIds.tmdbId || null;
  const type =
    urlTmdbType ||
    jsonLd.type ||
    linkIds.tmdbType ||
    (ogType === 'video.tv_show' ? 'series' : cleaned.type) ||
    'movie';

  const poster = ogImage || jsonLd.poster || '';

  const bodySample = (doc?.body?.textContent || '').slice(0, 8000);
  const hasMovieIndicators = MOVIE_INDICATOR_RE.test(bodySample);
  const hasOgVideo = /^video\.(?:movie|tv_show)/i.test(ogType);

  const isKnownMovieSource = source !== 'generic';
  const isMoviePage = Boolean(
    isKnownMovieSource ||
      jsonLd.hasMovieJsonLd ||
      hasOgVideo ||
      linkIds.hasSingleImdbLink ||
      linkIds.hasSingleTmdbLink ||
      (title && year && hasMovieIndicators)
  );

  return {
    isMoviePage,
    source,
    imdbId,
    tmdbId,
    type,
    title,
    year,
    poster,
    url: pageUrl
  };
}
