/**
 * MAIN-world hook running on app.trakt.tv, og.trakt.tv, and trakt.tv.
 * Passively observes outgoing api.trakt.tv auth headers and SvelteKit SSR payloads
 * so Chrome & Opera GX can sync Watchlist items using the user's active Trakt web session.
 */
(() => {
  if (window.__nuvioTraktHookInstalled) return;
  window.__nuvioTraktHookInstalled = true;

  let lastDispatched = '';

  function emitCaptured({
    accessToken = '',
    clientId = '',
    username = '',
    slug = '',
    authenticated = false
  } = {}) {
    const cleanToken = String(accessToken || '').trim();
    const cleanClientId = String(clientId || '').trim();
    const cleanUser = String(username || '').trim();
    const cleanSlug = String(slug || '').trim();
    const isAuthed = Boolean(authenticated);

    if (!cleanToken && !cleanClientId && !isAuthed) return;

    const fingerprint = [
      cleanClientId,
      cleanToken ? cleanToken.slice(0, 16) : '',
      cleanUser,
      isAuthed ? '1' : '0'
    ].join(':');
    if (fingerprint === lastDispatched) return;
    lastDispatched = fingerprint;

    window.postMessage(
      {
        source: 'nuvio-trakt-auth-hook',
        accessToken: cleanToken || null,
        clientId: cleanClientId || null,
        username: cleanUser || null,
        slug: cleanSlug || null,
        authenticated: isAuthed
      },
      window.location.origin
    );
  }

  function inspectHeaderPair(headersLike) {
    if (!headersLike) return;
    let auth = '';
    let apiKey = '';

    if (headersLike instanceof Headers) {
      auth = headersLike.get('authorization') || '';
      apiKey = headersLike.get('trakt-api-key') || '';
    } else if (Array.isArray(headersLike)) {
      for (const pair of headersLike) {
        if (!Array.isArray(pair) || pair.length < 2) continue;
        const name = String(pair[0] || '').toLowerCase();
        if (name === 'authorization') auth = String(pair[1] || '');
        if (name === 'trakt-api-key') apiKey = String(pair[1] || '');
      }
    } else if (typeof headersLike === 'object') {
      for (const [k, v] of Object.entries(headersLike)) {
        const name = String(k).toLowerCase();
        if (name === 'authorization') auth = String(v || '');
        if (name === 'trakt-api-key') apiKey = String(v || '');
      }
    }

    const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
    const trimmedKey = apiKey.trim();
    if (token || trimmedKey) {
      emitCaptured({
        accessToken: token,
        clientId: trimmedKey,
        authenticated: Boolean(token)
      });
    }
  }

  function resolveRequestUrl(input) {
    if (typeof input === 'string') return input;
    if (input instanceof URL) return input.href;
    if (input && typeof input.url === 'string') return input.url;
    return String(input || '');
  }

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = async function patchedFetch(input, init) {
      try {
        const url = resolveRequestUrl(input);
        if (url.includes('api.trakt.tv')) {
          if (input && typeof input === 'object' && input.headers) {
            inspectHeaderPair(input.headers);
          }
          if (init && init.headers) {
            inspectHeaderPair(init.headers);
          }
        }
      } catch {
        // Never interfere with host page fetch
      }
      return origFetch.apply(this, arguments);
    };
  }

  const xhrMeta = new WeakMap();
  const origOpen = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
    xhrMeta.set(this, { url: resolveRequestUrl(url), headers: {} });
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function patchedSetHeader(name, value) {
    const meta = xhrMeta.get(this);
    if (meta && meta.url.includes('api.trakt.tv')) {
      meta.headers[String(name).toLowerCase()] = String(value || '');
      const auth = meta.headers.authorization || '';
      const key = meta.headers['trakt-api-key'] || '';
      const token = auth.toLowerCase().startsWith('bearer ') ? auth.slice(7).trim() : '';
      if (token || key.trim()) {
        emitCaptured({
          accessToken: token,
          clientId: key.trim(),
          authenticated: Boolean(token)
        });
      }
    }
    return origSetHeader.apply(this, arguments);
  };

  function scanSsrScripts() {
    try {
      const chunks = [];
      for (const script of document.scripts || []) {
        if (script.textContent) chunks.push(script.textContent);
      }
      const joined = chunks.join('\n');
      if (!joined) return;

      const authMatch = joined.match(
        /(?:["']isAuthorized["']|\bisAuthorized)\s*:\s*(true|!0|false|!1)\b/
      );
      const isAuthorized = authMatch
        ? authMatch[1] === 'true' || authMatch[1] === '!0'
        : false;

      const tokenMatch =
        joined.match(
          /(?:["'](?:access_token|accessToken)["']|\b(?:access_token|accessToken))\s*:\s*["']([A-Za-z0-9._~+/-]{20,})["']/
        )?.[1] ||
        joined.match(
          /\btoken\s*:\s*\{\s*(?:["']?(?:value|accessToken|access_token)["']?)\s*:\s*["']([A-Za-z0-9._~+/-]{20,})["']/
        )?.[1] ||
        joined.match(
          /(?:["']auth["']|\bauth)\s*:\s*\{[^}]{0,300}?(?:["']token["']|\btoken)\s*:\s*["']([A-Za-z0-9._~+/-]{20,})["']/
        )?.[1] ||
        '';

      const cidMatch =
        joined.match(/[?&]client_id=([a-f0-9]{64})\b/i)?.[1] ||
        joined.match(
          /(?:["']?(?:client_id|clientId|TRAKT_CLIENT_ID|trakt-api-key)["']?)\s*[:=]\s*["']([a-f0-9]{64})["']/i
        )?.[1] ||
        '';

      const userMatch = joined.match(
        /(?:["']username["']|\busername)\s*:\s*["']([^"'\s]{1,60})["']/i
      )?.[1] || '';
      const slugMatch = joined.match(
        /(?:["']slug["']|\bslug)\s*:\s*["']([^"'\s]{1,60})["']/i
      )?.[1] || '';

      if (isAuthorized || tokenMatch || cidMatch) {
        emitCaptured({
          accessToken: tokenMatch,
          clientId: cidMatch,
          username: userMatch,
          slug: slugMatch || userMatch,
          authenticated: Boolean(isAuthorized || tokenMatch || userMatch)
        });
      }
    } catch {
      // Ignore SSR scan failures
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanSsrScripts, { once: true });
  } else {
    scanSsrScripts();
  }
})();
