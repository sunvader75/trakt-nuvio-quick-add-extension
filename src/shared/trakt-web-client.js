/**
 * Zero-API-key Trakt.tv Web Session client.
 * Supports both classic trakt.tv and Trakt V3 (app.trakt.tv) browser sessions,
 * plus cookie-based OAuth token extraction.
 * Uses pure regex/string parsing so it runs in both MV3 Service Workers and Node.
 */

import { TRAKT_APP_URL, TRAKT_WEB_URL } from './constants.js';

const IGNORED_COOKIE_NAMES = new Set([
  '__cf_bm',
  'cf_clearance',
  '__cflb',
  '_cfuvid',
  '_ga',
  '_gid',
  '_gat',
  '_fbp',
  '_gcl_au',
  'cookieconsent_status',
  'optanonconsent'
]);

const IGNORED_COOKIE_PREFIXES = ['_ga_', '_pk_id', '_pk_ses'];

const SESSION_COOKIE_HINT_RE =
  /(?:^|[-_.])(?:_?trakt|og[-_]?auth|sveltekit|session|auth|token)/i;

function decodeHtmlEntities(text) {
  return String(text || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function normalizeTitle(text) {
  return decodeHtmlEntities(text)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeBase64Utf8(str) {
  if (!str || typeof str !== 'string') return null;
  let b64 = str.trim();
  if (b64.startsWith('base64-')) {
    b64 = b64.slice(7);
  }
  b64 = b64.replace(/-/g, '+').replace(/_/g, '/');
  const mod = b64.length % 4;
  if (mod === 1) return null;
  if (mod > 0) b64 += '='.repeat(4 - mod);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) return null;

  try {
    if (typeof atob === 'function') {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) {
        bytes[i] = bin.charCodeAt(i);
      }
      return new TextDecoder().decode(bytes);
    }
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(b64, 'base64').toString('utf8');
    }
  } catch {
    return null;
  }
  return null;
}

function tryParseCookieJson(rawValue) {
  if (!rawValue || typeof rawValue !== 'string') return null;
  const seed = [rawValue];
  try {
    const decoded = decodeURIComponent(rawValue);
    if (decoded !== rawValue) seed.push(decoded);
  } catch {
    // Ignore malformed URI sequences
  }

  const expanded = [];
  for (const item of seed) {
    const trimmed = item.trim();
    expanded.push(trimmed);
    const unsigned = trimmed.startsWith('s:')
      ? trimmed.slice(2).replace(/\.[^.]+$/, '')
      : trimmed;
    if (unsigned !== trimmed) expanded.push(unsigned);
    const strippedB64 = unsigned.startsWith('base64-') ? unsigned.slice(7) : unsigned;
    if (strippedB64 !== unsigned) expanded.push(strippedB64);

    const b64Decoded = decodeBase64Utf8(unsigned);
    if (b64Decoded) expanded.push(b64Decoded);
  }

  for (const candidate of expanded) {
    const trimmed = String(candidate || '').trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {
      // Not JSON
    }
  }
  return null;
}

/**
 * Inspects browser cookies for Trakt session cookies or embedded OAuth tokens.
 * @param {Array<{ name: string, value: string }>} cookies
 */
export function extractTraktAuthFromCookies(cookies = []) {
  let hasSessionCookie = false;
  let hasPossibleSessionCookie = false;
  let accessToken = null;
  let refreshToken = null;
  let clientId = null;
  let username = null;
  let slug = null;

  for (const cookie of cookies || []) {
    const name = String(cookie?.name || '').trim();
    const value = String(cookie?.value || '').trim();
    const lowerName = name.toLowerCase();
    if (!name || !value) continue;
    if (
      IGNORED_COOKIE_NAMES.has(lowerName) ||
      IGNORED_COOKIE_PREFIXES.some((prefix) => lowerName.startsWith(prefix))
    ) {
      continue;
    }

    hasPossibleSessionCookie = true;
    if (SESSION_COOKIE_HINT_RE.test(name)) {
      hasSessionCookie = true;
    }

    const parsed = tryParseCookieJson(value);
    if (parsed) {
      const tok =
        parsed.access_token ||
        parsed.accessToken ||
        (typeof parsed.token === 'string' ? parsed.token : null) ||
        parsed.token?.access_token ||
        parsed.token?.accessToken ||
        parsed.token?.value ||
        parsed.auth?.accessToken ||
        parsed.auth?.token ||
        null;
      const ref =
        parsed.refresh_token ||
        parsed.refreshToken ||
        parsed.token?.refresh_token ||
        parsed.token?.refreshToken ||
        parsed.token?.refresh ||
        null;
      const cid = parsed.client_id || parsed.clientId || null;
      if (tok) {
        accessToken = String(tok);
        hasSessionCookie = true;
      }
      if (ref) {
        refreshToken = String(ref);
      }
      if (cid && !clientId) {
        clientId = String(cid);
      }
      const userObj = parsed.user || parsed;
      if (userObj?.username && !username) {
        username = String(userObj.username);
      }
      if (userObj?.ids?.slug && !slug) {
        slug = String(userObj.ids.slug);
      } else if (userObj?.slug && !slug) {
        slug = String(userObj.slug);
      }
    }
  }

  return {
    hasSessionCookie,
    hasPossibleSessionCookie,
    accessToken,
    refreshToken,
    clientId,
    username,
    slug: slug || username
  };
}

export function extractCsrfToken(html) {
  const str = String(html || '');
  const first = str.match(
    /<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i
  );
  if (first) return first[1];
  const second = str.match(
    /<meta[^>]*content=["']([^"']+)["'][^>]*name=["']csrf-token["']/i
  );
  return second ? second[1] : null;
}

export function parseTraktHtmlState(html) {
  const str = String(html || '');
  const attrUser = str.match(/data-username=["']([^"']+)["']/i)?.[1];
  const inputUser = str.match(
    /name=["']user\[username\]["'][^>]*value=["']([^"']+)["']/i
  )?.[1];
  const jsUser = str.match(
    /(?:["']username["']|\busername)\s*:\s*["']([^"'\s]{1,60})["']/i
  )?.[1];
  const jsSlug = str.match(
    /(?:["']slug["']|\bslug)\s*:\s*["']([^"'\s]{1,60})["']/i
  )?.[1];
  const linkSlug = str.match(
    /href=["']\/users\/([^/"'?#]+)(?:\/(?:lists|watchlist|history|progress))?["']/i
  )?.[1];

  const cleanSlug =
    linkSlug && !/^(?:me|sign_in|signin|auth|settings)$/i.test(linkSlug)
      ? linkSlug
      : '';
  const username = attrUser || inputUser || jsUser || cleanSlug || '';
  const slug = cleanSlug || jsSlug || username;

  const authMatch = str.match(
    /(?:["']isAuthorized["']|\bisAuthorized)\s*:\s*(true|!0|false|!1)\b/
  );
  const svelteAuthorized = authMatch
    ? authMatch[1] === 'true' || authMatch[1] === '!0'
    : null;

  const accessToken =
    str.match(
      /(?:["'](?:access_token|accessToken)["']|\b(?:access_token|accessToken))\s*:\s*["']([A-Za-z0-9._~+/-]{20,})["']/
    )?.[1] ||
    str.match(
      /\btoken\s*:\s*\{\s*(?:["']?(?:value|accessToken|access_token)["']?)\s*:\s*["']([A-Za-z0-9._~+/-]{20,})["']/
    )?.[1] ||
    str.match(
      /(?:["']auth["']|\bauth)\s*:\s*\{[^}]{0,300}?(?:["']token["']|\btoken)\s*:\s*["']([A-Za-z0-9._~+/-]{20,})["']/
    )?.[1] ||
    null;

  const clientId =
    str.match(/[?&]client_id=([a-f0-9]{64})\b/i)?.[1] ||
    str.match(
      /(?:["']?(?:client_id|clientId|TRAKT_CLIENT_ID|trakt-api-key)["']?)\s*[:=]\s*["']([a-f0-9]{64})["']/i
    )?.[1] ||
    null;

  const hasSignOutMarker = /href=["'][^"']*\/(?:auth\/signout|logout)["']/i.test(str);
  const hasSignInForm =
    /id=["']new_user["']/i.test(str) ||
    /href=["'][^"']*\/(?:auth\/signin|oauth\/authorize)\b/i.test(str);

  return {
    username,
    slug,
    svelteAuthorized,
    accessToken,
    clientId,
    hasSignOutMarker,
    hasSignInForm
  };
}

export async function checkTraktWebSession(
  fetchImpl = globalThis.fetch,
  options = {}
) {
  const cookieInfo = extractTraktAuthFromCookies(options.cookies || []);

  if (cookieInfo.accessToken) {
    return {
      authenticated: true,
      accessToken: cookieInfo.accessToken,
      clientId: cookieInfo.clientId || null,
      username: cookieInfo.username || 'Trakt User',
      slug: cookieInfo.slug || '',
      csrfToken: null
    };
  }

  let discoveredClientId = cookieInfo.clientId || null;
  const probeUrls = [`${TRAKT_WEB_URL}/settings`, `${TRAKT_APP_URL}/`];

  for (const probeUrl of probeUrls) {
    let response;
    try {
      response = await fetchImpl(probeUrl, {
        method: 'GET',
        credentials: 'include'
      });
    } catch {
      continue;
    }

    if (response.url) {
      const urlCid = response.url.match(/[?&]client_id=([a-f0-9]{64})\b/i)?.[1];
      if (urlCid && !discoveredClientId) discoveredClientId = urlCid;
    }

    if (!response.ok) continue;

    if (response.url && /\/(?:auth\/signin|login|oauth\/authorize)/i.test(response.url)) {
      continue;
    }

    const html = await response.text();
    const state = parseTraktHtmlState(html);
    if (state.clientId && !discoveredClientId) {
      discoveredClientId = state.clientId;
    }

    if (state.svelteAuthorized === false) {
      continue;
    }

    if (
      state.accessToken ||
      state.svelteAuthorized === true ||
      state.username ||
      state.hasSignOutMarker
    ) {
      const resolvedUsername = state.username || cookieInfo.username || 'Trakt User';
      return {
        authenticated: true,
        accessToken: state.accessToken || null,
        clientId: state.clientId || discoveredClientId || null,
        username: resolvedUsername,
        slug: state.slug || cookieInfo.slug || state.username || '',
        csrfToken: extractCsrfToken(html)
      };
    }

    // Trakt V3 (app.trakt.tv) serves an empty SPA shell on 200 OK when authenticated via session cookie
    const isSpaShell =
      (response.url && /app\.trakt\.tv/i.test(response.url)) ||
      /<div[^>]+id=["'](?:app|svelte|root)["']/i.test(html);

    if (
      isSpaShell &&
      (cookieInfo.hasSessionCookie || cookieInfo.hasPossibleSessionCookie) &&
      !state.hasSignInForm
    ) {
      return {
        authenticated: true,
        accessToken: null,
        clientId: state.clientId || discoveredClientId || null,
        username: cookieInfo.username || 'Trakt User',
        slug: cookieInfo.slug || '',
        csrfToken: extractCsrfToken(html)
      };
    }
  }

  return {
    authenticated: false,
    clientId: discoveredClientId || null
  };
}

function parseGridItemsFromHtml(html) {
  const str = String(html || '');
  const items = [];
  const blockRe =
    /<div\b[^>]*class=["'][^"']*\bgrid-item\b[^"']*["'][^>]*>[\s\S]*?(?=<div\b[^>]*class=["'][^"']*\bgrid-item\b|<\/body>|$)/gi;

  const blocks = str.match(blockRe) || [];
  for (const block of blocks) {
    const urlAttr = block.match(/data-url=["'](\/(?:movies|shows)\/[^"']+)["']/i)?.[1];
    const hrefAttr = block.match(/href=["'](\/(?:movies|shows)\/[^"'?#]+)["']/i)?.[1];
    const itemPath = urlAttr || hrefAttr;
    if (!itemPath) continue;

    const isShow =
      /data-type=["']show["']/i.test(block) || /^\/shows\//i.test(itemPath);
    const traktId =
      block.match(/data-(?:movie|show)-id=["'](\d+)["']/i)?.[1] || null;
    const rawAnchorTitle =
      block.match(
        new RegExp(
          `<a\\b[^>]*href=["']${itemPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>([^<]+)<`,
          'i'
        )
      )?.[1] ||
      block.match(/<h3[^>]*>([^<]+)</i)?.[1] ||
      '';
    const yearText =
      block.match(/class=["'][^"']*\byear\b[^"']*["'][^>]*>(\d{4})</i)?.[1] ||
      itemPath.match(/-(19\d{2}|20\d{2})$/)?.[1] ||
      '';

    const title =
      decodeHtmlEntities(rawAnchorTitle) ||
      itemPath
        .replace(/^\/(?:movies|shows)\//, '')
        .replace(/-(19\d{2}|20\d{2})$/, '')
        .replace(/-/g, ' ');

    items.push({
      itemPath,
      traktType: isShow ? 'show' : 'movie',
      content_type: isShow ? 'series' : 'movie',
      traktId,
      title,
      year: yearText
    });
  }

  return items;
}

function scoreWebCandidate(candidate, targetTitle, targetYear) {
  const normCand = normalizeTitle(candidate.title);
  const normTarget = normalizeTitle(targetTitle);
  let score = 0;

  if (normCand === normTarget) score += 100;
  else if (normTarget && (normCand.includes(normTarget) || normTarget.includes(normCand))) {
    score += 50;
  }

  if (targetYear && candidate.year) {
    if (String(candidate.year) === String(targetYear)) score += 50;
    else if (Math.abs(Number(candidate.year) - Number(targetYear)) === 1) score += 15;
    else score -= 15;
  }

  return score;
}

function parseWatchlistState(html) {
  const match = String(html || '').match(
    /<(?:a|button)\b[^>]*class=["'][^"']*\baction-watchlist\b([^"']*)["'][^>]*>/i
  );
  if (!match) return false;
  return /\b(?:selected|in-watchlist|active)\b/i.test(match[0]);
}

export async function pullTraktWebWatchlist(
  slug,
  fetchImpl = globalThis.fetch
) {
  if (!slug) return [];
  const response = await fetchImpl(
    `${TRAKT_WEB_URL}/users/${encodeURIComponent(slug)}/watchlist`,
    {
      method: 'GET',
      credentials: 'include'
    }
  );
  if (!response.ok) return [];
  const html = await response.text();
  return parseGridItemsFromHtml(html).map((item) => ({
    content_id: item.traktId ? `trakt:${item.traktId}` : item.itemPath,
    content_type: item.content_type,
    traktId: item.traktId,
    itemPath: item.itemPath,
    name: item.title,
    year: item.year
  }));
}

export async function resolveTraktWebItem(
  { title, year = null, type = 'movie', imdbId = null },
  fetchImpl = globalThis.fetch
) {
  const isSeries = type === 'series' || type === 'show';
  const searchBucket = isSeries ? 'shows' : 'movies';

  let candidates = [];
  if (title) {
    const searchRes = await fetchImpl(
      `${TRAKT_WEB_URL}/search/${searchBucket}?query=${encodeURIComponent(title)}`,
      { method: 'GET', credentials: 'include' }
    );
    if (searchRes.ok) {
      candidates = parseGridItemsFromHtml(await searchRes.text());
    }
  }

  if (candidates.length === 0 && imdbId) {
    const imdbRes = await fetchImpl(
      `${TRAKT_WEB_URL}/search?query=${encodeURIComponent(imdbId)}`,
      { method: 'GET', credentials: 'include' }
    );
    if (imdbRes.ok) {
      candidates = parseGridItemsFromHtml(await imdbRes.text());
    }
  }

  if (candidates.length === 0) {
    throw new Error('Could not find this title on Trakt.tv.');
  }

  const best = [...candidates].sort(
    (a, b) => scoreWebCandidate(b, title, year) - scoreWebCandidate(a, title, year)
  )[0];

  const detailRes = await fetchImpl(`${TRAKT_WEB_URL}${best.itemPath}`, {
    method: 'GET',
    credentials: 'include'
  });

  if (detailRes.url && /\/auth\/signin/i.test(detailRes.url)) {
    throw new Error('Please sign in to trakt.tv in your browser first.');
  }

  if (!detailRes.ok) {
    throw new Error(`Could not load Trakt page (${detailRes.status}).`);
  }

  const detailHtml = await detailRes.text();
  const csrfToken = extractCsrfToken(detailHtml);
  if (!csrfToken) {
    throw new Error(
      'Please sign in to trakt.tv in your browser (missing session CSRF token).'
    );
  }

  const detailTraktId =
    detailHtml.match(/data-(?:movie|show)-id=["'](\d+)["']/i)?.[1] ||
    best.traktId;

  return {
    itemPath: best.itemPath,
    traktType: best.traktType,
    content_type: best.content_type,
    traktId: detailTraktId,
    title: best.title,
    year: best.year,
    csrfToken,
    inWatchlist: parseWatchlistState(detailHtml)
  };
}

async function postWatchlistToggle(resolved, fetchImpl) {
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
    'X-Requested-With': 'XMLHttpRequest',
    'X-CSRF-Token': resolved.csrfToken
  };

  const primary = await fetchImpl(
    `${TRAKT_WEB_URL}${resolved.itemPath}/watchlist`,
    {
      method: 'POST',
      credentials: 'include',
      headers,
      body: ''
    }
  );

  if (primary.ok) {
    return primary;
  }

  if (primary.status === 404 || primary.status === 405) {
    const fallbackUrl = resolved.inWatchlist
      ? `${TRAKT_WEB_URL}${resolved.itemPath}/list/remove`
      : `${TRAKT_WEB_URL}${resolved.itemPath}/list`;

    const body = new URLSearchParams({
      type: resolved.traktType,
      trakt_id: resolved.traktId || '',
      list_id: 'watchlist'
    }).toString();

    const fallback = await fetchImpl(fallbackUrl, {
      method: 'POST',
      credentials: 'include',
      headers,
      body
    });

    if (!fallback.ok) {
      throw new Error(`Trakt web request failed (HTTP ${fallback.status}).`);
    }
    return fallback;
  }

  if (primary.status === 401 || primary.status === 403) {
    throw new Error('Trakt session expired. Please sign in at trakt.tv.');
  }

  throw new Error(`Trakt web request failed (HTTP ${primary.status}).`);
}

export async function addViaTraktWebSession(
  media,
  fetchImpl = globalThis.fetch
) {
  const resolved = await resolveTraktWebItem(
    {
      title: media?.name || media?.title || '',
      year: media?.releaseInfo || media?.year || null,
      type: media?.type || media?.contentType || 'movie',
      imdbId: media?.imdbId || null
    },
    fetchImpl
  );

  if (resolved.inWatchlist) {
    return {
      ok: true,
      alreadyInWatchlist: true,
      item: resolved
    };
  }

  await postWatchlistToggle(resolved, fetchImpl);
  return {
    ok: true,
    alreadyInWatchlist: false,
    item: { ...resolved, inWatchlist: true }
  };
}

export async function removeViaTraktWebSession(
  media,
  fetchImpl = globalThis.fetch
) {
  const resolved = await resolveTraktWebItem(
    {
      title: media?.name || media?.title || '',
      year: media?.releaseInfo || media?.year || null,
      type: media?.type || media?.contentType || 'movie',
      imdbId: media?.imdbId || null
    },
    fetchImpl
  );

  if (!resolved.inWatchlist) {
    return { ok: true, alreadyRemoved: true, item: resolved };
  }

  await postWatchlistToggle(resolved, fetchImpl);
  return {
    ok: true,
    alreadyRemoved: false,
    item: { ...resolved, inWatchlist: false }
  };
}
