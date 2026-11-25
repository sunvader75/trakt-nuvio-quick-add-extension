/**
 * Isolated-world relay on app.trakt.tv, og.trakt.tv, and trakt.tv that forwards
 * Trakt session headers and SSR auth state captured by trakt-page-hook.js to the service worker.
 */
window.addEventListener('message', async (event) => {
  if (event.source !== window || event.origin !== window.location.origin) {
    return;
  }
  const data = event.data;
  if (!data || data.source !== 'nuvio-trakt-auth-hook') return;
  if (!data.accessToken && !data.clientId && !data.authenticated) return;

  try {
    await chrome.runtime.sendMessage({
      type: 'TRAKT_CAPTURE_AUTH',
      payload: {
        accessToken: data.accessToken || null,
        clientId: data.clientId || null,
        username: data.username || null,
        slug: data.slug || null,
        authenticated: Boolean(data.authenticated)
      }
    });
  } catch {
    // Extension context invalidated during reload
  }
});
