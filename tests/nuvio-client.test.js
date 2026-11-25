import test from 'node:test';
import assert from 'node:assert/strict';
import {
  signInWithPassword,
  ensureValidSession,
  pullProfiles,
  pullLibrary,
  pushLibraryItems,
  deleteLibraryItems
} from '../src/shared/nuvio-client.js';

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return payload === undefined ? '' : JSON.stringify(payload);
    }
  };
}

test('signInWithPassword hits /auth/v1/token?grant_type=password with apikey header', async () => {
  let capturedUrl = '';
  let capturedOptions = null;

  const mockFetch = async (url, options) => {
    capturedUrl = url;
    capturedOptions = options;
    return jsonResponse({
      access_token: 'acc-123',
      refresh_token: 'ref-456',
      expires_in: 3600,
      expires_at: 1999999999,
      user: { id: 'u1', email: 'fan@example.com' }
    });
  };

  const session = await signInWithPassword(
    {
      baseUrl: 'https://api.nuvio.tv',
      publishableKey: 'sb_publishable_test',
      email: 'fan@example.com',
      password: 'secret'
    },
    mockFetch
  );

  assert.equal(capturedUrl, 'https://api.nuvio.tv/auth/v1/token?grant_type=password');
  assert.equal(capturedOptions.method, 'POST');
  assert.equal(capturedOptions.headers.apikey, 'sb_publishable_test');
  assert.deepEqual(JSON.parse(capturedOptions.body), {
    email: 'fan@example.com',
    password: 'secret'
  });
  assert.equal(session.access_token, 'acc-123');
});

test('ensureValidSession refreshes expiring tokens automatically', async () => {
  const nowSec = Math.floor(Date.now() / 1000);
  let calledRefresh = false;

  const mockFetch = async (url, options) => {
    calledRefresh = true;
    assert.equal(
      url,
      'https://api.nuvio.tv/auth/v1/token?grant_type=refresh_token'
    );
    assert.deepEqual(JSON.parse(options.body), { refresh_token: 'old-refresh' });
    return jsonResponse({
      access_token: 'new-acc',
      refresh_token: 'new-ref',
      expires_in: 3600,
      expires_at: nowSec + 3600,
      user: { id: 'u1', email: 'fan@example.com' }
    });
  };

  const refreshed = await ensureValidSession(
    {
      baseUrl: 'https://api.nuvio.tv',
      publishableKey: 'sb_publishable_test',
      session: {
        access_token: 'expiring-acc',
        refresh_token: 'old-refresh',
        expires_at: nowSec + 10
      }
    },
    mockFetch
  );

  assert.equal(calledRefresh, true);
  assert.equal(refreshed.access_token, 'new-acc');
});

test('pushLibraryItems retries once after 401 and sends sync_push_library_items payload', async () => {
  const calls = [];
  const mockFetch = async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/sync_push_library_items') && calls.length === 1) {
      return jsonResponse({ message: 'JWT expired' }, 401);
    }
    if (url.includes('grant_type=refresh_token')) {
      return jsonResponse({
        access_token: 'fresh-token',
        refresh_token: 'fresh-refresh',
        expires_in: 3600,
        expires_at: Math.floor(Date.now() / 1000) + 3600,
        user: { id: 'u1', email: 'fan@example.com' }
      });
    }
    if (url.endsWith('/sync_push_library_items')) {
      return jsonResponse(null, 200);
    }
    return jsonResponse({}, 404);
  };

  let updatedSession = null;
  const result = await pushLibraryItems(
    {
      baseUrl: 'https://api.nuvio.tv',
      publishableKey: 'sb_publishable_test',
      session: {
        access_token: 'stale-token',
        refresh_token: 'old-refresh',
        expires_at: Math.floor(Date.now() / 1000) + 1000
      },
      profileId: 2,
      originClientId: 'ext-uuid-1',
      items: [
        {
          content_id: 'tt1375666',
          content_type: 'movie',
          name: 'Inception',
          added_at: 1732531200000
        }
      ],
      onSessionRefreshed: (s) => {
        updatedSession = s;
      }
    },
    mockFetch
  );

  assert.equal(result.ok, true);
  assert.equal(updatedSession.access_token, 'fresh-token');
  const finalCall = calls.at(-1);
  assert.equal(
    finalCall.url,
    'https://api.nuvio.tv/rest/v1/rpc/sync_push_library_items'
  );
  assert.equal(finalCall.options.headers.Authorization, 'Bearer fresh-token');
  assert.deepEqual(JSON.parse(finalCall.options.body), {
    p_profile_id: 2,
    p_origin_client_id: 'ext-uuid-1',
    p_items: [
      {
        content_id: 'tt1375666',
        content_type: 'movie',
        name: 'Inception',
        added_at: 1732531200000
      }
    ]
  });
});

test('pullProfiles, pullLibrary, and deleteLibraryItems call expected RPC endpoints', async () => {
  const urls = [];
  const mockFetch = async (url) => {
    urls.push(url);
    if (url.endsWith('/sync_pull_profiles')) {
      return jsonResponse([{ profile_index: 1, name: 'Main' }]);
    }
    if (url.endsWith('/sync_pull_library')) {
      return jsonResponse([{ content_id: 'tt1375666', content_type: 'movie' }]);
    }
    if (url.endsWith('/sync_delete_library_items')) {
      return jsonResponse(null, 200);
    }
    return jsonResponse({}, 404);
  };

  const ctx = {
    baseUrl: 'https://api.nuvio.tv',
    publishableKey: 'sb_publishable_test',
    session: {
      access_token: 'valid',
      refresh_token: 'ref',
      expires_at: Math.floor(Date.now() / 1000) + 3600
    },
    profileId: 1,
    originClientId: 'ext-1'
  };

  const profiles = await pullProfiles(ctx, mockFetch);
  const library = await pullLibrary(ctx, mockFetch);
  const del = await deleteLibraryItems(
    {
      ...ctx,
      items: [{ content_id: 'tt1375666', content_type: 'movie' }]
    },
    mockFetch
  );

  assert.equal(profiles[0].name, 'Main');
  assert.equal(library[0].content_id, 'tt1375666');
  assert.equal(del.ok, true);
  assert.deepEqual(urls, [
    'https://api.nuvio.tv/rest/v1/rpc/sync_pull_profiles',
    'https://api.nuvio.tv/rest/v1/rpc/sync_pull_library',
    'https://api.nuvio.tv/rest/v1/rpc/sync_delete_library_items'
  ]);
});
