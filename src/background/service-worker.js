/**
 * MV3 Service Worker for Nuvio Quick Add (Chrome & Opera GX).
 * Default mode: Trakt Web Session (supports both app.trakt.tv V3 & trakt.tv Classic,
 * zero API keys / zero GitHub required).
 * Also supports Trakt OAuth App API, Nuvio Cloud Library, or Both.
 * Ephemeral design: zero persistent in-memory state; all state lives in chrome.storage.local.
 */

import {
  DEFAULT_SETTINGS,
  MESSAGE_TYPES,
  STORAGE_KEYS,
  SYNC_TARGETS,
  TRAKT_APP_URL
} from '../shared/constants.js';
import {
  resolveMediaMetadata,
  searchMediaCandidates,
  toNuvioLibraryItem
} from '../shared/metadata-resolver.js';
import {
  deleteLibraryItems,
  ensureValidSession,
  pullLibrary,
  pullProfiles,
  pushLibraryItems,
  signInWithPassword
} from '../shared/nuvio-client.js';
import {
  addToTraktWatchlist,
  ensureValidTraktSession,
  fetchTraktUserSettings,
  pollTraktDeviceToken,
  pullTraktWatchlist,
  removeFromTraktWatchlist,
  requestTraktDeviceCode
} from '../shared/trakt-client.js';
import {
  addViaTraktWebSession,
  checkTraktWebSession,
  extractTraktAuthFromCookies,
  parseTraktHtmlState,
  pullTraktWebWatchlist,
  removeViaTraktWebSession
} from '../shared/trakt-web-client.js';

const MENU_ADD_SELECTION = 'nuvio-add-selection';
const MENU_ADD_PAGE = 'nuvio-add-page';
const BADGE_CLEAR_ALARM = 'nuvio-clear-badge';
const TRAKT_POLL_ALARM = 'nuvio-trakt-poll';
const TRAKT_DNR_RULE_WEB = 1001;
const TRAKT_DNR_RULE_APP = 1002;
const TRAKT_PROBE_SESSION_KEY = 'traktLastSilentProbeAt';

function normalizeTitleKey(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function getAllTraktCookies(openTabs = []) {
  if (!chrome.cookies?.getAll) return [];
  const collected = [];
  const seen = new Set();

  const pushUnique = (list) => {
    for (const c of list || []) {
      const key = `${c?.storeId || ''}|${c?.domain || ''}|${c?.name || ''}`;
      if (c?.name && c?.value && !seen.has(key)) {
        seen.add(key);
        collected.push(c);
      }
    }
  };

  const storeIds = new Set();
  try {
    if (chrome.cookies.getAllCookieStores) {
      const allStores = await chrome.cookies.getAllCookieStores();
      for (const s of allStores || []) {
        if (s?.id) storeIds.add(s.id);
      }
    }
  } catch {
    // Fallback to default store
  }

  for (const tab of openTabs || []) {
    if (tab?.cookieStoreId) {
      storeIds.add(String(tab.cookieStoreId));
    }
  }

  const stores = storeIds.size > 0 ? Array.from(storeIds) : [undefined];

  for (const storeId of stores) {
    const baseOpts = storeId ? { storeId } : {};
    for (const query of [
      { ...baseOpts, domain: 'trakt.tv' },
      { ...baseOpts, url: 'https://app.trakt.tv/' },
      { ...baseOpts, url: 'https://trakt.tv/' }
    ]) {
      try {
        pushUnique(await chrome.cookies.getAll(query));
      } catch {
        // Ignore query errors
      }
      try {
        pushUnique(await chrome.cookies.getAll({ ...query, partitionKey: {} }));
      } catch {
        // Older Chromium builds may not accept empty partitionKey
      }
    }
  }

  return collected;
}

async function findOpenTraktTabs() {
  try {
    const allTabs = await chrome.tabs.query({});
    return allTabs.filter((tab) =>
      /^https:\/\/(?:app\.|og\.)?trakt\.tv(?:\/|$)/i.test(String(tab?.url || ''))
    );
  } catch {
    return [];
  }
}

async function ensureTraktHeaderRule(preloadedCookies = null) {
  if (!chrome.declarativeNetRequest) return;

  const cookies = preloadedCookies || (await getAllTraktCookies(await findOpenTraktTabs()));
  const cookieHeader = cookies
    .filter((c) => c?.name && c?.value)
    .map((c) => `${c.name}=${c.value}`)
    .join('; ');

  const buildHeaders = (originUrl) => {
    const list = [
      { header: 'Origin', operation: 'set', value: originUrl },
      { header: 'Referer', operation: 'set', value: `${originUrl}/` }
    ];
    if (cookieHeader) {
      list.push({ header: 'Cookie', operation: 'set', value: cookieHeader });
    }
    return list;
  };

  const buildRules = (conditionExtra) => [
    {
      id: TRAKT_DNR_RULE_WEB,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: buildHeaders('https://trakt.tv')
      },
      condition: {
        ...conditionExtra,
        urlFilter: '||trakt.tv/',
        excludedRequestDomains: ['api.trakt.tv'],
        resourceTypes: ['xmlhttprequest']
      }
    },
    {
      id: TRAKT_DNR_RULE_APP,
      priority: 2,
      action: {
        type: 'modifyHeaders',
        requestHeaders: buildHeaders('https://app.trakt.tv')
      },
      condition: {
        ...conditionExtra,
        urlFilter: '||app.trakt.tv/',
        excludedRequestDomains: ['api.trakt.tv'],
        resourceTypes: ['xmlhttprequest']
      }
    }
  ];

  // Clear any legacy dynamic rules before applying session rules
  if (chrome.declarativeNetRequest.updateDynamicRules) {
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [TRAKT_DNR_RULE_WEB, TRAKT_DNR_RULE_APP]
      });
    } catch {
      // Ignore cleanup errors
    }
  }

  const tabIdNone = chrome.tabs?.TAB_ID_NONE ?? -1;
  if (chrome.declarativeNetRequest.updateSessionRules) {
    try {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [TRAKT_DNR_RULE_WEB, TRAKT_DNR_RULE_APP],
        addRules: buildRules({ tabIds: [tabIdNone] })
      });
      return;
    } catch {
      // Fall through to dynamic rules fallback
    }
  }

  if (chrome.declarativeNetRequest.updateDynamicRules) {
    try {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: [TRAKT_DNR_RULE_WEB, TRAKT_DNR_RULE_APP],
        addRules: buildRules({ initiatorDomains: [chrome.runtime.id] })
      });
    } catch {
      // Ignore if DNR API unavailable
    }
  }
}

async function getStoredTraktMeta() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.TRAKT_CAPTURED_AUTH);
  return data[STORAGE_KEYS.TRAKT_CAPTURED_AUTH] || null;
}

async function getCapturedTraktAuth() {
  const auth = await getStoredTraktMeta();
  if (!auth?.accessToken || !auth?.clientId) return null;
  return auth;
}

async function saveCapturedTraktAuth(patch) {
  if (!patch || typeof patch !== 'object') return null;
  const existing = (await getStoredTraktMeta()) || {};
  const merged = {
    accessToken: patch.accessToken || existing.accessToken || null,
    clientId: patch.clientId || existing.clientId || null,
    username: patch.username || existing.username || null,
    slug: patch.slug || existing.slug || null,
    webAuthenticated: Boolean(
      patch.webAuthenticated !== undefined
        ? patch.webAuthenticated
        : existing.webAuthenticated || patch.accessToken || existing.accessToken
    ),
    capturedAt: Date.now()
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.TRAKT_CAPTURED_AUTH]: merged });
  return merged;
}

async function clearCapturedTraktAuth() {
  await chrome.storage.local.remove(STORAGE_KEYS.TRAKT_CAPTURED_AUTH);
}

// Capture Bearer token + public client key when app.trakt.tv / trakt.tv calls api.trakt.tv
function registerTraktWebRequestObserver() {
  if (!chrome.webRequest?.onBeforeSendHeaders) return;
  const listener = (details) => {
    if (details.initiator && details.initiator.startsWith('chrome-extension://')) {
      return;
    }
    const headers = details.requestHeaders || [];
    let authHeader = '';
    let apiKey = '';
    for (const h of headers) {
      const lower = String(h.name || '').toLowerCase();
      if (lower === 'authorization' && h.value) authHeader = h.value;
      if (lower === 'trakt-api-key' && h.value) apiKey = h.value;
    }
    const accessToken = authHeader.toLowerCase().startsWith('bearer ')
      ? authHeader.slice(7).trim()
      : '';
    const clientId = apiKey.trim();
    if (accessToken || clientId) {
      saveCapturedTraktAuth({
        ...(accessToken ? { accessToken, webAuthenticated: true } : {}),
        ...(clientId ? { clientId } : {})
      });
    }
  };

  try {
    chrome.webRequest.onBeforeSendHeaders.addListener(
      listener,
      { urls: ['https://api.trakt.tv/*'] },
      ['requestHeaders', 'extraHeaders']
    );
  } catch {
    try {
      chrome.webRequest.onBeforeSendHeaders.addListener(
        listener,
        { urls: ['https://api.trakt.tv/*'] },
        ['requestHeaders']
      );
    } catch {
      // Ignore if webRequest listener fails
    }
  }
}

registerTraktWebRequestObserver();

async function inspectOpenTraktTabs({ fetchBundleClientId = false } = {}) {
  const tabs = await findOpenTraktTabs();
  let scriptBlocked = false;
  let bestHit = null;

  for (const tab of tabs) {
    if (!tab.id) continue;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        args: [Boolean(fetchBundleClientId)],
        func: async (scanBundles) => {
          const found = {
            accessToken: null,
            clientId: null,
            username: null,
            slug: null,
            authenticated: false
          };

          const absorbText = (text) => {
            if (!text) return;
            const authMatch = text.match(
              /(?:["']isAuthorized["']|\bisAuthorized)\s*:\s*(true|!0|false|!1)\b/
            );
            if (authMatch && (authMatch[1] === 'true' || authMatch[1] === '!0')) {
              found.authenticated = true;
            }
            if (!found.accessToken) {
              const tok =
                text.match(
                  /(?:["'](?:access_token|accessToken)["']|\b(?:access_token|accessToken))\s*:\s*["']([A-Za-z0-9._~+/-]{20,})["']/
                )?.[1] ||
                text.match(
                  /\btoken\s*:\s*\{\s*(?:["']?(?:value|accessToken|access_token)["']?)\s*:\s*["']([A-Za-z0-9._~+/-]{20,})["']/
                )?.[1] ||
                text.match(
                  /(?:["']auth["']|\bauth)\s*:\s*\{[^}]{0,300}?(?:["']token["']|\btoken)\s*:\s*["']([A-Za-z0-9._~+/-]{20,})["']/
                )?.[1];
              if (tok) {
                found.accessToken = tok;
                found.authenticated = true;
              }
            }
            if (!found.clientId) {
              const cid =
                text.match(/[?&]client_id=([a-f0-9]{64})\b/i)?.[1] ||
                text.match(
                  /(?:["']?(?:client_id|clientId|TRAKT_CLIENT_ID|trakt-api-key)["']?)\s*[:=]\s*["']([a-f0-9]{64})["']/i
                )?.[1];
              if (cid) found.clientId = cid;
            }
            if (!found.username) {
              const usr = text.match(
                /(?:["']username["']|\busername)\s*:\s*["']([^"'\s]{1,60})["']/i
              )?.[1];
              if (usr) found.username = usr;
            }
            if (!found.slug) {
              const slg = text.match(
                /(?:["']slug["']|\bslug)\s*:\s*["']([^"'\s]{1,60})["']/i
              )?.[1];
              if (slg) found.slug = slg;
            }
          };

          const scanStorage = (store) => {
            if (!store) return;
            for (let i = 0; i < store.length; i += 1) {
              const k = store.key(i);
              const v = store.getItem(k);
              if (!v) continue;
              try {
                const obj = JSON.parse(v);
                if (obj && typeof obj === 'object') {
                  const tok =
                    obj.access_token ||
                    obj.accessToken ||
                    (typeof obj.token === 'string' ? obj.token : null) ||
                    obj.token?.access_token ||
                    obj.token?.accessToken ||
                    obj.token?.value ||
                    obj.auth?.token;
                  const cid = obj.client_id || obj.clientId;
                  const usr = obj.user?.username || obj.username;
                  const slg = obj.user?.ids?.slug || obj.user?.slug || obj.slug;
                  if (tok && !found.accessToken) {
                    found.accessToken = String(tok);
                    found.authenticated = true;
                  }
                  if (cid && !found.clientId) found.clientId = String(cid);
                  if (usr && !found.username) found.username = String(usr);
                  if (slg && !found.slug) found.slug = String(slg);
                }
              } catch {
                // Not JSON
              }
            }
          };

          scanStorage(window.localStorage);
          scanStorage(window.sessionStorage);

          for (const scriptEl of document.scripts || []) {
            if (scriptEl.textContent) absorbText(scriptEl.textContent);
          }

          // Live DOM identity & auth markers
          const dataUserEl = document.querySelector('[data-username]');
          const dataUser = dataUserEl?.getAttribute('data-username')?.trim();
          if (dataUser && !found.username) found.username = dataUser;

          for (const link of document.querySelectorAll('a[href^="/users/"]')) {
            const href = link.getAttribute('href') || '';
            const m = href.match(/^\/users\/([^/"'?#]+)/i);
            const slug = m?.[1] || '';
            if (slug && !/^(?:me|sign_in|signin|auth|settings)$/i.test(slug)) {
              if (!found.slug) found.slug = slug;
              if (!found.username) found.username = slug;
              found.authenticated = true;
              break;
            }
          }

          const hasSignOut = Boolean(
            document.querySelector('a[href*="/auth/signout"], a[href*="/logout"]')
          );
          const hasSignIn = Boolean(
            document.querySelector(
              '#new_user, a[href*="/auth/signin"], a[href*="/oauth/authorize"]'
            )
          );
          if (hasSignOut) {
            found.authenticated = true;
          } else if (/^(?:app|og)\.trakt\.tv$/i.test(window.location.hostname)) {
            const headerOrNav = document.querySelector('header, nav') || document.body;
            const headerSignIn = headerOrNav?.querySelector(
              'a[href*="/auth/signin"], a[href*="/oauth/authorize"], button[data-signin]'
            );
            const hasAvatarOrProfile = Boolean(
              document.querySelector(
                'a[href="/profile"], a[href^="/users/"], img[alt*="avatar" i], [class*="avatar" i]'
              )
            );
            if (!hasSignIn && !headerSignIn && hasAvatarOrProfile) {
              found.authenticated = true;
            }
          }

          if (
            scanBundles &&
            !found.clientId &&
            /^(?:app|og)\.trakt\.tv$/i.test(window.location.hostname)
          ) {
            try {
              const rootRes = await fetch('/', { credentials: 'include' });
              if (rootRes.ok) {
                absorbText(await rootRes.text());
              }
            } catch {
              // Ignore root SSR fetch error
            }
            if (!found.clientId) {
              const moduleUrls = [];
              for (const el of document.querySelectorAll(
                'link[rel="modulepreload"][href], script[type="module"][src]'
              )) {
                const rawUrl = el.getAttribute('href') || el.getAttribute('src') || '';
                if (!rawUrl || moduleUrls.length >= 4) continue;
                try {
                  const abs = new URL(rawUrl, window.location.origin);
                  if (abs.origin === window.location.origin) {
                    moduleUrls.push(abs.href);
                  }
                } catch {
                  // Ignore malformed URL
                }
              }
              for (const modUrl of moduleUrls) {
                if (found.clientId) break;
                try {
                  const res = await fetch(modUrl, { cache: 'force-cache' });
                  if (res.ok) {
                    absorbText(await res.text());
                  }
                } catch {
                  // Ignore module fetch failure
                }
              }
            }
          }

          return found;
        }
      });

      const hit = results?.[0]?.result;
      if (hit && (hit.accessToken || hit.clientId || hit.authenticated || hit.username)) {
        await saveCapturedTraktAuth({
          ...(hit.accessToken ? { accessToken: hit.accessToken } : {}),
          ...(hit.clientId ? { clientId: hit.clientId } : {}),
          ...(hit.username ? { username: hit.username } : {}),
          ...(hit.slug || hit.username ? { slug: hit.slug || hit.username } : {}),
          webAuthenticated: Boolean(hit.authenticated || hit.accessToken || hit.username)
        });
        bestHit = {
          accessToken: hit.accessToken || bestHit?.accessToken || null,
          clientId: hit.clientId || bestHit?.clientId || null,
          username: hit.username || bestHit?.username || null,
          slug: hit.slug || bestHit?.slug || hit.username || bestHit?.username || null,
          authenticated: Boolean(bestHit?.authenticated || hit.authenticated)
        };
      }
    } catch {
      scriptBlocked = true;
    }
  }

  return {
    hit: bestHit,
    scriptBlocked,
    openTabCount: tabs.length
  };
}

async function waitForCapturedAuth(maxWaitMs = 4500) {
  const steps = Math.ceil(maxWaitMs / 350);
  for (let i = 0; i < steps; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 350));
    const captured = await getCapturedTraktAuth();
    if (captured) return captured;
  }
  await inspectOpenTraktTabs({ fetchBundleClientId: true });
  return await getCapturedTraktAuth();
}

async function probeRootHtmlForTraktAuth(cookies = null) {
  await ensureTraktHeaderRule(cookies);
  try {
    const res = await fetch(`${TRAKT_APP_URL}/`, {
      method: 'GET',
      credentials: 'include'
    });
    if (!res.ok) return null;
    const state = parseTraktHtmlState(await res.text());
    if (state.accessToken || state.clientId || state.svelteAuthorized === true || state.username) {
      await saveCapturedTraktAuth({
        ...(state.accessToken ? { accessToken: state.accessToken } : {}),
        ...(state.clientId ? { clientId: state.clientId } : {}),
        ...(state.username ? { username: state.username } : {}),
        ...(state.slug || state.username ? { slug: state.slug || state.username } : {}),
        webAuthenticated: Boolean(
          state.svelteAuthorized === true || state.accessToken || state.username
        )
      });
    }
    return state;
  } catch {
    return null;
  }
}

async function silentProbeTraktAppForToken(force = false) {
  if (!force) {
    const sessionData = await chrome.storage.session?.get(TRAKT_PROBE_SESSION_KEY);
    const lastProbe = Number(sessionData?.[TRAKT_PROBE_SESSION_KEY] || 0);
    if (Date.now() - lastProbe < 120_000) {
      return null;
    }
  }
  if (chrome.storage.session) {
    await chrome.storage.session.set({ [TRAKT_PROBE_SESSION_KEY]: Date.now() });
  }

  const openTabs = await findOpenTraktTabs();
  const cookies = await getAllTraktCookies(openTabs);
  const cookieInfo = extractTraktAuthFromCookies(cookies);

  const tabInspection = await inspectOpenTraktTabs({ fetchBundleClientId: true });
  const stored = await getStoredTraktMeta();
  const resolvedToken = cookieInfo.accessToken || tabInspection.hit?.accessToken || stored?.accessToken || null;
  const resolvedClientId = cookieInfo.clientId || tabInspection.hit?.clientId || stored?.clientId || null;

  if (resolvedToken || resolvedClientId) {
    await saveCapturedTraktAuth({
      ...(resolvedToken ? { accessToken: resolvedToken } : {}),
      ...(resolvedClientId ? { clientId: resolvedClientId } : {}),
      ...(cookieInfo.username ? { username: cookieInfo.username } : {}),
      ...(cookieInfo.slug ? { slug: cookieInfo.slug } : {})
    });
  }

  const fullCaptured = await getCapturedTraktAuth();
  if (fullCaptured) return fullCaptured;

  // Never reload an already logged-in open tab if we already confirmed signed-in state
  if (tabInspection.hit?.authenticated) {
    return await getStoredTraktMeta();
  }

  if (force || cookieInfo.hasSessionCookie || cookieInfo.hasPossibleSessionCookie) {
    await probeRootHtmlForTraktAuth(cookies);
    const afterHtml = await getCapturedTraktAuth();
    if (afterHtml) return afterHtml;
  }

  const hasAppTab = openTabs.some((t) =>
    /^https:\/\/(?:app|og)\.trakt\.tv(?:\/|$)/i.test(String(t?.url || ''))
  );
  if (hasAppTab) {
    return await getStoredTraktMeta();
  }

  if (!cookieInfo.hasSessionCookie && !cookieInfo.hasPossibleSessionCookie && !force) {
    return null;
  }

  // Only open root https://app.trakt.tv/ silently when no app tab is open (never /watchlist)
  let tempTab = null;
  try {
    tempTab = await chrome.tabs.create({
      url: `${TRAKT_APP_URL}/`,
      active: false
    });
    return await waitForCapturedAuth(4500);
  } catch {
    return null;
  } finally {
    if (tempTab?.id) {
      try {
        await chrome.tabs.remove(tempTab.id);
      } catch {
        // Already closed
      }
    }
  }
}

async function getSettings() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  const stored = data[STORAGE_KEYS.SETTINGS] || {};
  const merged = { ...DEFAULT_SETTINGS, ...stored };

  if (merged.syncTarget === SYNC_TARGETS.TRAKT && !String(merged.traktClientId || '').trim()) {
    merged.syncTarget = SYNC_TARGETS.TRAKT_WEB;
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: merged });
  }

  return merged;
}

async function getNuvioSession() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.SESSION);
  return data[STORAGE_KEYS.SESSION] || null;
}

async function saveNuvioSession(session) {
  await chrome.storage.local.set({ [STORAGE_KEYS.SESSION]: session });
}

async function getTraktSession() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.TRAKT_SESSION);
  return data[STORAGE_KEYS.TRAKT_SESSION] || null;
}

async function saveTraktSession(session) {
  await chrome.storage.local.set({ [STORAGE_KEYS.TRAKT_SESSION]: session });
}

async function getTraktPendingAuth() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.TRAKT_PENDING_AUTH);
  return data[STORAGE_KEYS.TRAKT_PENDING_AUTH] || null;
}

async function clearTraktPendingAuth() {
  await chrome.storage.local.remove(STORAGE_KEYS.TRAKT_PENDING_AUTH);
  await chrome.alarms.clear(TRAKT_POLL_ALARM);
}

async function getSelectedProfileId() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.SELECTED_PROFILE_ID);
  const val = Number(data[STORAGE_KEYS.SELECTED_PROFILE_ID]);
  return Number.isInteger(val) && val >= 1 ? val : 1;
}

async function getOrCreateOriginClientId() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.ORIGIN_CLIENT_ID);
  if (data[STORAGE_KEYS.ORIGIN_CLIENT_ID]) {
    return data[STORAGE_KEYS.ORIGIN_CLIENT_ID];
  }
  const clientId = `nuvio-ext-${crypto.randomUUID()}`;
  await chrome.storage.local.set({ [STORAGE_KEYS.ORIGIN_CLIENT_ID]: clientId });
  return clientId;
}

async function getNuvioLibraryCacheMap() {
  const data = await chrome.storage.local.get(STORAGE_KEYS.LIBRARY_CACHE);
  return data[STORAGE_KEYS.LIBRARY_CACHE] || {};
}

async function refreshNuvioLibraryCache(profileId, force = false) {
  const cache = await getNuvioLibraryCacheMap();
  const entry = cache[String(profileId)];
  const now = Date.now();

  if (!force && entry && now - entry.fetchedAt < 60_000) {
    return entry.items || [];
  }

  const settings = await getSettings();
  const session = await getNuvioSession();
  if (!session?.access_token) {
    return [];
  }

  const items = await pullLibrary({
    baseUrl: settings.baseUrl,
    publishableKey: settings.publishableKey,
    session,
    profileId,
    onSessionRefreshed: saveNuvioSession
  });

  cache[String(profileId)] = { fetchedAt: now, items };
  await chrome.storage.local.set({ [STORAGE_KEYS.LIBRARY_CACHE]: cache });
  return items;
}

async function refreshTraktApiWatchlistCache(force = false) {
  const data = await chrome.storage.local.get(STORAGE_KEYS.TRAKT_WATCHLIST_CACHE);
  const cached = data[STORAGE_KEYS.TRAKT_WATCHLIST_CACHE];
  const now = Date.now();

  if (!force && cached && now - cached.fetchedAt < 45_000) {
    return cached.items || [];
  }

  const settings = await getSettings();
  const traktSession = await getTraktSession();
  if (!traktSession?.access_token || !settings.traktClientId) {
    return [];
  }

  const items = await pullTraktWatchlist({
    clientId: settings.traktClientId,
    clientSecret: settings.traktClientSecret,
    session: traktSession,
    onSessionRefreshed: saveTraktSession
  });

  await chrome.storage.local.set({
    [STORAGE_KEYS.TRAKT_WATCHLIST_CACHE]: { fetchedAt: now, items }
  });
  return items;
}

async function refreshTraktWebWatchlistCache(force = false, knownSlug = '') {
  const data = await chrome.storage.local.get(STORAGE_KEYS.TRAKT_WEB_CACHE);
  const cached = data[STORAGE_KEYS.TRAKT_WEB_CACHE];
  const now = Date.now();

  if (!force && cached && now - cached.fetchedAt < 45_000) {
    return cached.items || [];
  }

  const captured = await getCapturedTraktAuth();
  if (captured?.accessToken && captured?.clientId) {
    try {
      const items = await pullTraktWatchlist({
        clientId: captured.clientId,
        session: {
          access_token: captured.accessToken,
          refresh_token: '',
          expires_at: Math.floor(Date.now() / 1000) + 3600
        }
      });
      await chrome.storage.local.set({
        [STORAGE_KEYS.TRAKT_WEB_CACHE]: {
          fetchedAt: now,
          slug: knownSlug || cached?.slug || '',
          items
        }
      });
      return items;
    } catch {
      await clearCapturedTraktAuth();
    }
  }

  const openTabs = await findOpenTraktTabs();
  const cookies = await getAllTraktCookies(openTabs);
  await ensureTraktHeaderRule(cookies);
  let slug = knownSlug || cached?.slug || '';
  if (!slug) {
    const webStatus = await checkTraktWebSession(globalThis.fetch, { cookies });
    if (!webStatus.authenticated) return [];
    slug = webStatus.slug || webStatus.username;
  }

  if (!slug || slug === 'Trakt User') {
    return cached?.items || [];
  }

  const items = await pullTraktWebWatchlist(slug);
  await chrome.storage.local.set({
    [STORAGE_KEYS.TRAKT_WEB_CACHE]: { fetchedAt: now, slug, items }
  });
  return items;
}

function findMatchingItem(items, candidate) {
  if (!Array.isArray(items) || !candidate) return null;
  const imdbId = candidate.imdbId ? String(candidate.imdbId).toLowerCase() : null;
  const tmdbRaw = candidate.tmdbId ? String(candidate.tmdbId) : null;
  const tmdbKey = tmdbRaw ? `tmdb:${tmdbRaw}`.toLowerCase() : null;
  const directContentId = candidate.content_id
    ? String(candidate.content_id).toLowerCase()
    : null;
  const candTitle = normalizeTitleKey(candidate.name || candidate.title);
  const candYear = String(candidate.releaseInfo || candidate.year || '').slice(0, 4);
  const candType = candidate.type === 'series' ? 'series' : 'movie';

  return (
    items.find((entry) => {
      const id = String(entry.content_id || '').toLowerCase();
      const entryImdb = entry.imdbId ? String(entry.imdbId).toLowerCase() : null;
      const entryTmdb = entry.tmdbId ? String(entry.tmdbId) : null;

      if (
        (directContentId && id === directContentId) ||
        (imdbId && (id === imdbId || entryImdb === imdbId)) ||
        (tmdbKey && id === tmdbKey) ||
        (tmdbRaw && entryTmdb === tmdbRaw)
      ) {
        return true;
      }

      if (candTitle) {
        const entryTitle = normalizeTitleKey(entry.name || entry.title);
        const entryType = entry.content_type === 'series' ? 'series' : 'movie';
        const entryYear = String(entry.year || entry.release_info || '').slice(0, 4);
        if (
          entryTitle === candTitle &&
          entryType === candType &&
          (!candYear || !entryYear || entryYear === candYear)
        ) {
          return true;
        }
      }

      return false;
    }) || null
  );
}

async function getActiveCollectionItems(force = false) {
  const settings = await getSettings();
  const target = settings.syncTarget || SYNC_TARGETS.TRAKT_WEB;

  if (target === SYNC_TARGETS.TRAKT_WEB) {
    return refreshTraktWebWatchlistCache(force);
  }
  if (target === SYNC_TARGETS.TRAKT) {
    return refreshTraktApiWatchlistCache(force);
  }
  if (target === SYNC_TARGETS.NUVIO) {
    const profileId = await getSelectedProfileId();
    return refreshNuvioLibraryCache(profileId, force);
  }

  const traktItems = settings.traktClientId
    ? await refreshTraktApiWatchlistCache(force)
    : await refreshTraktWebWatchlistCache(force);
  if (traktItems.length > 0) return traktItems;
  const profileId = await getSelectedProfileId();
  return refreshNuvioLibraryCache(profileId, force);
}

async function flashBadge(text, color) {
  await chrome.action.setBadgeText({ text });
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.alarms.create(BADGE_CLEAR_ALARM, { delayInMinutes: 0.5 });
}

async function notifyTabToast(tabId, payload) {
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: MESSAGE_TYPES.SHOW_TOAST,
      payload
    });
  } catch {
    // Restricted browser pages do not allow content scripts
  }
}

async function notifyTabRefresh(tabId) {
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: MESSAGE_TYPES.REFRESH_PAGE_STATUS
    });
  } catch {
    // Ignore tabs without active content script
  }
}

async function notifyAllTabsRefresh() {
  try {
    const tabs = await chrome.tabs.query({});
    for (const tab of tabs) {
      if (tab.id) {
        await notifyTabRefresh(tab.id);
      }
    }
  } catch {
    // Ignore query failures
  }
}

async function pollPendingTraktAuthOnce() {
  const pending = await getTraktPendingAuth();
  if (!pending) return { status: 'none' };

  if (Date.now() >= pending.expiresAt) {
    await clearTraktPendingAuth();
    return { status: 'expired' };
  }

  const settings = await getSettings();
  const clientId = pending.clientId || settings.traktClientId;
  const clientSecret = pending.clientSecret ?? settings.traktClientSecret;

  const result = await pollTraktDeviceToken({
    clientId,
    clientSecret,
    deviceCode: pending.deviceCode
  });

  if (result.status === 'authorized') {
    const user = await fetchTraktUserSettings({
      clientId,
      clientSecret,
      session: result.session,
      onSessionRefreshed: saveTraktSession
    });
    const fullSession = { ...result.session, user };
    await saveTraktSession(fullSession);
    await clearTraktPendingAuth();
    await refreshTraktApiWatchlistCache(true);
    await flashBadge('✓', '#16a34a');
    await notifyAllTabsRefresh();
    return { status: 'authorized', session: fullSession, user };
  }

  if (
    result.status === 'expired' ||
    result.status === 'denied' ||
    result.status === 'already_used' ||
    result.status === 'not_found'
  ) {
    await clearTraktPendingAuth();
  }

  return result;
}

async function getActiveTraktClientId(settings) {
  if (settings?.traktClientId) return settings.traktClientId;
  const captured = await getCapturedTraktAuth();
  return captured?.clientId || '';
}

async function ensureResolvedMedia(mediaInput, settings) {
  if (
    (mediaInput?.imdbId || mediaInput?.tmdbId || mediaInput?.traktId) &&
    (mediaInput?.name || mediaInput?.title)
  ) {
    return {
      ...mediaInput,
      name: mediaInput.name || mediaInput.title
    };
  }
  const traktClientId = await getActiveTraktClientId(settings);
  const resolved = await resolveMediaMetadata(mediaInput || {}, {
    tmdbApiKey: settings.tmdbApiKey,
    traktClientId
  });
  if (!resolved || (!resolved.imdbId && !resolved.tmdbId && !resolved.traktId && !resolved.name)) {
    throw new Error('Could not identify this movie or series.');
  }
  return resolved;
}

async function pushToNuvioInternal(resolved, settings) {
  const session = await getNuvioSession();
  if (!session?.access_token) {
    throw new Error('Please sign in to Nuvio from the extension popup first.');
  }
  const profileId = await getSelectedProfileId();
  const originClientId = await getOrCreateOriginClientId();
  const libraryItem = toNuvioLibraryItem(
    resolved,
    settings.preferredIdFormat,
    Date.now()
  );

  await pushLibraryItems({
    baseUrl: settings.baseUrl,
    publishableKey: settings.publishableKey,
    session,
    profileId,
    originClientId,
    items: [libraryItem],
    onSessionRefreshed: saveNuvioSession
  });

  const cache = await getNuvioLibraryCacheMap();
  const key = String(profileId);
  const existing = cache[key]?.items || [];
  const filtered = existing.filter(
    (entry) =>
      String(entry.content_id).toLowerCase() !==
      String(libraryItem.content_id).toLowerCase()
  );
  cache[key] = {
    fetchedAt: Date.now(),
    items: [libraryItem, ...filtered]
  };
  await chrome.storage.local.set({ [STORAGE_KEYS.LIBRARY_CACHE]: cache });
  return libraryItem;
}

async function pushToTraktApiInternal(resolved, settings) {
  const traktSession = await getTraktSession();
  if (!traktSession?.access_token || !settings.traktClientId) {
    throw new Error('Please connect your Trakt API app in the extension popup.');
  }

  await addToTraktWatchlist({
    clientId: settings.traktClientId,
    clientSecret: settings.traktClientSecret,
    session: traktSession,
    media: resolved,
    onSessionRefreshed: saveTraktSession
  });

  const data = await chrome.storage.local.get(STORAGE_KEYS.TRAKT_WATCHLIST_CACHE);
  const existing = data[STORAGE_KEYS.TRAKT_WATCHLIST_CACHE]?.items || [];
  const nextEntry = {
    content_id: resolved.imdbId || `tmdb:${resolved.tmdbId}`,
    content_type: resolved.type === 'series' ? 'series' : 'movie',
    imdbId: resolved.imdbId || null,
    tmdbId: resolved.tmdbId ? String(resolved.tmdbId) : null,
    name: resolved.name || '',
    year: resolved.releaseInfo ? String(resolved.releaseInfo) : '',
    listed_at: new Date().toISOString()
  };

  const filtered = existing.filter((item) => !findMatchingItem([item], resolved));

  await chrome.storage.local.set({
    [STORAGE_KEYS.TRAKT_WATCHLIST_CACHE]: {
      fetchedAt: Date.now(),
      items: [nextEntry, ...filtered]
    }
  });

  return nextEntry;
}

async function ensureCapturedAuthForWebWrite() {
  let captured = await getCapturedTraktAuth();
  if (captured) return captured;

  const openTabs = await findOpenTraktTabs();
  const cookies = await getAllTraktCookies(openTabs);
  const cookieInfo = extractTraktAuthFromCookies(cookies);
  const tabInspection = await inspectOpenTraktTabs({ fetchBundleClientId: true });
  const stored = await getStoredTraktMeta();

  const accessToken =
    cookieInfo.accessToken || tabInspection.hit?.accessToken || stored?.accessToken || null;
  const clientId =
    cookieInfo.clientId || tabInspection.hit?.clientId || stored?.clientId || null;

  if (accessToken || clientId) {
    await saveCapturedTraktAuth({
      ...(accessToken ? { accessToken, webAuthenticated: true } : {}),
      ...(clientId ? { clientId } : {})
    });
  }

  captured = await getCapturedTraktAuth();
  if (captured) return captured;

  if (
    cookieInfo.hasSessionCookie ||
    cookieInfo.hasPossibleSessionCookie ||
    tabInspection.hit?.authenticated
  ) {
    await silentProbeTraktAppForToken(false);
    return await getCapturedTraktAuth();
  }
  return null;
}

async function executeInClassicTraktTab(action, media) {
  const tabs = await findOpenTraktTabs();
  const classicTab = tabs.find((t) =>
    /^https:\/\/trakt\.tv(?:\/|$)/i.test(String(t?.url || ''))
  );
  if (!classicTab?.id) {
    throw new Error('Could not complete Trakt Watchlist request. Please make sure trakt.tv is signed in.');
  }

  const title = media?.name || media?.title || '';
  const year = String(media?.releaseInfo || media?.year || '').slice(0, 4);
  const isSeries = media?.type === 'series' || media?.contentType === 'series' || media?.contentType === 'show';
  const imdbId = media?.imdbId || '';

  const results = await chrome.scripting.executeScript({
    target: { tabId: classicTab.id },
    args: [{ action, title, year, isSeries, imdbId }],
    func: async ({ action: op, title: qTitle, year: qYear, isSeries: isShow, imdbId: qImdb }) => {
      const bucket = isShow ? 'shows' : 'movies';
      let itemPath = null;
      let traktId = null;

      const parseFirstMatch = (html) => {
        const blocks =
          String(html || '').match(
            /<div\b[^>]*class=["'][^"']*\bgrid-item\b[^"']*["'][^>]*>[\s\S]*?(?=<div\b[^>]*class=["'][^"']*\bgrid-item\b|<\/body>|$)/gi
          ) || [];
        let fallback = null;
        for (const block of blocks) {
          const url =
            block.match(/data-url=["'](\/(?:movies|shows)\/[^"']+)["']/i)?.[1] ||
            block.match(/href=["'](\/(?:movies|shows)\/[^"'?#]+)["']/i)?.[1];
          if (!url) continue;
          const id = block.match(/data-(?:movie|show)-id=["'](\d+)["']/i)?.[1] || null;
          if (!fallback) fallback = { url, id };
          if (qYear && block.includes(`>${qYear}<`)) {
            return { url, id };
          }
        }
        return fallback;
      };

      if (qTitle) {
        const res = await fetch(`/search/${bucket}?query=${encodeURIComponent(qTitle)}`, {
          credentials: 'include'
        });
        if (res.ok) {
          const hit = parseFirstMatch(await res.text());
          if (hit) {
            itemPath = hit.url;
            traktId = hit.id;
          }
        }
      }
      if (!itemPath && qImdb) {
        const res = await fetch(`/search?query=${encodeURIComponent(qImdb)}`, {
          credentials: 'include'
        });
        if (res.ok) {
          const hit = parseFirstMatch(await res.text());
          if (hit) {
            itemPath = hit.url;
            traktId = hit.id;
          }
        }
      }
      if (!itemPath) {
        return { ok: false, error: 'Could not find this title on Trakt.tv.' };
      }

      const detailRes = await fetch(itemPath, { credentials: 'include' });
      if (!detailRes.ok) {
        return { ok: false, error: `Could not load Trakt page (${detailRes.status}).` };
      }
      const detailHtml = await detailRes.text();
      const csrf =
        detailHtml.match(/<meta[^>]*name=["']csrf-token["'][^>]*content=["']([^"']+)["']/i)?.[1] ||
        detailHtml.match(/<meta[^>]*content=["']([^"']+)["'][^>]*name=["']csrf-token["']/i)?.[1] ||
        null;
      if (!csrf) {
        return { ok: false, error: 'Please sign in to trakt.tv in your browser first.' };
      }
      const inWatchlist =
        /<(?:a|button)\b[^>]*class=["'][^"']*\baction-watchlist\b[^"']*\b(?:selected|in-watchlist|active)\b/i.test(
          detailHtml
        );

      if ((op === 'add' && inWatchlist) || (op === 'remove' && !inWatchlist)) {
        return { ok: true, itemPath, traktId };
      }

      const postRes = await fetch(`${itemPath}/watchlist`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest',
          'X-CSRF-Token': csrf
        },
        body: ''
      });
      if (!postRes.ok) {
        return { ok: false, error: `Trakt web request failed (HTTP ${postRes.status}).` };
      }
      return { ok: true, itemPath, traktId };
    }
  });

  const result = results?.[0]?.result;
  if (!result?.ok) {
    throw new Error(result?.error || 'Could not update Trakt Watchlist.');
  }
  return result;
}

async function runClassicWebWatchlistFallback(action, payload) {
  const cookies = await getAllTraktCookies(await findOpenTraktTabs());
  await ensureTraktHeaderRule(cookies);
  try {
    return action === 'remove'
      ? await removeViaTraktWebSession(payload)
      : await addViaTraktWebSession(payload);
  } catch (err) {
    if (/sign in|csrf|401|403/i.test(String(err?.message || ''))) {
      const tabResult = await executeInClassicTraktTab(action, payload);
      return {
        ok: true,
        item: {
          itemPath: tabResult.itemPath,
          traktId: tabResult.traktId,
          title: payload.name || payload.title || '',
          year: payload.releaseInfo || payload.year || ''
        }
      };
    }
    throw err;
  }
}

async function pushToTraktWebInternal(resolved) {
  const captured = await ensureCapturedAuthForWebWrite();
  if (captured?.accessToken && captured?.clientId) {
    try {
      await addToTraktWatchlist({
        clientId: captured.clientId,
        session: {
          access_token: captured.accessToken,
          refresh_token: '',
          expires_at: Math.floor(Date.now() / 1000) + 3600
        },
        media: resolved
      });

      const data = await chrome.storage.local.get(STORAGE_KEYS.TRAKT_WEB_CACHE);
      const cacheObj = data[STORAGE_KEYS.TRAKT_WEB_CACHE] || { slug: '', items: [] };
      const nextEntry = {
        content_id: resolved.imdbId || `tmdb:${resolved.tmdbId}`,
        content_type: resolved.type === 'series' ? 'series' : 'movie',
        imdbId: resolved.imdbId || null,
        tmdbId: resolved.tmdbId ? String(resolved.tmdbId) : null,
        name: resolved.name || '',
        year: String(resolved.releaseInfo || '')
      };
      const filtered = (cacheObj.items || []).filter(
        (entry) => !findMatchingItem([entry], resolved)
      );
      await chrome.storage.local.set({
        [STORAGE_KEYS.TRAKT_WEB_CACHE]: {
          fetchedAt: Date.now(),
          slug: cacheObj.slug || '',
          items: [nextEntry, ...filtered]
        }
      });
      return nextEntry;
    } catch (err) {
      if (/401|unauthorized|expired/i.test(String(err?.message || ''))) {
        await clearCapturedTraktAuth();
      } else {
        throw err;
      }
    }
  }

  const res = await runClassicWebWatchlistFallback('add', resolved);

  const data = await chrome.storage.local.get(STORAGE_KEYS.TRAKT_WEB_CACHE);
  const cacheObj = data[STORAGE_KEYS.TRAKT_WEB_CACHE] || { slug: '', items: [] };
  const nextEntry = {
    content_id: resolved.imdbId || `trakt:${res.item.traktId || res.item.itemPath}`,
    content_type: resolved.type === 'series' ? 'series' : 'movie',
    imdbId: resolved.imdbId || null,
    tmdbId: resolved.tmdbId ? String(resolved.tmdbId) : null,
    traktId: res.item.traktId || null,
    itemPath: res.item.itemPath,
    name: resolved.name || res.item.title || '',
    year: String(resolved.releaseInfo || res.item.year || '')
  };

  const filtered = (cacheObj.items || []).filter(
    (entry) => !findMatchingItem([entry], resolved)
  );
  await chrome.storage.local.set({
    [STORAGE_KEYS.TRAKT_WEB_CACHE]: {
      fetchedAt: Date.now(),
      slug: cacheObj.slug || '',
      items: [nextEntry, ...filtered]
    }
  });

  return nextEntry;
}

async function handleAddMedia(mediaInput) {
  const settings = await getSettings();
  const target = settings.syncTarget || SYNC_TARGETS.TRAKT_WEB;
  const resolved = await ensureResolvedMedia(mediaInput, settings);

  let item = null;
  if (target === SYNC_TARGETS.TRAKT_WEB) {
    item = await pushToTraktWebInternal(resolved);
  } else if (target === SYNC_TARGETS.TRAKT) {
    item = await pushToTraktApiInternal(resolved, settings);
  } else if (target === SYNC_TARGETS.NUVIO) {
    item = await pushToNuvioInternal(resolved, settings);
  } else if (target === SYNC_TARGETS.BOTH) {
    item = settings.traktClientId
      ? await pushToTraktApiInternal(resolved, settings)
      : await pushToTraktWebInternal(resolved);
    await pushToNuvioInternal(resolved, settings);
  }

  return { resolved, item, syncTarget: target };
}

async function removeFromNuvioInternal(payload, settings) {
  const session = await getNuvioSession();
  if (!session?.access_token) throw new Error('Not signed in to Nuvio.');

  const profileId = await getSelectedProfileId();
  const originClientId = await getOrCreateOriginClientId();
  const contentId =
    payload.contentId ||
    payload.imdbId ||
    (payload.tmdbId ? `tmdb:${payload.tmdbId}` : null);

  await deleteLibraryItems({
    baseUrl: settings.baseUrl,
    publishableKey: settings.publishableKey,
    session,
    profileId,
    originClientId,
    items: [
      {
        content_id: contentId,
        content_type: payload.contentType || payload.type || 'movie'
      }
    ],
    onSessionRefreshed: saveNuvioSession
  });

  const cache = await getNuvioLibraryCacheMap();
  const key = String(profileId);
  if (cache[key]?.items) {
    cache[key].items = cache[key].items.filter(
      (entry) =>
        String(entry.content_id).toLowerCase() !== String(contentId).toLowerCase()
    );
    await chrome.storage.local.set({ [STORAGE_KEYS.LIBRARY_CACHE]: cache });
  }
}

async function removeFromTraktApiInternal(payload, settings) {
  const traktSession = await getTraktSession();
  if (!traktSession?.access_token || !settings.traktClientId) {
    throw new Error('Not connected to Trakt.');
  }

  await removeFromTraktWatchlist({
    clientId: settings.traktClientId,
    clientSecret: settings.traktClientSecret,
    session: traktSession,
    media: payload,
    onSessionRefreshed: saveTraktSession
  });

  const data = await chrome.storage.local.get(STORAGE_KEYS.TRAKT_WATCHLIST_CACHE);
  const existing = data[STORAGE_KEYS.TRAKT_WATCHLIST_CACHE]?.items || [];
  await chrome.storage.local.set({
    [STORAGE_KEYS.TRAKT_WATCHLIST_CACHE]: {
      fetchedAt: Date.now(),
      items: existing.filter((entry) => !findMatchingItem([entry], payload))
    }
  });
}

async function removeFromTraktWebInternal(payload) {
  const captured = await ensureCapturedAuthForWebWrite();
  if (captured?.accessToken && captured?.clientId) {
    try {
      await removeFromTraktWatchlist({
        clientId: captured.clientId,
        session: {
          access_token: captured.accessToken,
          refresh_token: '',
          expires_at: Math.floor(Date.now() / 1000) + 3600
        },
        media: payload
      });
    } catch (err) {
      if (/401|unauthorized|expired/i.test(String(err?.message || ''))) {
        await clearCapturedTraktAuth();
        await runClassicWebWatchlistFallback('remove', payload);
      } else {
        throw err;
      }
    }
  } else {
    await runClassicWebWatchlistFallback('remove', payload);
  }

  const data = await chrome.storage.local.get(STORAGE_KEYS.TRAKT_WEB_CACHE);
  const cacheObj = data[STORAGE_KEYS.TRAKT_WEB_CACHE] || { slug: '', items: [] };
  await chrome.storage.local.set({
    [STORAGE_KEYS.TRAKT_WEB_CACHE]: {
      fetchedAt: Date.now(),
      slug: cacheObj.slug || '',
      items: (cacheObj.items || []).filter(
        (entry) => !findMatchingItem([entry], payload)
      )
    }
  });
}

async function handleRemoveMedia(payload) {
  const settings = await getSettings();
  const target = settings.syncTarget || SYNC_TARGETS.TRAKT_WEB;

  if (target === SYNC_TARGETS.TRAKT_WEB) {
    await removeFromTraktWebInternal(payload);
  } else if (target === SYNC_TARGETS.TRAKT) {
    await removeFromTraktApiInternal(payload, settings);
  } else if (target === SYNC_TARGETS.NUVIO) {
    await removeFromNuvioInternal(payload, settings);
  } else if (target === SYNC_TARGETS.BOTH) {
    if (settings.traktClientId) {
      await removeFromTraktApiInternal(payload, settings);
    } else {
      await removeFromTraktWebInternal(payload);
    }
    await removeFromNuvioInternal(payload, settings);
  }
  return { ok: true };
}

function getTargetLabel(syncTarget) {
  if (syncTarget === SYNC_TARGETS.NUVIO) return 'Nuvio';
  if (syncTarget === SYNC_TARGETS.BOTH) return 'Trakt & Nuvio';
  return 'Trakt Watchlist';
}

async function setupContextMenus(syncTarget = SYNC_TARGETS.TRAKT_WEB) {
  const label = getTargetLabel(syncTarget);
  await chrome.contextMenus.removeAll();
  chrome.contextMenus.create({
    id: MENU_ADD_SELECTION,
    title: `Add "%s" to ${label}`,
    contexts: ['selection']
  });
  chrome.contextMenus.create({
    id: MENU_ADD_PAGE,
    title: `Add detected movie to ${label}`,
    contexts: ['page']
  });
}

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    const existing = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
    if (!existing[STORAGE_KEYS.SETTINGS]) {
      await chrome.storage.local.set({
        [STORAGE_KEYS.SETTINGS]: DEFAULT_SETTINGS
      });
    }
    await getOrCreateOriginClientId();
  }
  await ensureTraktHeaderRule();
  const settings = await getSettings();
  await setupContextMenus(settings.syncTarget);
});

chrome.runtime.onStartup.addListener(async () => {
  await ensureTraktHeaderRule();
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === BADGE_CLEAR_ALARM) {
    await chrome.action.setBadgeText({ text: '' });
    return;
  }
  if (alarm.name === TRAKT_POLL_ALARM) {
    try {
      await pollPendingTraktAuthOnce();
    } catch {
      // Ignore transient network failures while polling in background
    }
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_ADD_SELECTION && info.menuItemId !== MENU_ADD_PAGE) {
    return;
  }

  try {
    let extraction = null;
    if (info.menuItemId === MENU_ADD_SELECTION && info.selectionText) {
      extraction = { title: info.selectionText, type: 'movie' };
    } else if (tab?.id) {
      try {
        extraction = await chrome.tabs.sendMessage(tab.id, {
          type: MESSAGE_TYPES.EXTRACT_PAGE_MEDIA
        });
      } catch {
        extraction = { title: tab.title || '', url: tab.url || '', type: 'movie' };
      }
    }

    if (!extraction) {
      throw new Error('Could not detect a movie title on this page.');
    }

    const { resolved, syncTarget } = await handleAddMedia(extraction);
    await flashBadge('✓', '#16a34a');
    await notifyTabToast(tab?.id, {
      status: 'success',
      title: `Added to ${getTargetLabel(syncTarget)}`,
      message: resolved.releaseInfo
        ? `${resolved.name} (${resolved.releaseInfo})`
        : resolved.name,
      poster: resolved.poster || ''
    });
    await notifyTabRefresh(tab?.id);
  } catch (err) {
    await flashBadge('!', '#dc2626');
    await notifyTabToast(tab?.id, {
      status: 'error',
      title: 'Nuvio Quick Add',
      message: err?.message || 'Failed to add item.'
    });
  }
});

async function buildAuthStatus() {
  const settings = await getSettings();
  const syncTarget = settings.syncTarget || SYNC_TARGETS.TRAKT_WEB;

  // Trakt Web Session status (supports V3 app.trakt.tv + classic trakt.tv)
  let traktWebAuthenticated = false;
  let traktWebUser = null;
  let diagnosticHint = null;

  if (
    syncTarget === SYNC_TARGETS.TRAKT_WEB ||
    (syncTarget === SYNC_TARGETS.BOTH && !settings.traktClientId)
  ) {
    const openTabs = await findOpenTraktTabs();
    const cookies = await getAllTraktCookies(openTabs);
    const cookieInfo = extractTraktAuthFromCookies(cookies);
    const tabInspection = await inspectOpenTraktTabs();
    const stored = await getStoredTraktMeta();

    const combinedToken =
      cookieInfo.accessToken || tabInspection.hit?.accessToken || stored?.accessToken || null;
    const combinedClientId =
      cookieInfo.clientId || tabInspection.hit?.clientId || stored?.clientId || null;

    if (combinedToken || combinedClientId) {
      await saveCapturedTraktAuth({
        ...(combinedToken ? { accessToken: combinedToken, webAuthenticated: true } : {}),
        ...(combinedClientId ? { clientId: combinedClientId } : {}),
        ...(cookieInfo.username ? { username: cookieInfo.username } : {}),
        ...(cookieInfo.slug ? { slug: cookieInfo.slug } : {})
      });
    }

    let captured = await getCapturedTraktAuth();
    if (captured?.accessToken && captured?.clientId) {
      try {
        const user = await fetchTraktUserSettings({
          clientId: captured.clientId,
          session: {
            access_token: captured.accessToken,
            refresh_token: '',
            expires_at: Math.floor(Date.now() / 1000) + 3600
          }
        });
        traktWebAuthenticated = true;
        traktWebUser = user;
        await refreshTraktWebWatchlistCache(false, user.slug);
      } catch {
        await clearCapturedTraktAuth();
        captured = null;
      }
    }

    if (!traktWebAuthenticated) {
      await ensureTraktHeaderRule(cookies);
      let webStatus = { authenticated: false };
      try {
        webStatus = await checkTraktWebSession(globalThis.fetch, { cookies });
      } catch {
        webStatus = { authenticated: false };
      }

      if (webStatus.clientId || webStatus.accessToken || webStatus.username) {
        await saveCapturedTraktAuth({
          ...(webStatus.accessToken ? { accessToken: webStatus.accessToken } : {}),
          ...(webStatus.clientId ? { clientId: webStatus.clientId } : {}),
          ...(webStatus.username ? { username: webStatus.username } : {}),
          ...(webStatus.slug ? { slug: webStatus.slug } : {}),
          webAuthenticated: Boolean(webStatus.authenticated)
        });
      }

      if (webStatus.authenticated) {
        traktWebAuthenticated = true;
        traktWebUser = {
          username: webStatus.username || cookieInfo.username || 'Trakt User',
          slug: webStatus.slug || cookieInfo.slug || ''
        };
      } else if (tabInspection.hit?.authenticated) {
        traktWebAuthenticated = true;
        traktWebUser = {
          username: tabInspection.hit.username || cookieInfo.username || 'Trakt User',
          slug: tabInspection.hit.slug || cookieInfo.slug || ''
        };
      }

      if (
        !captured &&
        (traktWebAuthenticated || cookieInfo.hasSessionCookie || cookieInfo.hasPossibleSessionCookie)
      ) {
        const probed = await silentProbeTraktAppForToken(false);
        if (probed?.accessToken && probed?.clientId) {
          try {
            const user = await fetchTraktUserSettings({
              clientId: probed.clientId,
              session: {
                access_token: probed.accessToken,
                refresh_token: '',
                expires_at: Math.floor(Date.now() / 1000) + 3600
              }
            });
            traktWebAuthenticated = true;
            traktWebUser = user;
          } catch {
            // Keep confirmed web status
          }
        }
      }

      if (traktWebAuthenticated) {
        await refreshTraktWebWatchlistCache(false, traktWebUser?.slug || '');
      } else if (tabInspection.openTabCount > 0 && cookies.length === 0 && tabInspection.scriptBlocked) {
        diagnosticHint =
          'Allow site access for trakt.tv in Extension Details (opera://extensions), then click I Signed In.';
      }
    }
  }

  // Trakt API OAuth status
  let traktAuthenticated = false;
  let traktUser = null;
  const traktSession = await getTraktSession();
  if (traktSession?.access_token && settings.traktClientId) {
    try {
      const valid = await ensureValidTraktSession({
        clientId: settings.traktClientId,
        clientSecret: settings.traktClientSecret,
        session: traktSession
      });
      if (valid !== traktSession) {
        await saveTraktSession(valid);
      }
      traktAuthenticated = true;
      traktUser = valid.user || null;
    } catch {
      traktAuthenticated = false;
    }
  }

  let traktPendingAuth = await getTraktPendingAuth();
  if (traktPendingAuth && Date.now() >= traktPendingAuth.expiresAt) {
    await clearTraktPendingAuth();
    traktPendingAuth = null;
  }

  // Nuvio status
  let nuvioAuthenticated = false;
  let nuvioUser = null;
  const nuvioSession = await getNuvioSession();
  if (nuvioSession?.access_token) {
    try {
      const validNuvio = await ensureValidSession({
        baseUrl: settings.baseUrl,
        publishableKey: settings.publishableKey,
        session: nuvioSession
      });
      if (validNuvio !== nuvioSession) {
        await saveNuvioSession(validNuvio);
      }
      nuvioAuthenticated = true;
      nuvioUser = validNuvio.user || null;
    } catch {
      nuvioAuthenticated = false;
    }
  }

  const data = await chrome.storage.local.get([
    STORAGE_KEYS.PROFILES_CACHE,
    STORAGE_KEYS.SELECTED_PROFILE_ID
  ]);

  const traktConnected =
    syncTarget === SYNC_TARGETS.TRAKT ? traktAuthenticated : traktWebAuthenticated;

  const ready =
    syncTarget === SYNC_TARGETS.TRAKT_WEB
      ? traktWebAuthenticated
      : syncTarget === SYNC_TARGETS.TRAKT
        ? traktAuthenticated
        : syncTarget === SYNC_TARGETS.NUVIO
          ? nuvioAuthenticated
          : (settings.traktClientId ? traktAuthenticated : traktWebAuthenticated) &&
            nuvioAuthenticated;

  return {
    ok: true,
    ready,
    syncTarget,
    traktWebAuthenticated,
    traktWebUser,
    traktAuthenticated,
    traktUser,
    traktConnected,
    traktPendingAuth,
    nuvioAuthenticated,
    nuvioUser,
    diagnosticHint,
    profiles: data[STORAGE_KEYS.PROFILES_CACHE] || [],
    selectedProfileId: data[STORAGE_KEYS.SELECTED_PROFILE_ID] || 1
  };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  (async () => {
    try {
      switch (message?.type) {
        case MESSAGE_TYPES.GET_SETTINGS: {
          sendResponse({ ok: true, settings: await getSettings() });
          return;
        }

        case MESSAGE_TYPES.SAVE_SETTINGS: {
          const current = await getSettings();
          const next = { ...current, ...(message.payload || {}) };
          await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: next });
          if (next.syncTarget !== current.syncTarget) {
            await setupContextMenus(next.syncTarget);
          }
          sendResponse({ ok: true, settings: next });
          return;
        }

        case MESSAGE_TYPES.TRAKT_START_DEVICE_AUTH: {
          const settings = await getSettings();
          const clientId = String(
            message.payload?.clientId || settings.traktClientId || ''
          ).trim();
          const clientSecret = String(
            message.payload?.clientSecret ?? settings.traktClientSecret ?? ''
          ).trim();

          const updatedSettings = {
            ...settings,
            traktClientId: clientId,
            traktClientSecret: clientSecret
          };
          await chrome.storage.local.set({
            [STORAGE_KEYS.SETTINGS]: updatedSettings
          });

          const codeData = await requestTraktDeviceCode({ clientId });
          const pending = {
            clientId,
            clientSecret,
            deviceCode: codeData.device_code,
            userCode: codeData.user_code,
            verificationUrl: codeData.verification_url || 'https://trakt.tv/activate',
            intervalSec: Math.max(2, Number(codeData.interval) || 5),
            expiresAt: Date.now() + (Number(codeData.expires_in) || 600) * 1000
          };

          await chrome.storage.local.set({
            [STORAGE_KEYS.TRAKT_PENDING_AUTH]: pending
          });
          await chrome.alarms.create(TRAKT_POLL_ALARM, { periodInMinutes: 0.5 });

          sendResponse({ ok: true, pending });
          return;
        }

        case MESSAGE_TYPES.TRAKT_POLL_DEVICE_AUTH: {
          const session = await getTraktSession();
          const pending = await getTraktPendingAuth();
          if (!pending && session?.access_token) {
            sendResponse({
              ok: true,
              status: 'authorized',
              user: session.user
            });
            return;
          }
          const result = await pollPendingTraktAuthOnce();
          sendResponse({ ok: true, ...result });
          return;
        }

        case MESSAGE_TYPES.TRAKT_CANCEL_DEVICE_AUTH: {
          await clearTraktPendingAuth();
          sendResponse({ ok: true });
          return;
        }

        case MESSAGE_TYPES.TRAKT_CAPTURE_AUTH: {
          const token = String(message.payload?.accessToken || '').trim();
          const clientId = String(message.payload?.clientId || '').trim();
          const username = String(message.payload?.username || '').trim();
          const slug = String(message.payload?.slug || '').trim();
          const authenticated = Boolean(message.payload?.authenticated);
          if (token || clientId || authenticated) {
            await saveCapturedTraktAuth({
              ...(token ? { accessToken: token } : {}),
              ...(clientId ? { clientId } : {}),
              ...(username ? { username } : {}),
              ...(slug ? { slug } : {}),
              ...(authenticated || token ? { webAuthenticated: true } : {})
            });
          }
          sendResponse({ ok: true });
          return;
        }

        case MESSAGE_TYPES.TRAKT_FORCE_SYNC: {
          await silentProbeTraktAppForToken(true);
          sendResponse(await buildAuthStatus());
          return;
        }

        case MESSAGE_TYPES.TRAKT_LOGOUT: {
          await clearTraktPendingAuth();
          await clearCapturedTraktAuth();
          await chrome.storage.local.remove([
            STORAGE_KEYS.TRAKT_SESSION,
            STORAGE_KEYS.TRAKT_WATCHLIST_CACHE,
            STORAGE_KEYS.TRAKT_WEB_CACHE
          ]);
          sendResponse({ ok: true });
          return;
        }

        case MESSAGE_TYPES.AUTH_LOGIN: {
          const settings = await getSettings();
          const { email, password, baseUrl, publishableKey } =
            message.payload || {};
          const targetSettings = {
            ...settings,
            baseUrl: baseUrl || settings.baseUrl,
            publishableKey: publishableKey || settings.publishableKey
          };
          await chrome.storage.local.set({
            [STORAGE_KEYS.SETTINGS]: targetSettings
          });

          const session = await signInWithPassword({
            baseUrl: targetSettings.baseUrl,
            publishableKey: targetSettings.publishableKey,
            email,
            password
          });
          await saveNuvioSession(session);
          await getOrCreateOriginClientId();

          const profiles = await pullProfiles({
            baseUrl: targetSettings.baseUrl,
            publishableKey: targetSettings.publishableKey,
            session,
            onSessionRefreshed: saveNuvioSession
          });
          await chrome.storage.local.set({
            [STORAGE_KEYS.PROFILES_CACHE]: profiles
          });

          const defaultProfile = profiles[0]?.profile_index || 1;
          await chrome.storage.local.set({
            [STORAGE_KEYS.SELECTED_PROFILE_ID]: defaultProfile
          });
          await refreshNuvioLibraryCache(defaultProfile, true);

          sendResponse({
            ok: true,
            session,
            profiles,
            selectedProfileId: defaultProfile
          });
          return;
        }

        case MESSAGE_TYPES.AUTH_LOGOUT: {
          await chrome.storage.local.remove([
            STORAGE_KEYS.SESSION,
            STORAGE_KEYS.PROFILES_CACHE,
            STORAGE_KEYS.LIBRARY_CACHE
          ]);
          sendResponse({ ok: true });
          return;
        }

        case MESSAGE_TYPES.AUTH_STATUS: {
          sendResponse(await buildAuthStatus());
          return;
        }

        case MESSAGE_TYPES.GET_PROFILES: {
          const settings = await getSettings();
          const session = await getNuvioSession();
          if (!session?.access_token) {
            sendResponse({ ok: false, error: 'Not signed in to Nuvio.' });
            return;
          }
          const profiles = await pullProfiles({
            baseUrl: settings.baseUrl,
            publishableKey: settings.publishableKey,
            session,
            onSessionRefreshed: saveNuvioSession
          });
          await chrome.storage.local.set({
            [STORAGE_KEYS.PROFILES_CACHE]: profiles
          });
          sendResponse({
            ok: true,
            profiles,
            selectedProfileId: await getSelectedProfileId()
          });
          return;
        }

        case MESSAGE_TYPES.SET_PROFILE: {
          const profileId = Number(message.payload?.profileId) || 1;
          await chrome.storage.local.set({
            [STORAGE_KEYS.SELECTED_PROFILE_ID]: profileId
          });
          await refreshNuvioLibraryCache(profileId, true);
          sendResponse({ ok: true, selectedProfileId: profileId });
          return;
        }

        case MESSAGE_TYPES.RESOLVE_MEDIA: {
          const settings = await getSettings();
          const traktClientId = await getActiveTraktClientId(settings);
          const resolved = await resolveMediaMetadata(message.payload || {}, {
            tmdbApiKey: settings.tmdbApiKey,
            traktClientId
          });
          let existingItem = null;
          if (resolved) {
            const items = await getActiveCollectionItems(false);
            existingItem = findMatchingItem(items, resolved);
          }
          sendResponse({
            ok: true,
            resolved,
            inLibrary: Boolean(existingItem),
            existingItem
          });
          return;
        }

        case MESSAGE_TYPES.SEARCH_MEDIA: {
          const settings = await getSettings();
          const traktClientId = await getActiveTraktClientId(settings);
          const results = await searchMediaCandidates(
            message.payload?.query || '',
            {
              tmdbApiKey: settings.tmdbApiKey,
              traktClientId
            }
          );
          const items = await getActiveCollectionItems(false);
          const annotated = results.map((entry) => {
            const match = findMatchingItem(items, entry);
            return {
              ...entry,
              inLibrary: Boolean(match),
              existingContentId: match?.content_id || null
            };
          });
          sendResponse({ ok: true, results: annotated });
          return;
        }

        case MESSAGE_TYPES.ADD_TO_NUVIO: {
          const data = await handleAddMedia(message.payload || {});
          sendResponse({ ok: true, ...data });
          return;
        }

        case MESSAGE_TYPES.REMOVE_FROM_NUVIO: {
          await handleRemoveMedia(message.payload || {});
          sendResponse({ ok: true });
          return;
        }

        case MESSAGE_TYPES.CHECK_IN_LIBRARY: {
          const items = await getActiveCollectionItems(false);
          const match = findMatchingItem(items, message.payload);
          sendResponse({
            ok: true,
            inLibrary: Boolean(match),
            existingItem: match
          });
          return;
        }

        case MESSAGE_TYPES.CHECK_POSTERS_IN_LIBRARY: {
          const items = await getActiveCollectionItems(false);
          const cards = Array.isArray(message.payload?.cards)
            ? message.payload.cards
            : [];
          const map = {};
          for (const card of cards) {
            const match = findMatchingItem(items, card);
            map[card.key] = {
              inLibrary: Boolean(match),
              existingItem: match || null
            };
          }
          sendResponse({ ok: true, map });
          return;
        }

        default:
          sendResponse({ ok: false, error: 'Unknown message type.' });
      }
    } catch (err) {
      sendResponse({
        ok: false,
        error: err?.message || 'Unexpected error in background worker.'
      });
    }
  })();

  return true;
});
