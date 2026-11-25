import test from 'node:test';
import assert from 'node:assert/strict';
import {
  requestTraktDeviceCode,
  pollTraktDeviceToken,
  refreshTraktSession,
  ensureValidTraktSession,
  fetchTraktUserSettings,
  pullTraktWatchlist,
  addToTraktWatchlist,
  removeFromTraktWatchlist,
  searchTraktCatalog
} from '../src/shared/trakt-client.js';

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return payload === undefined ? '' : JSON.stringify(payload);
    }
  };
}

test('requestTraktDeviceCode sends client_id and required Trakt v2 headers', async () => {
  let capturedUrl = '';
  let capturedOptions = null;

  const mockFetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return jsonResponse({
      device_code: 'dev-code-123',
      user_code: 'ABCD-1234',
      verification_url: 'https://trakt.tv/activate',
      expires_in: 600,
      interval: 5
    });
  };

  const result = await requestTraktDeviceCode(
    { clientId: 'trakt-client-xyz' },
    mockFetch
  );

  assert.equal(capturedUrl, 'https://api.trakt.tv/oauth/device/code');
  assert.equal(capturedOptions.method, 'POST');
  assert.equal(capturedOptions.headers['trakt-api-version'], '2');
  assert.equal(capturedOptions.headers['trakt-api-key'], 'trakt-client-xyz');
  assert.deepEqual(JSON.parse(capturedOptions.body), {
    client_id: 'trakt-client-xyz'
  });
  assert.equal(result.user_code, 'ABCD-1234');
});

test('pollTraktDeviceToken handles 400, 429, 410, 418, and 200 omitting empty secret', async () => {
  const bodies = [];
  let nextStatus = 400;
  let nextPayload = { error: 'authorization_pending' };

  const mockFetch = async (url, options) => {
    assert.equal(url, 'https://api.trakt.tv/oauth/device/token');
    bodies.push(JSON.parse(options.body));
    return jsonResponse(nextPayload, nextStatus);
  };

  const pending = await pollTraktDeviceToken(
    { clientId: 'cid', clientSecret: '', deviceCode: 'dc1' },
    mockFetch
  );
  assert.equal(pending.status, 'pending');
  assert.equal('client_secret' in bodies[0], false);

  nextStatus = 429;
  const slowDown = await pollTraktDeviceToken(
    { clientId: 'cid', clientSecret: 'sec', deviceCode: 'dc1' },
    mockFetch
  );
  assert.equal(slowDown.status, 'slow_down');
  assert.equal(bodies[1].client_secret, 'sec');

  nextStatus = 410;
  const expired = await pollTraktDeviceToken(
    { clientId: 'cid', deviceCode: 'dc1' },
    mockFetch
  );
  assert.equal(expired.status, 'expired');

  nextStatus = 418;
  const denied = await pollTraktDeviceToken(
    { clientId: 'cid', deviceCode: 'dc1' },
    mockFetch
  );
  assert.equal(denied.status, 'denied');

  nextStatus = 200;
  nextPayload = {
    access_token: 'trakt-acc',
    refresh_token: 'trakt-ref',
    expires_in: 86400,
    created_at: 1800000000
  };
  const auth = await pollTraktDeviceToken(
    { clientId: 'cid', deviceCode: 'dc1' },
    mockFetch
  );
  assert.equal(auth.status, 'authorized');
  assert.equal(auth.session.access_token, 'trakt-acc');
  assert.equal(auth.session.refresh_token, 'trakt-ref');
});

test('refreshTraktSession & ensureValidTraktSession rotate single-use refresh tokens', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  let capturedBody = null;

  const mockFetch = async (url, options) => {
    assert.equal(url, 'https://api.trakt.tv/oauth/token');
    capturedBody = JSON.parse(options.body);
    return jsonResponse({
      access_token: 'new-trakt-acc',
      refresh_token: 'new-trakt-ref',
      expires_in: 86400,
      created_at: nowSec
    });
  };

  const session = await ensureValidTraktSession(
    {
      clientId: 'cid',
      clientSecret: '',
      session: {
        access_token: 'old-acc',
        refresh_token: 'old-ref',
        expires_at: nowSec + 10
      }
    },
    mockFetch
  );

  assert.equal(capturedBody.grant_type, 'refresh_token');
  assert.equal(capturedBody.redirect_uri, 'urn:ietf:wg:oauth:2.0:oob');
  assert.equal(capturedBody.refresh_token, 'old-ref');
  assert.equal('client_secret' in capturedBody, false);
  assert.equal(session.access_token, 'new-trakt-acc');
  assert.equal(session.refresh_token, 'new-trakt-ref');

  const explicit = await refreshTraktSession(
    { clientId: 'cid', clientSecret: 'sec', refreshToken: 'r2' },
    mockFetch
  );
  assert.equal(capturedBody.client_secret, 'sec');
  assert.equal(explicit.access_token, 'new-trakt-acc');
});

test('fetchTraktUserSettings returns username and slug', async () => {
  const mockFetch = async (url, options) => {
    assert.equal(url, 'https://api.trakt.tv/users/settings');
    assert.equal(options.headers.Authorization, 'Bearer tok');
    return jsonResponse({
      user: {
        username: 'cinephile',
        ids: { slug: 'cinephile' }
      }
    });
  };

  const profile = await fetchTraktUserSettings(
    {
      clientId: 'cid',
      session: {
        access_token: 'tok',
        refresh_token: 'ref',
        expires_at: Math.floor(Date.now() / 1000) + 3600
      }
    },
    mockFetch
  );

  assert.deepEqual(profile, { username: 'cinephile', slug: 'cinephile' });
});

test('pullTraktWatchlist normalizes movies and shows with imdbId and tmdbId', async () => {
  const mockFetch = async (url) => {
    assert.equal(url, 'https://api.trakt.tv/sync/watchlist');
    return jsonResponse([
      {
        rank: 1,
        listed_at: '2026-11-25T10:00:00.000Z',
        type: 'movie',
        movie: {
          title: 'Inception',
          year: 2010,
          ids: { trakt: 12601, imdb: 'tt1375666', tmdb: 27205 }
        }
      },
      {
        rank: 2,
        listed_at: '2026-11-25T10:05:00.000Z',
        type: 'show',
        show: {
          title: 'Severance',
          year: 2022,
          ids: { trakt: 170000, imdb: 'tt11280740', tmdb: 95396 }
        }
      }
    ]);
  };

  const items = await pullTraktWatchlist(
    {
      clientId: 'cid',
      session: {
        access_token: 'tok',
        refresh_token: 'ref',
        expires_at: Math.floor(Date.now() / 1000) + 3600
      }
    },
    mockFetch
  );

  assert.equal(items.length, 2);
  assert.deepEqual(items[0], {
    content_id: 'tt1375666',
    content_type: 'movie',
    imdbId: 'tt1375666',
    tmdbId: '27205',
    name: 'Inception',
    year: '2010',
    listed_at: '2026-11-25T10:00:00.000Z'
  });
  assert.equal(items[1].content_type, 'series');
  assert.equal(items[1].imdbId, 'tt11280740');
});

test('addToTraktWatchlist retries on 401 and errors cleanly when item is not_found', async () => {
  let attempt = 0;
  let capturedSession = null;

  const mockFetch = async (url, options) => {
    if (url === 'https://api.trakt.tv/oauth/token') {
      return jsonResponse({
        access_token: 'fresh-acc',
        refresh_token: 'fresh-ref',
        expires_in: 86400,
        created_at: Math.floor(Date.now() / 1000)
      });
    }
    if (url === 'https://api.trakt.tv/sync/watchlist') {
      attempt += 1;
      if (attempt === 1) {
        return jsonResponse({ error: 'unauthorized' }, 401);
      }
      const body = JSON.parse(options.body);
      assert.deepEqual(body, {
        movies: [
          {
            title: 'Inception',
            year: 2010,
            ids: { imdb: 'tt1375666', tmdb: 27205 }
          }
        ]
      });
      return jsonResponse({
        added: { movies: 1, shows: 0 },
        existing: { movies: 0, shows: 0 },
        not_found: { movies: [], shows: [] }
      });
    }
    return jsonResponse({}, 404);
  };

  const res = await addToTraktWatchlist(
    {
      clientId: 'cid',
      session: {
        access_token: 'stale',
        refresh_token: 'old-ref',
        expires_at: Math.floor(Date.now() / 1000) + 3600
      },
      media: {
        type: 'movie',
        name: 'Inception',
        releaseInfo: '2010',
        imdbId: 'tt1375666',
        tmdbId: '27205'
      },
      onSessionRefreshed: (s) => {
        capturedSession = s;
      }
    },
    mockFetch
  );

  assert.equal(res.ok, true);
  assert.equal(capturedSession.access_token, 'fresh-acc');

  await assert.rejects(
    () =>
      addToTraktWatchlist(
        {
          clientId: 'cid',
          session: {
            access_token: 'ok',
            refresh_token: 'r',
            expires_at: Math.floor(Date.now() / 1000) + 3600
          },
          media: { type: 'movie', name: 'Ghost', imdbId: 'tt0000000' }
        },
        async () =>
          jsonResponse({
            added: { movies: 0, shows: 0 },
            existing: { movies: 0, shows: 0 },
            not_found: { movies: [{ ids: { imdb: 'tt0000000' } }], shows: [] }
          })
      ),
    /could not find/i
  );
});

test('removeFromTraktWatchlist posts to /sync/watchlist/remove', async () => {
  let capturedUrl = '';
  let capturedBody = null;

  const mockFetch = async (url, options) => {
    capturedUrl = url;
    capturedBody = JSON.parse(options.body);
    return jsonResponse({
      deleted: { movies: 0, shows: 1 },
      not_found: { movies: [], shows: [] }
    });
  };

  const res = await removeFromTraktWatchlist(
    {
      clientId: 'cid',
      session: {
        access_token: 'ok',
        refresh_token: 'r',
        expires_at: Math.floor(Date.now() / 1000) + 3600
      },
      media: { type: 'series', imdbId: 'tt11280740' }
    },
    mockFetch
  );

  assert.equal(capturedUrl, 'https://api.trakt.tv/sync/watchlist/remove');
  assert.deepEqual(capturedBody, {
    shows: [{ ids: { imdb: 'tt11280740' } }]
  });
  assert.equal(res.ok, true);
});

test('searchTraktCatalog searches api.trakt.tv and addToTraktWatchlist supports traktId', async () => {
  const results = await searchTraktCatalog(
    { clientId: 'cid', query: 'La sustancia', year: '2024', type: 'movie' },
    async (url, opts) => {
      assert.match(url, /^https:\/\/api\.trakt\.tv\/search\/movie\?query=La%20sustancia/);
      assert.equal(opts.headers['trakt-api-key'], 'cid');
      return jsonResponse([
        {
          type: 'movie',
          score: 50,
          movie: {
            title: 'The Substance',
            year: 2024,
            ids: { trakt: 912345, imdb: 'tt17526714', tmdb: 933260 }
          }
        }
      ]);
    }
  );

  assert.equal(results.length, 1);
  assert.equal(results[0].traktId, '912345');
  assert.equal(results[0].imdbId, 'tt17526714');

  let bodySent = null;
  await addToTraktWatchlist(
    {
      clientId: 'cid',
      session: {
        access_token: 'ok',
        refresh_token: 'r',
        expires_at: Math.floor(Date.now() / 1000) + 3600
      },
      media: { type: 'movie', name: 'The Substance', traktId: '912345' }
    },
    async (_url, opts) => {
      bodySent = JSON.parse(opts.body);
      return jsonResponse({ added: { movies: 1 }, existing: {}, not_found: {} });
    }
  );
  assert.deepEqual(bodySent.movies[0].ids, { trakt: 912345 });
});
