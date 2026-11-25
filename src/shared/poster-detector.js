/**
 * Detects movie & series poster cards across catalog grids, search results,
 * Letterboxd, IMDb, TMDB, and generic download/streaming websites.
 */

import { cleanMediaTitle } from './title-cleaner.js';

const IMDB_ID_RE = /\/title\/(tt\d{6,10})/i;
const TMDB_PATH_RE = /themoviedb\.org\/(movie|tv)\/(\d+)/i;
const MOVIE_URL_HINT_RE =
  /\/(?:pelicula|peliculas|movie|movies|film|films|serie|series|ver|descargar|watch|download|title\/tt|shows)\//i;
const QUALITY_OR_YEAR_HINT_RE =
  /\b(?:19\d{2}|20\d{2}|1080p|720p|2160p|4k|bluray|web-?dl|latino|castellano|hdrip|torrent)\b/i;

const GENERIC_ALT_RE =
  /^(?:poster|cover|image|imagen|portada|pel[ií]cula|movie|thumbnail|thumb|photo)$/i;
const INJECTED_BTN_TEXT_RE = /(?:\s*[+✓]\s*(?:Trakt|Nuvio|Both)\b|\s*…)/g;

function cleanCardAttrTitle(val) {
  const trimmed = String(val || '').trim();
  if (!trimmed || GENERIC_ALT_RE.test(trimmed)) return '';
  return trimmed;
}

function stripInjectedButtonText(val) {
  return String(val || '').replace(INJECTED_BTN_TEXT_RE, ' ').trim();
}

function getAttr(el, name) {
  return (el.getAttribute(name) || '').trim();
}

function getBoxDimensions(el) {
  if (!el) return { width: 0, height: 0 };
  if (typeof el.getBoundingClientRect === 'function') {
    const rect = el.getBoundingClientRect();
    if (rect && (rect.width > 0 || rect.height > 0)) {
      return { width: rect.width, height: rect.height };
    }
  }
  const w = Number(getAttr(el, 'width')) || 0;
  const h = Number(getAttr(el, 'height')) || 0;
  return { width: w, height: h };
}

function isPosterAspectRatio(width, height) {
  if (width < 75 || height < 110) return false;
  const ratio = height / width;
  return ratio >= 1.18 && ratio <= 2.1;
}

function normalizeCardKey(card) {
  if (card.imdbId) return `imdb:${card.imdbId}`;
  if (card.tmdbId) return `tmdb:${card.type}:${card.tmdbId}`;
  return `title:${card.type}:${card.title.toLowerCase()}:${card.year || ''}`;
}

const CARD_CONTAINER_SELECTORS = [
  '.film-poster',
  '[data-film-slug]',
  '[data-item-slug]',
  '.ipc-poster-card',
  '.lister-item',
  '.ipc-metadata-list-summary-item',
  '.grid-item',
  '.card',
  '.poster',
  'article',
  'li'
];

function findCardContainer(img) {
  if (typeof img.closest === 'function') {
    for (const selector of CARD_CONTAINER_SELECTORS) {
      const explicit = img.closest(selector);
      if (explicit) return explicit;
    }
  }
  return img.parentElement || img;
}

function findNearestLink(img, container) {
  if (typeof img.closest === 'function') {
    const parentLink = img.closest('a');
    if (parentLink) return parentLink;
  }
  if (container && typeof container.querySelector === 'function') {
    return container.querySelector('a');
  }
  return null;
}

/**
 * Finds movie/series poster cards in the provided DOM document.
 * @param {Document} doc
 * @param {string} pageUrl
 */
export function findMoviePosterCards(doc, pageUrl = '') {
  if (!doc || typeof doc.querySelectorAll !== 'function') return [];

  const seenContainers = new Set();
  const cards = [];

  // 1. Letterboxd explicit poster nodes
  const lbNodes = Array.from(
    doc.querySelectorAll('.film-poster, [data-film-slug], [data-item-slug]') || []
  );
  for (const node of lbNodes) {
    if (seenContainers.has(node)) continue;
    const img = node.querySelector?.('img');
    const link = node.querySelector?.('a');
    const rawName =
      getAttr(node, 'data-item-name') ||
      getAttr(node, 'data-film-name') ||
      getAttr(link, 'data-original-title') ||
      getAttr(link, 'title') ||
      getAttr(img, 'alt');
    const cleaned = cleanMediaTitle(rawName);
    if (!cleaned.title) continue;

    seenContainers.add(node);
    const card = {
      element: node,
      anchorElement: link || node,
      imdbId: null,
      tmdbId: null,
      type: cleaned.type || 'movie',
      title: cleaned.title,
      year: cleaned.year,
      poster: getAttr(img, 'src') || getAttr(img, 'data-src')
    };
    card.key = normalizeCardKey(card);
    cards.push(card);
  }

  // 2. Scan <img> elements for IMDb, TMDB, and generic movie/download poster cards
  const images = Array.from(doc.querySelectorAll('img') || []);
  for (const img of images) {
    const container = findCardContainer(img);
    if (!container || seenContainers.has(container)) continue;

    const { width, height } = getBoxDimensions(img);
    if (!isPosterAspectRatio(width, height)) continue;

    const link = findNearestLink(img, container);
    const href = getAttr(link, 'href');
    const imdbMatch = href.match(IMDB_ID_RE);
    const tmdbMatch = href.match(TMDB_PATH_RE);

    const isKnownPosterDomain =
      /imdb\.com|themoviedb\.org|letterboxd\.com|trakt\.tv|filmaffinity\.com|justwatch\.com/i.test(
        pageUrl
      ) ||
      Boolean(imdbMatch || tmdbMatch);

    const altOrTitle =
      cleanCardAttrTitle(getAttr(link, 'title')) ||
      cleanCardAttrTitle(getAttr(link, 'data-original-title')) ||
      cleanCardAttrTitle(getAttr(img, 'alt')) ||
      '';
    const cardText = stripInjectedButtonText(
      String(container.textContent || '').trim().slice(0, 240)
    );

    const hasMovieSignals =
      isKnownPosterDomain ||
      MOVIE_URL_HINT_RE.test(href) ||
      QUALITY_OR_YEAR_HINT_RE.test(altOrTitle) ||
      QUALITY_OR_YEAR_HINT_RE.test(cardText);

    if (!hasMovieSignals) continue;

    const cleaned = cleanMediaTitle(altOrTitle || cardText);
    const fallbackSlugMatch = href.match(/\/([^/?#]+?)(?:-(19\d{2}|20\d{2}))?\/?$/);
    const title =
      cleaned.title ||
      (fallbackSlugMatch
        ? fallbackSlugMatch[1].replace(/[-_]+/g, ' ').trim()
        : '');
    const year = cleaned.year || fallbackSlugMatch?.[2] || null;

    if (!title || title.length < 2) continue;

    seenContainers.add(container);
    const card = {
      element: container,
      anchorElement: link || container,
      imdbId: imdbMatch ? imdbMatch[1] : null,
      tmdbId: tmdbMatch ? tmdbMatch[2] : null,
      type: tmdbMatch?.[1]?.toLowerCase() === 'tv' ? 'series' : cleaned.type || 'movie',
      title,
      year,
      poster: getAttr(img, 'src') || getAttr(img, 'data-src')
    };
    card.key = normalizeCardKey(card);
    cards.push(card);
  }

  return cards;
}
