import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkTraktWebSession,
  extractTraktAuthFromCookies,
  parseTraktHtmlState,
  resolveTraktWebItem,
  addViaTraktWebSession,
  removeViaTraktWebSession,
  pullTraktWebWatchlist
} from '../src/shared/trakt-web-client.js';

function htmlResponse(html, { status = 200, url = 'https://trakt.tv/' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    async text() {
      return html;
    },
    async json() {
      return JSON.parse(html);
    }
  };
}

test('checkTraktWebSession detects signed-in user from settings HTML', async () => {
  const settingsHtml = `
    <html>
      <head><meta name="csrf-token" content="csrf-abc-123"></head>
      <body>
        <a href="/users/cinefan/lists">Lists</a>
        <div class="user-profile" data-username="cinefan"></div>
      </body>
    </html>
  `;

  const res = await checkTraktWebSession(async (url, opts) => {
    assert.equal(url, 'https://trakt.tv/settings');
    assert.equal(opts.credentials, 'include');
    return htmlResponse(settingsHtml, { url: 'https://trakt.tv/settings' });
  });

  assert.equal(res.authenticated, true);
  assert.equal(res.username, 'cinefan');
  assert.equal(res.slug, 'cinefan');
  assert.equal(res.csrfToken, 'csrf-abc-123');
});

test('checkTraktWebSession returns authenticated false when redirected to signin', async () => {
  const res = await checkTraktWebSession(async () =>
    htmlResponse('<html><body>Sign in</body></html>', {
      url: 'https://trakt.tv/auth/signin'
    })
  );

  assert.equal(res.authenticated, false);
});

test('extractTraktAuthFromCookies parses OAuth JSON cookie and ignores Cloudflare cookies', () => {
  const onlyCf = extractTraktAuthFromCookies([
    { name: '__cf_bm', value: 'xyz' },
    { name: '_ga', value: 'GA1.2.3' }
  ]);
  assert.equal(onlyCf.hasSessionCookie, false);
  assert.equal(onlyCf.accessToken, null);

  const oauthCookie = extractTraktAuthFromCookies([
    {
      name: 'trakt-auth',
      value: encodeURIComponent(
        JSON.stringify({
          access_token: 'tok-from-cookie',
          refresh_token: 'ref-from-cookie',
          user: { username: 'cinefan', ids: { slug: 'cinefan' } }
        })
      )
    }
  ]);
  assert.equal(oauthCookie.hasSessionCookie, true);
  assert.equal(oauthCookie.accessToken, 'tok-from-cookie');
  assert.equal(oauthCookie.username, 'cinefan');
});

test('checkTraktWebSession detects V3 app.trakt.tv SPA shell when session cookie is present', async () => {
  const res = await checkTraktWebSession(
    async (url) => {
      if (url === 'https://trakt.tv/settings') {
        return htmlResponse('<html><body><div id="app"></div></body></html>', {
          url: 'https://app.trakt.tv/settings'
        });
      }
      return htmlResponse('', { status: 404 });
    },
    {
      cookies: [{ name: '_traktsession', value: 'sess-cookie-123' }]
    }
  );

  assert.equal(res.authenticated, true);
  assert.equal(res.username, 'Trakt User');
});

test('checkTraktWebSession detects classic HTML with bare /users/<slug> link and /auth/signout', async () => {
  const html = `
    <html>
      <head><meta name="csrf-token" content="csrf-v2"></head>
      <body>
        <nav>
          <a href="/users/sunva">Profile</a>
          <a href="/auth/signout">Sign Out</a>
        </nav>
      </body>
    </html>
  `;
  const res = await checkTraktWebSession(async () =>
    htmlResponse(html, { url: 'https://trakt.tv/settings' })
  );

  assert.equal(res.authenticated, true);
  assert.equal(res.username, 'sunva');
  assert.equal(res.slug, 'sunva');
  assert.equal(res.csrfToken, 'csrf-v2');
});

test('resolveTraktWebItem matches search grid item and reads detail watchlist state', async () => {
  const searchHtml = `
    <html>
      <head><meta name="csrf-token" content="csrf-search"></head>
      <body>
        <div class="grid-item" data-type="movie" data-movie-id="12601" data-url="/movies/inception-2010">
          <a href="/movies/inception-2010">Inception</a>
          <span class="year">2010</span>
        </div>
      </body>
    </html>
  `;

  const detailHtml = `
    <html>
      <head><meta name="csrf-token" content="csrf-detail-999"></head>
      <body>
        <a class="action-watchlist selected" href="/movies/inception-2010/watchlist">In Watchlist</a>
      </body>
    </html>
  `;

  const mockFetch = async (url) => {
    if (url.includes('/search/movies?query=Inception')) {
      return htmlResponse(searchHtml, { url });
    }
    if (url === 'https://trakt.tv/movies/inception-2010') {
      return htmlResponse(detailHtml, { url });
    }
    return htmlResponse('', { status: 404 });
  };

  const resolved = await resolveTraktWebItem(
    { title: 'Inception', year: '2010', type: 'movie' },
    mockFetch
  );

  assert.equal(resolved.itemPath, '/movies/inception-2010');
  assert.equal(resolved.traktId, '12601');
  assert.equal(resolved.csrfToken, 'csrf-detail-999');
  assert.equal(resolved.inWatchlist, true);
});

test('addViaTraktWebSession skips POST when already inWatchlist and posts CSRF+XHR when not', async () => {
  const posts = [];
  const searchHtml = `
    <html>
      <head><meta name="csrf-token" content="csrf-1"></head>
      <body>
        <div class="grid-item" data-type="movie" data-movie-id="550" data-url="/movies/fight-club-1999">
          <a href="/movies/fight-club-1999">Fight Club</a>
          <span class="year">1999</span>
        </div>
      </body>
    </html>
  `;

  let detailInWatchlist = true;
  const mockFetch = async (url, opts = {}) => {
    if (opts.method === 'POST') {
      posts.push({ url, opts });
      if (url.endsWith('/watchlist')) {
        return htmlResponse('{"status":"added"}', { status: 200, url });
      }
      return htmlResponse('{}', { status: 200, url });
    }
    if (url.includes('/search/')) {
      return htmlResponse(searchHtml, { url });
    }
    if (url === 'https://trakt.tv/movies/fight-club-1999') {
      const cls = detailInWatchlist ? 'selected' : '';
      return htmlResponse(
        `<html><head><meta name="csrf-token" content="csrf-fc"></head><body><a class="action-watchlist ${cls}" data-movie-id="550">Watchlist</a></body></html>`,
        { url }
      );
    }
    return htmlResponse('', { status: 404 });
  };

  // Already in watchlist -> must NOT toggle/remove!
  const already = await addViaTraktWebSession(
    { name: 'Fight Club', releaseInfo: '1999', type: 'movie' },
    mockFetch
  );
  assert.equal(already.alreadyInWatchlist, true);
  assert.equal(posts.length, 0);

  // Not in watchlist -> must POST /movies/fight-club-1999/watchlist
  detailInWatchlist = false;
  const added = await addViaTraktWebSession(
    { name: 'Fight Club', releaseInfo: '1999', type: 'movie' },
    mockFetch
  );
  assert.equal(added.ok, true);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, 'https://trakt.tv/movies/fight-club-1999/watchlist');
  assert.equal(posts[0].opts.credentials, 'include');
  assert.equal(posts[0].opts.headers['X-CSRF-Token'], 'csrf-fc');
  assert.equal(posts[0].opts.headers['X-Requested-With'], 'XMLHttpRequest');
});

test('addViaTraktWebSession falls back to /list when /watchlist returns 404', async () => {
  const posts = [];
  const mockFetch = async (url, opts = {}) => {
    if (opts.method === 'POST') {
      posts.push({ url, opts });
      if (url.endsWith('/watchlist')) {
        return htmlResponse('Not found', { status: 404, url });
      }
      return htmlResponse('{"status":"ok"}', { status: 200, url });
    }
    if (url.includes('/search/')) {
      return htmlResponse(
        `<div class="grid-item" data-type="movie" data-movie-id="999" data-url="/movies/dune-2021"><a href="/movies/dune-2021">Dune</a><span class="year">2021</span></div>`,
        { url }
      );
    }
    return htmlResponse(
      `<html><head><meta name="csrf-token" content="csrf-dune"></head><body><a class="action-watchlist">Watchlist</a></body></html>`,
      { url }
    );
  };

  const res = await addViaTraktWebSession(
    { name: 'Dune', releaseInfo: '2021', type: 'movie' },
    mockFetch
  );
  assert.equal(res.ok, true);
  assert.equal(posts.length, 2);
  assert.equal(posts[1].url, 'https://trakt.tv/movies/dune-2021/list');
  assert.match(posts[1].opts.body, /list_id=watchlist/);
});

test('removeViaTraktWebSession removes only when inWatchlist is true', async () => {
  const posts = [];
  let inList = false;
  const mockFetch = async (url, opts = {}) => {
    if (opts.method === 'POST') {
      posts.push(url);
      return htmlResponse('{}', { status: 200, url });
    }
    if (url.includes('/search/')) {
      return htmlResponse(
        `<div class="grid-item" data-type="show" data-show-id="1390" data-url="/shows/severance"><a href="/shows/severance">Severance</a><span class="year">2022</span></div>`,
        { url }
      );
    }
    return htmlResponse(
      `<html><head><meta name="csrf-token" content="csrf-s"></head><body><a class="action-watchlist ${inList ? 'selected' : ''}">Watchlist</a></body></html>`,
      { url }
    );
  };

  await removeViaTraktWebSession(
    { name: 'Severance', releaseInfo: '2022', type: 'series' },
    mockFetch
  );
  assert.equal(posts.length, 0);

  inList = true;
  await removeViaTraktWebSession(
    { name: 'Severance', releaseInfo: '2022', type: 'series' },
    mockFetch
  );
  assert.equal(posts.length, 1);
  assert.equal(posts[0], 'https://trakt.tv/shows/severance/watchlist');
});

test('pullTraktWebWatchlist parses user watchlist grid items when slug is known', async () => {
  const watchlistHtml = `
    <div class="grid-item" data-type="movie" data-movie-id="12601" data-url="/movies/inception-2010">
      <a href="/movies/inception-2010">Inception</a>
      <span class="year">2010</span>
    </div>
    <div class="grid-item" data-type="show" data-show-id="1390" data-url="/shows/severance">
      <a href="/shows/severance">Severance</a>
      <span class="year">2022</span>
    </div>
  `;

  const items = await pullTraktWebWatchlist('cinefan', async (url) => {
    assert.equal(url, 'https://trakt.tv/users/cinefan/watchlist');
    return htmlResponse(watchlistHtml, { url });
  });

  assert.equal(items.length, 2);
  assert.equal(items[0].name, 'Inception');
  assert.equal(items[0].year, '2010');
  assert.equal(items[0].content_type, 'movie');
  assert.equal(items[1].content_type, 'series');
});

test('checkTraktWebSession continues past trakt.tv signin redirect and detects app.trakt.tv SvelteKit SSR state', async () => {
  const ssrHtml = `
    <html>
      <body>
        <div id="svelte">
          <script>
            __sveltekit_123.resolve({
              isAuthorized:true,
              user:{username:"sunva",slug:"sunva"}
            });
          </script>
        </div>
      </body>
    </html>
  `;

  const res = await checkTraktWebSession(async (url) => {
    if (url === 'https://trakt.tv/settings') {
      return htmlResponse('<html><body>Sign in</body></html>', {
        url: 'https://trakt.tv/auth/signin'
      });
    }
    if (url === 'https://app.trakt.tv/') {
      return htmlResponse(ssrHtml, { url: 'https://app.trakt.tv/' });
    }
    return htmlResponse('', { status: 404 });
  });

  assert.equal(res.authenticated, true);
  assert.equal(res.username, 'sunva');
  assert.equal(res.slug, 'sunva');
});

test('checkTraktWebSession detects app.trakt.tv SPA shell when og-auth cookie is present after trakt.tv redirect', async () => {
  const res = await checkTraktWebSession(
    async (url) => {
      if (url === 'https://trakt.tv/settings') {
        return htmlResponse('<html><body>Sign in</body></html>', {
          url: 'https://trakt.tv/auth/signin'
        });
      }
      if (url === 'https://app.trakt.tv/') {
        return htmlResponse('<html><body><div id="svelte"></div></body></html>', {
          url: 'https://app.trakt.tv/'
        });
      }
      return htmlResponse('', { status: 404 });
    },
    {
      cookies: [{ name: 'og-auth', value: 'encrypted-session-value' }]
    }
  );

  assert.equal(res.authenticated, true);
  assert.equal(res.username, 'Trakt User');
});

test('extractTraktAuthFromCookies recognizes og-auth, __Secure-trakt-auth, base64 JSON, string token, and token.value', () => {
  const b64Payload = Buffer.from(
    JSON.stringify({
      token: 'tok-v3-string',
      clientId: 'a'.repeat(64),
      user: { username: 'operafan', slug: 'operafan' }
    }),
    'utf8'
  ).toString('base64url');

  const ogParsed = extractTraktAuthFromCookies([
    { name: 'og-auth', value: `base64-${b64Payload}` }
  ]);
  assert.equal(ogParsed.hasSessionCookie, true);
  assert.equal(ogParsed.accessToken, 'tok-v3-string');
  assert.equal(ogParsed.clientId, 'a'.repeat(64));
  assert.equal(ogParsed.username, 'operafan');
  assert.equal(ogParsed.slug, 'operafan');

  const nestedB64 = Buffer.from(
    JSON.stringify({
      token: { value: 'tok-nested-val', refresh: 'ref-nested' }
    }),
    'utf8'
  ).toString('base64');

  const secureParsed = extractTraktAuthFromCookies([
    { name: '__Secure-trakt-auth', value: nestedB64 }
  ]);
  assert.equal(secureParsed.hasSessionCookie, true);
  assert.equal(secureParsed.accessToken, 'tok-nested-val');
  assert.equal(secureParsed.refreshToken, 'ref-nested');
});

test('parseTraktHtmlState extracts SvelteKit SSR token, 64-hex clientId, and respects isAuthorized:false', async () => {
  const hexClient = '0123456789abcdef'.repeat(4);
  const ssrHtml = `
    <html>
      <body>
        <a href="/oauth/authorize?client_id=${hexClient}">OAuth</a>
        <script>
          const data = {
            isAuthorized:!0,
            auth:{token:"bearer_tok_from_svelte_payload_123456"},
            user:{username:"cinephile",slug:"cinephile-slug"}
          };
        </script>
      </body>
    </html>
  `;

  const parsed = parseTraktHtmlState(ssrHtml);
  assert.equal(parsed.svelteAuthorized, true);
  assert.equal(parsed.accessToken, 'bearer_tok_from_svelte_payload_123456');
  assert.equal(parsed.clientId, hexClient);
  assert.equal(parsed.username, 'cinephile');
  assert.equal(parsed.slug, 'cinephile-slug');

  const signedOutHtml = `
    <html>
      <body>
        <script>const data = { isAuthorized:false, clientId:"${hexClient}" };</script>
      </body>
    </html>
  `;
  const signedOutRes = await checkTraktWebSession(
    async (url) => {
      if (url === 'https://trakt.tv/settings') {
        return htmlResponse('<html><body>Sign in</body></html>', {
          url: 'https://trakt.tv/auth/signin'
        });
      }
      if (url === 'https://app.trakt.tv/') {
        return htmlResponse(signedOutHtml, { url: 'https://app.trakt.tv/' });
      }
      return htmlResponse('', { status: 404 });
    },
    { cookies: [{ name: 'og-auth', value: 'stale' }] }
  );

  assert.equal(signedOutRes.authenticated, false);
  assert.equal(signedOutRes.clientId, hexClient);
});
