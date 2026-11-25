/**
 * Trakt API v2 client for Device OAuth, single-use refresh tokens,
 * user profile lookup, and Watchlist synchronization.
 */

import { TRAKT_BASE_URL } from './constants.js';

const TRAKT_API_VERSION = '2';
const OOB_REDIRECT_URI = 'urn:ietf:wg:oauth:2.0:oob';

function buildTraktHeaders(clientId, accessToken = null) {
  const headers = {
    'Content-Type': 'application/json',
    'trakt-api-version': TRAKT_API_VERSION,
    'trakt-api-key': String(clientId || '').trim()
  };
  if (accessToken) {
    headers.Authorization = `Bearer ${accessToken}`;
  }
  return headers;
}

async function parseJsonBody(response) {
  if (typeof response.text === 'function') {
    const raw = await response.text();
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return { message: raw };
    }
  }
  if (typeof response.json === 'function') {
    return await response.json();
  }
  return null;
}

function extractTraktError(payload, status) {
  if (!payload || typeof payload !== 'object') {
    return `Trakt HTTP ${status}`;
  }
  return (
    payload.error_description ||
    payload.message ||
    payload.error ||
    `Trakt HTTP ${status}`
  );
}

function normalizeTraktSession(payload, previousUser = null) {
  const nowSec = Math.floor(Date.now() / 1000);
  const createdAt = Number(payload.created_at) || nowSec;
  const expiresIn = Number(payload.expires_in) || 86400;
  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_in: expiresIn,
    expires_at: createdAt + expiresIn,
    user: payload.user || previousUser || null
  };
}

export async function requestTraktDeviceCode(
  { clientId },
  fetchImpl = globalThis.fetch
) {
  const cleanId = String(clientId || '').trim();
  if (!cleanId) {
    throw new Error('Trakt Client ID is required.');
  }

  const response = await fetchImpl(`${TRAKT_BASE_URL}/oauth/device/code`, {
    method: 'POST',
    headers: buildTraktHeaders(cleanId),
    body: JSON.stringify({ client_id: cleanId })
  });

  const payload = await parseJsonBody(response);
  if (!response.ok) {
    throw new Error(extractTraktError(payload, response.status));
  }

  return payload;
}

export async function pollTraktDeviceToken(
  { clientId, clientSecret = '', deviceCode },
  fetchImpl = globalThis.fetch
) {
  const cleanId = String(clientId || '').trim();
  const cleanSecret = String(clientSecret || '').trim();

  const body = {
    code: deviceCode,
    client_id: cleanId
  };
  if (cleanSecret) {
    body.client_secret = cleanSecret;
  }

  const response = await fetchImpl(`${TRAKT_BASE_URL}/oauth/device/token`, {
    method: 'POST',
    headers: buildTraktHeaders(cleanId),
    body: JSON.stringify(body)
  });

  const payload = await parseJsonBody(response);

  if (response.status === 200 && payload?.access_token) {
    return {
      status: 'authorized',
      session: normalizeTraktSession(payload)
    };
  }
  if (response.status === 400) {
    return { status: 'pending' };
  }
  if (response.status === 429) {
    return { status: 'slow_down' };
  }
  if (response.status === 410) {
    return { status: 'expired' };
  }
  if (response.status === 418) {
    return { status: 'denied' };
  }
  if (response.status === 409) {
    return { status: 'already_used' };
  }
  if (response.status === 404) {
    return { status: 'not_found' };
  }

  throw new Error(extractTraktError(payload, response.status));
}

export async function refreshTraktSession(
  { clientId, clientSecret = '', refreshToken, previousUser = null },
  fetchImpl = globalThis.fetch
) {
  const cleanId = String(clientId || '').trim();
  const cleanSecret = String(clientSecret || '').trim();

  const body = {
    refresh_token: refreshToken,
    client_id: cleanId,
    redirect_uri: OOB_REDIRECT_URI,
    grant_type: 'refresh_token'
  };
  if (cleanSecret) {
    body.client_secret = cleanSecret;
  }

  const response = await fetchImpl(`${TRAKT_BASE_URL}/oauth/token`, {
    method: 'POST',
    headers: buildTraktHeaders(cleanId),
    body: JSON.stringify(body)
  });

  const payload = await parseJsonBody(response);
  if (!response.ok) {
    throw new Error(extractTraktError(payload, response.status));
  }

  return normalizeTraktSession(payload, previousUser);
}

export async function ensureValidTraktSession(
  { clientId, clientSecret = '', session },
  fetchImpl = globalThis.fetch
) {
  if (!session?.access_token) {
    throw new Error('Not signed in to Trakt.');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const needsRefresh =
    typeof session.expires_at === 'number' && session.expires_at - nowSec < 120;

  if (!needsRefresh) {
    return session;
  }

  if (!session.refresh_token) {
    throw new Error('Trakt session expired. Please reconnect Trakt.');
  }

  return refreshTraktSession(
    {
      clientId,
      clientSecret,
      refreshToken: session.refresh_token,
      previousUser: session.user
    },
    fetchImpl
  );
}

async function callTraktAuthed(
  {
    clientId,
    clientSecret = '',
    session,
    path,
    method = 'GET',
    body = undefined,
    onSessionRefreshed
  },
  fetchImpl = globalThis.fetch
) {
  const cleanId = String(clientId || '').trim();
  if (!cleanId) {
    throw new Error('Trakt Client ID is missing in Settings.');
  }

  let activeSession = await ensureValidTraktSession(
    { clientId: cleanId, clientSecret, session },
    fetchImpl
  );

  if (activeSession !== session && typeof onSessionRefreshed === 'function') {
    await onSessionRefreshed(activeSession);
  }

  const sendRequest = (token) =>
    fetchImpl(`${TRAKT_BASE_URL}${path}`, {
      method,
      headers: buildTraktHeaders(cleanId, token),
      body: body !== undefined ? JSON.stringify(body) : undefined
    });

  let response = await sendRequest(activeSession.access_token);

  if (response.status === 401 && activeSession.refresh_token) {
    activeSession = await refreshTraktSession(
      {
        clientId: cleanId,
        clientSecret,
        refreshToken: activeSession.refresh_token,
        previousUser: activeSession.user
      },
      fetchImpl
    );
    if (typeof onSessionRefreshed === 'function') {
      await onSessionRefreshed(activeSession);
    }
    response = await sendRequest(activeSession.access_token);
  }

  const payload = await parseJsonBody(response);
  if (!response.ok) {
    throw new Error(extractTraktError(payload, response.status));
  }

  return payload;
}

export async function fetchTraktUserSettings(ctx, fetchImpl = globalThis.fetch) {
  const data = await callTraktAuthed(
    { ...ctx, path: '/users/settings', method: 'GET' },
    fetchImpl
  );
  return {
    username: data?.user?.username || 'Trakt User',
    slug: data?.user?.ids?.slug || ''
  };
}

export async function pullTraktWatchlist(ctx, fetchImpl = globalThis.fetch) {
  const rows = await callTraktAuthed(
    { ...ctx, path: '/sync/watchlist', method: 'GET' },
    fetchImpl
  );

  if (!Array.isArray(rows)) return [];

  return rows
    .filter((entry) => entry?.type === 'movie' || entry?.type === 'show')
    .map((entry) => {
      const isShow = entry.type === 'show';
      const item = isShow ? entry.show : entry.movie;
      const ids = item?.ids || {};
      const imdbId = ids.imdb ? String(ids.imdb) : null;
      const tmdbId =
        ids.tmdb !== null && ids.tmdb !== undefined ? String(ids.tmdb) : null;

      return {
        content_id: imdbId || (tmdbId ? `tmdb:${tmdbId}` : ''),
        content_type: isShow ? 'series' : 'movie',
        imdbId,
        tmdbId,
        name: item?.title || '',
        year: item?.year ? String(item.year) : '',
        listed_at: entry.listed_at || ''
      };
    });
}

export async function searchTraktCatalog(
  { clientId, query, year = null, type = 'movie' },
  fetchImpl = globalThis.fetch
) {
  const cleanId = String(clientId || '').trim();
  const cleanQuery = String(query || '').trim();
  if (!cleanId || !cleanQuery) return [];

  const endpointType = type === 'series' ? 'show' : 'movie';
  const yearParam = year ? `&years=${encodeURIComponent(String(year).slice(0, 4))}` : '';
  const url = `${TRAKT_BASE_URL}/search/${endpointType}?query=${encodeURIComponent(cleanQuery)}${yearParam}`;

  const response = await fetchImpl(url, {
    method: 'GET',
    headers: buildTraktHeaders(cleanId)
  });

  if (!response.ok) return [];
  const rows = await parseJsonBody(response);
  if (!Array.isArray(rows)) return [];

  return rows
    .map((entry) => {
      const media = entry?.[endpointType];
      const ids = media?.ids || {};
      return {
        traktId: ids.trakt ? String(ids.trakt) : null,
        imdbId: ids.imdb ? String(ids.imdb) : null,
        tmdbId:
          ids.tmdb !== null && ids.tmdb !== undefined ? String(ids.tmdb) : null,
        slug: ids.slug ? String(ids.slug) : null,
        type: endpointType === 'show' ? 'series' : 'movie',
        name: media?.title || '',
        releaseInfo: media?.year ? String(media.year) : '',
        score: Number(entry?.score || 0)
      };
    })
    .filter((item) => item.imdbId || item.tmdbId || item.traktId);
}

function buildTraktSyncPayload(media) {
  const isSeries = media?.type === 'series' || media?.contentType === 'series';
  const bucket = isSeries ? 'shows' : 'movies';

  const ids = {};
  if (media?.imdbId) {
    ids.imdb = String(media.imdbId);
  }
  if (media?.tmdbId) {
    const numericTmdb = Number(media.tmdbId);
    if (Number.isInteger(numericTmdb) && numericTmdb > 0) {
      ids.tmdb = numericTmdb;
    }
  }
  if (media?.traktId) {
    const numericTrakt = Number(media.traktId);
    if (Number.isInteger(numericTrakt) && numericTrakt > 0) {
      ids.trakt = numericTrakt;
    }
  }
  if (!ids.imdb && !ids.tmdb && !ids.trakt && media?.contentId) {
    const rawId = String(media.contentId);
    if (/^tt\d+/i.test(rawId)) {
      ids.imdb = rawId;
    } else if (/^tmdb:\d+$/i.test(rawId)) {
      ids.tmdb = Number(rawId.slice(5));
    } else if (/^trakt:\d+$/i.test(rawId)) {
      ids.trakt = Number(rawId.slice(6));
    }
  }

  if (!ids.imdb && !ids.tmdb && !ids.trakt) {
    throw new Error('Cannot sync to Trakt without an IMDb, TMDB, or Trakt ID.');
  }

  const entry = { ids };
  if (media?.name) {
    entry.title = String(media.name);
  }
  const yearMatch = String(media?.releaseInfo || media?.year || '').match(
    /\b(19\d{2}|20\d{2})\b/
  );
  if (yearMatch) {
    entry.year = Number(yearMatch[1]);
  }

  return {
    bucket,
    payload: { [bucket]: [entry] }
  };
}

export async function addToTraktWatchlist(
  { media, ...ctx },
  fetchImpl = globalThis.fetch
) {
  const { bucket, payload } = buildTraktSyncPayload(media);
  const res = await callTraktAuthed(
    {
      ...ctx,
      path: '/sync/watchlist',
      method: 'POST',
      body: payload
    },
    fetchImpl
  );

  const addedCount = Number(res?.added?.[bucket] || 0);
  const existingCount = Number(res?.existing?.[bucket] || 0);
  const notFoundList = res?.not_found?.[bucket] || [];

  if (addedCount === 0 && existingCount === 0 && notFoundList.length > 0) {
    throw new Error('Trakt could not find this title in its catalog.');
  }

  return {
    ok: true,
    added: addedCount > 0,
    existing: existingCount > 0
  };
}

export async function removeFromTraktWatchlist(
  { media, ...ctx },
  fetchImpl = globalThis.fetch
) {
  const { payload } = buildTraktSyncPayload(media);
  await callTraktAuthed(
    {
      ...ctx,
      path: '/sync/watchlist/remove',
      method: 'POST',
      body: payload
    },
    fetchImpl
  );
  return { ok: true };
}
