/**
 * Resolves extracted page media or manual search queries into canonical Nuvio
 * library items via Cinemeta (zero-config) and optional TMDB API.
 */

import {
  CINEMETA_BASE_URL,
  ID_FORMATS,
  TMDB_BACKDROP_BASE_URL,
  TMDB_BASE_URL,
  TMDB_IMAGE_BASE_URL
} from './constants.js';
import { cleanMediaTitle } from './title-cleaner.js';
import { searchTraktCatalog } from './trakt-client.js';

function normalizeComparable(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractReleaseYear(releaseInfo) {
  const match = String(releaseInfo || '').match(/\b(19\d{2}|20\d{2})\b/);
  return match ? Number(match[1]) : null;
}

function scoreCandidate(candidate, targetTitle, targetYear) {
  const normCandidate = normalizeComparable(candidate.name);
  const normTarget = normalizeComparable(targetTitle);
  let score = 0;

  if (normCandidate === normTarget) {
    score += 100;
  } else if (
    normTarget &&
    (normCandidate.includes(normTarget) || normTarget.includes(normCandidate))
  ) {
    score += 55;
  } else {
    const targetWords = new Set(normTarget.split(' ').filter(Boolean));
    const candWords = normCandidate.split(' ').filter(Boolean);
    const overlap = candWords.filter((w) => targetWords.has(w)).length;
    score += overlap * 15;
  }

  if (targetYear) {
    const wanted = Number(targetYear);
    const actual = extractReleaseYear(candidate.releaseInfo);
    if (actual === wanted) {
      score += 50;
    } else if (actual !== null && Math.abs(actual - wanted) === 1) {
      score += 20;
    } else if (actual !== null) {
      score -= 15;
    }
  }

  return score;
}

function parseRating(value) {
  if (value === null || value === undefined || value === '') return undefined;
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? Number(num.toFixed(1)) : undefined;
}

function buildTmdbHeadersAndQuery(tmdbApiKey) {
  const key = String(tmdbApiKey || '').trim();
  if (!key) return null;

  // TMDB v4 Read Access Tokens are JWTs (or long bearer tokens containing dots)
  if (key.includes('.') || key.length > 40) {
    return {
      headers: { Authorization: `Bearer ${key}` },
      querySuffix: ''
    };
  }

  return {
    headers: {},
    querySuffix: `api_key=${encodeURIComponent(key)}`
  };
}

async function fetchJsonSafe(url, options, fetchImpl) {
  const response = await fetchImpl(url, options);
  if (!response.ok) {
    return null;
  }
  return await response.json();
}

async function fetchCinemetaByImdb(imdbId, type, fetchImpl) {
  const mediaType = type === 'series' ? 'series' : 'movie';
  const url = `${CINEMETA_BASE_URL}/meta/${mediaType}/${encodeURIComponent(imdbId)}.json`;
  const data = await fetchJsonSafe(url, undefined, fetchImpl);
  if (!data?.meta?.id) return null;

  const meta = data.meta;
  return {
    imdbId: meta.id,
    tmdbId: null,
    type: meta.type === 'series' ? 'series' : 'movie',
    name: meta.name || '',
    poster: meta.poster || '',
    background: meta.background || '',
    description: meta.description || '',
    releaseInfo: meta.releaseInfo || '',
    imdbRating: parseRating(meta.imdbRating),
    genres: Array.isArray(meta.genres) ? meta.genres : [],
    source: 'cinemeta'
  };
}

async function searchCinemetaCatalog(query, type, fetchImpl) {
  const mediaType = type === 'series' ? 'series' : 'movie';
  const url = `${CINEMETA_BASE_URL}/catalog/${mediaType}/top/search=${encodeURIComponent(query)}.json`;
  const data = await fetchJsonSafe(url, undefined, fetchImpl);
  return Array.isArray(data?.metas) ? data.metas : [];
}

async function fetchTmdbById(tmdbId, type, tmdbApiKey, fetchImpl) {
  const auth = buildTmdbHeadersAndQuery(tmdbApiKey);
  if (!auth) return null;

  const endpointType = type === 'series' ? 'tv' : 'movie';
  const sep = auth.querySuffix ? `&${auth.querySuffix}` : '';
  const url = `${TMDB_BASE_URL}/${endpointType}/${encodeURIComponent(tmdbId)}?append_to_response=external_ids${sep}`;
  const data = await fetchJsonSafe(url, { headers: auth.headers }, fetchImpl);
  if (!data?.id) return null;

  const title = data.title || data.name || '';
  const dateStr = data.release_date || data.first_air_date || '';
  const year = dateStr.slice(0, 4);

  return {
    imdbId: data.external_ids?.imdb_id || null,
    tmdbId: String(data.id),
    type: endpointType === 'tv' ? 'series' : 'movie',
    name: title,
    poster: data.poster_path ? `${TMDB_IMAGE_BASE_URL}${data.poster_path}` : '',
    background: data.backdrop_path
      ? `${TMDB_BACKDROP_BASE_URL}${data.backdrop_path}`
      : '',
    description: data.overview || '',
    releaseInfo: year || '',
    imdbRating: parseRating(data.vote_average),
    genres: Array.isArray(data.genres) ? data.genres.map((g) => g.name) : [],
    source: 'tmdb'
  };
}

async function searchTmdbByTitle(title, year, type, tmdbApiKey, fetchImpl) {
  const auth = buildTmdbHeadersAndQuery(tmdbApiKey);
  if (!auth) return [];

  const endpointType = type === 'series' ? 'tv' : 'movie';
  const yearParam = year
    ? endpointType === 'tv'
      ? `&first_air_date_year=${encodeURIComponent(year)}`
      : `&year=${encodeURIComponent(year)}`
    : '';
  const sep = auth.querySuffix ? `&${auth.querySuffix}` : '';
  const url = `${TMDB_BASE_URL}/search/${endpointType}?query=${encodeURIComponent(title)}${yearParam}${sep}`;
  const data = await fetchJsonSafe(url, { headers: auth.headers }, fetchImpl);
  if (!Array.isArray(data?.results)) return [];

  return data.results.slice(0, 8).map((item) => ({
    imdbId: null,
    tmdbId: String(item.id),
    type: endpointType === 'tv' ? 'series' : 'movie',
    name: item.title || item.name || '',
    poster: item.poster_path ? `${TMDB_IMAGE_BASE_URL}${item.poster_path}` : '',
    background: item.backdrop_path
      ? `${TMDB_BACKDROP_BASE_URL}${item.backdrop_path}`
      : '',
    description: item.overview || '',
    releaseInfo: (item.release_date || item.first_air_date || '').slice(0, 4),
    imdbRating: parseRating(item.vote_average),
    genres: [],
    source: 'tmdb'
  }));
}

/**
 * Resolves extracted DOM media (or query) to canonical metadata.
 * @param {{ imdbId?: string|null, tmdbId?: string|null, type?: 'movie'|'series', title?: string, year?: string|null, poster?: string }} extracted
 * @param {{ tmdbApiKey?: string }} options
 * @param {typeof fetch} fetchImpl
 */
export async function resolveMediaMetadata(
  extracted,
  options = {},
  fetchImpl = globalThis.fetch
) {
  const type = extracted?.type === 'series' ? 'series' : 'movie';
  const tmdbApiKey = options?.tmdbApiKey || '';
  const traktClientId = options?.traktClientId || '';

  if (extracted?.imdbId) {
    const direct = await fetchCinemetaByImdb(extracted.imdbId, type, fetchImpl);
    if (direct) {
      return {
        ...direct,
        tmdbId: extracted.tmdbId || direct.tmdbId,
        traktId: extracted.traktId || null
      };
    }
  }

  if (extracted?.tmdbId && tmdbApiKey) {
    const tmdbMeta = await fetchTmdbById(
      extracted.tmdbId,
      type,
      tmdbApiKey,
      fetchImpl
    );
    if (tmdbMeta) {
      return tmdbMeta;
    }
  }

  const rawTitle = extracted?.title || extracted?.name || '';
  const explicitYear = extracted?.year || extracted?.releaseInfo || null;
  if (rawTitle) {
    const cleaned = cleanMediaTitle(rawTitle);
    const searchTitle = cleaned.title || rawTitle;
    const targetYear = explicitYear || cleaned.year;

    const candidates = await searchCinemetaCatalog(searchTitle, type, fetchImpl);
    if (candidates.length > 0) {
      const ranked = [...candidates].sort(
        (a, b) =>
          scoreCandidate(b, searchTitle, targetYear) -
          scoreCandidate(a, searchTitle, targetYear)
      );
      const best = ranked[0];
      const bestScore = scoreCandidate(best, searchTitle, targetYear);
      // Only accept Cinemeta directly if it's a plausible match or we have no Trakt fallback
      if (bestScore >= 35 || !traktClientId) {
        const enriched = await fetchCinemetaByImdb(best.id, type, fetchImpl);
        if (enriched) {
          return {
            ...enriched,
            tmdbId: extracted?.tmdbId || null,
            traktId: extracted?.traktId || null
          };
        }
        return {
          imdbId: best.id,
          tmdbId: extracted?.tmdbId || null,
          traktId: extracted?.traktId || null,
          type,
          name: best.name || searchTitle,
          poster: best.poster || extracted?.poster || '',
          background: '',
          description: '',
          releaseInfo: best.releaseInfo || targetYear || '',
          imdbRating: undefined,
          genres: [],
          source: 'cinemeta'
        };
      }
    }

    if (traktClientId) {
      let traktMatches = await searchTraktCatalog(
        { clientId: traktClientId, query: searchTitle, year: targetYear, type },
        fetchImpl
      );
      if (traktMatches.length === 0 && targetYear) {
        traktMatches = await searchTraktCatalog(
          { clientId: traktClientId, query: searchTitle, year: null, type },
          fetchImpl
        );
      }
      if (traktMatches.length > 0) {
        const bestTrakt = traktMatches[0];
        const enriched = bestTrakt.imdbId
          ? await fetchCinemetaByImdb(bestTrakt.imdbId, type, fetchImpl)
          : null;
        return {
          imdbId: bestTrakt.imdbId || enriched?.imdbId || null,
          tmdbId: bestTrakt.tmdbId || null,
          traktId: bestTrakt.traktId || null,
          type,
          name: enriched?.name || bestTrakt.name || searchTitle,
          poster: enriched?.poster || extracted?.poster || '',
          background: enriched?.background || '',
          description: enriched?.description || '',
          releaseInfo: bestTrakt.releaseInfo || enriched?.releaseInfo || targetYear || '',
          imdbRating: enriched?.imdbRating,
          genres: enriched?.genres || [],
          source: 'trakt'
        };
      }
    }

    if (tmdbApiKey) {
      const tmdbResults = await searchTmdbByTitle(
        searchTitle,
        targetYear,
        type,
        tmdbApiKey,
        fetchImpl
      );
      if (tmdbResults.length > 0) {
        const detailed = await fetchTmdbById(
          tmdbResults[0].tmdbId,
          type,
          tmdbApiKey,
          fetchImpl
        );
        return detailed || tmdbResults[0];
      }
    }
  }

  // Fallback when API lookups miss but canonical ID or title was extracted from page
  if (extracted?.imdbId || extracted?.tmdbId || extracted?.traktId || rawTitle) {
    return {
      imdbId: extracted.imdbId || null,
      tmdbId: extracted.tmdbId || null,
      traktId: extracted.traktId || null,
      type,
      name: rawTitle || 'Unknown Title',
      poster: extracted.poster || '',
      background: '',
      description: '',
      releaseInfo: explicitYear || '',
      imdbRating: undefined,
      genres: [],
      source: 'page'
    };
  }

  return null;
}

/**
 * Searches movies and series for manual popup search / disambiguation.
 * @param {string} rawQuery
 * @param {{ tmdbApiKey?: string }} options
 * @param {typeof fetch} fetchImpl
 */
export async function searchMediaCandidates(
  rawQuery,
  options = {},
  fetchImpl = globalThis.fetch
) {
  const cleaned = cleanMediaTitle(rawQuery);
  const query = cleaned.title || String(rawQuery || '').trim();
  if (!query) return [];

  const [movies, series] = await Promise.all([
    searchCinemetaCatalog(query, 'movie', fetchImpl),
    searchCinemetaCatalog(query, 'series', fetchImpl)
  ]);

  const combined = [...movies, ...series].map((item) => ({
    imdbId: item.id,
    tmdbId: null,
    type: item.type === 'series' ? 'series' : 'movie',
    name: item.name || '',
    poster: item.poster || '',
    background: '',
    description: '',
    releaseInfo: item.releaseInfo || '',
    imdbRating: undefined,
    genres: [],
    source: 'cinemeta'
  }));

  const seen = new Set();
  const deduped = [];
  for (const item of combined) {
    const key = `${item.type}:${item.imdbId}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(item);
    }
  }

  if (deduped.length === 0 && options?.traktClientId) {
    const [traktMovies, traktShows] = await Promise.all([
      searchTraktCatalog(
        {
          clientId: options.traktClientId,
          query,
          year: cleaned.year,
          type: 'movie'
        },
        fetchImpl
      ),
      searchTraktCatalog(
        {
          clientId: options.traktClientId,
          query,
          year: cleaned.year,
          type: 'series'
        },
        fetchImpl
      )
    ]);
    return [...traktMovies, ...traktShows].slice(0, 12);
  }

  if (deduped.length === 0 && options?.tmdbApiKey) {
    return searchTmdbByTitle(
      query,
      cleaned.year,
      cleaned.type,
      options.tmdbApiKey,
      fetchImpl
    );
  }

  return deduped
    .sort(
      (a, b) =>
        scoreCandidate(b, query, cleaned.year) -
        scoreCandidate(a, query, cleaned.year)
    )
    .slice(0, 12);
}

/**
 * Converts resolved media metadata into the Nuvio sync_push_library_items payload entry.
 * @param {object} resolved
 * @param {'imdb'|'tmdb'} preferredIdFormat
 * @param {number} addedAtMs
 */
export function toNuvioLibraryItem(
  resolved,
  preferredIdFormat = ID_FORMATS.IMDB,
  addedAtMs = Date.now()
) {
  let contentId = null;

  if (preferredIdFormat === ID_FORMATS.TMDB && resolved.tmdbId) {
    contentId = `tmdb:${resolved.tmdbId}`;
  } else if (resolved.imdbId) {
    contentId = resolved.imdbId;
  } else if (resolved.tmdbId) {
    contentId = `tmdb:${resolved.tmdbId}`;
  }

  if (!contentId) {
    throw new Error('Cannot build Nuvio library item without an IMDb or TMDB ID.');
  }

  const item = {
    content_id: contentId,
    content_type: resolved.type === 'series' ? 'series' : 'movie',
    name: resolved.name || 'Untitled',
    poster: resolved.poster || null,
    poster_shape: 'POSTER',
    added_at: Number.isFinite(addedAtMs) ? Math.trunc(addedAtMs) : Date.now()
  };

  if (resolved.background) item.background = resolved.background;
  if (resolved.description) item.description = resolved.description;
  if (resolved.releaseInfo) item.release_info = String(resolved.releaseInfo);
  if (typeof resolved.imdbRating === 'number' && Number.isFinite(resolved.imdbRating)) {
    item.imdb_rating = resolved.imdbRating;
  }
  if (Array.isArray(resolved.genres) && resolved.genres.length > 0) {
    item.genres = resolved.genres;
  }

  return item;
}
