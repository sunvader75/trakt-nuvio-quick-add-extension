/**
 * Nuvio Server API client (Supabase-compatible Auth + PostgREST RPC endpoints).
 * Handles email/password login, automatic JWT refresh, profiles, and library sync.
 */

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || 'https://api.nuvio.tv').replace(/\/+$/, '');
}

async function parseErrorPayload(response) {
  const raw = await response.text();
  if (!raw) return `HTTP ${response.status}`;
  try {
    const parsed = JSON.parse(raw);
    return (
      parsed.error_description ||
      parsed.msg ||
      parsed.message ||
      parsed.hint ||
      parsed.error ||
      `HTTP ${response.status}`
    );
  } catch {
    return raw;
  }
}

async function parseSuccessPayload(response) {
  const raw = await response.text();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function normalizeSession(payload) {
  const nowSec = Math.floor(Date.now() / 1000);
  const expiresIn = Number(payload.expires_in) || 3600;
  const expiresAt = Number(payload.expires_at) || nowSec + expiresIn;

  return {
    access_token: payload.access_token,
    refresh_token: payload.refresh_token,
    expires_in: expiresIn,
    expires_at: expiresAt,
    user: payload.user || null
  };
}

export async function signInWithPassword(
  { baseUrl, publishableKey, email, password },
  fetchImpl = globalThis.fetch
) {
  const root = normalizeBaseUrl(baseUrl);
  const response = await fetchImpl(
    `${root}/auth/v1/token?grant_type=password`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: publishableKey
      },
      body: JSON.stringify({ email, password })
    }
  );

  if (!response.ok) {
    throw new Error(await parseErrorPayload(response));
  }

  return normalizeSession(await parseSuccessPayload(response));
}

export async function refreshSession(
  { baseUrl, publishableKey, refreshToken },
  fetchImpl = globalThis.fetch
) {
  const root = normalizeBaseUrl(baseUrl);
  const response = await fetchImpl(
    `${root}/auth/v1/token?grant_type=refresh_token`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: publishableKey
      },
      body: JSON.stringify({ refresh_token: refreshToken })
    }
  );

  if (!response.ok) {
    throw new Error(await parseErrorPayload(response));
  }

  return normalizeSession(await parseSuccessPayload(response));
}

export async function ensureValidSession(
  { baseUrl, publishableKey, session },
  fetchImpl = globalThis.fetch
) {
  if (!session?.access_token) {
    throw new Error('Not signed in to Nuvio.');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const needsRefresh =
    typeof session.expires_at === 'number' && session.expires_at - nowSec < 60;

  if (!needsRefresh) {
    return session;
  }

  if (!session.refresh_token) {
    throw new Error('Nuvio session expired. Please sign in again.');
  }

  return refreshSession(
    {
      baseUrl,
      publishableKey,
      refreshToken: session.refresh_token
    },
    fetchImpl
  );
}

async function callNuvioRpc(
  {
    baseUrl,
    publishableKey,
    session,
    rpcName,
    body = {},
    onSessionRefreshed
  },
  fetchImpl = globalThis.fetch
) {
  const root = normalizeBaseUrl(baseUrl);
  let activeSession = await ensureValidSession(
    { baseUrl: root, publishableKey, session },
    fetchImpl
  );

  if (activeSession !== session && typeof onSessionRefreshed === 'function') {
    await onSessionRefreshed(activeSession);
  }

  const sendRequest = (token) =>
    fetchImpl(`${root}/rest/v1/rpc/${rpcName}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: publishableKey,
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(body)
    });

  let response = await sendRequest(activeSession.access_token);

  if (response.status === 401 && activeSession.refresh_token) {
    activeSession = await refreshSession(
      {
        baseUrl: root,
        publishableKey,
        refreshToken: activeSession.refresh_token
      },
      fetchImpl
    );
    if (typeof onSessionRefreshed === 'function') {
      await onSessionRefreshed(activeSession);
    }
    response = await sendRequest(activeSession.access_token);
  }

  if (!response.ok) {
    throw new Error(await parseErrorPayload(response));
  }

  return parseSuccessPayload(response);
}

export async function pullProfiles(ctx, fetchImpl = globalThis.fetch) {
  const data = await callNuvioRpc(
    { ...ctx, rpcName: 'sync_pull_profiles', body: {} },
    fetchImpl
  );
  return Array.isArray(data) ? data : [];
}

export async function pullLibrary(
  { limit = 500, offset = 0, profileId = 1, ...ctx },
  fetchImpl = globalThis.fetch
) {
  const data = await callNuvioRpc(
    {
      ...ctx,
      rpcName: 'sync_pull_library',
      body: {
        p_profile_id: profileId,
        p_limit: limit,
        p_offset: offset
      }
    },
    fetchImpl
  );
  return Array.isArray(data) ? data : [];
}

export async function pushLibraryItems(
  { profileId = 1, originClientId = null, items, ...ctx },
  fetchImpl = globalThis.fetch
) {
  await callNuvioRpc(
    {
      ...ctx,
      rpcName: 'sync_push_library_items',
      body: {
        p_profile_id: profileId,
        p_origin_client_id: originClientId,
        p_items: items
      }
    },
    fetchImpl
  );
  return { ok: true };
}

export async function deleteLibraryItems(
  { profileId = 1, originClientId = null, items, ...ctx },
  fetchImpl = globalThis.fetch
) {
  await callNuvioRpc(
    {
      ...ctx,
      rpcName: 'sync_delete_library_items',
      body: {
        p_profile_id: profileId,
        p_origin_client_id: originClientId,
        p_items: items
      }
    },
    fetchImpl
  );
  return { ok: true };
}
