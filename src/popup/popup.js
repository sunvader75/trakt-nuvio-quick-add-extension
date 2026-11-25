/**
 * Popup controller for Nuvio Quick Add.
 * Supports Trakt.tv Web Session (default, zero API keys), Trakt Official API,
 * Nuvio Cloud Library, or Both.
 * Strictly uses async/await and external DOM event listeners (MV3 CSP compliant).
 */

import {
  DEFAULT_NUVIO_BASE_URL,
  DEFAULT_NUVIO_PUBLISHABLE_KEY,
  MESSAGE_TYPES,
  STORAGE_KEYS,
  SYNC_TARGETS,
  TRAKT_ACTIVATE_URL,
  TRAKT_SIGNIN_URL
} from '../shared/constants.js';
import { cleanMediaTitle } from '../shared/title-cleaner.js';

const els = {
  accountSubtitle: document.getElementById('account-subtitle'),
  profileSelect: document.getElementById('profile-select'),
  btnSettings: document.getElementById('btn-settings'),
  btnLogout: document.getElementById('btn-logout'),
  banner: document.getElementById('status-banner'),

  authView: document.getElementById('auth-view'),
  traktWebCard: document.getElementById('trakt-web-card'),
  btnOpenTraktSignin: document.getElementById('btn-open-trakt-signin'),
  btnCheckTraktWeb: document.getElementById('btn-check-trakt-web'),

  traktAuthCard: document.getElementById('trakt-auth-card'),
  traktStepCredentials: document.getElementById('trakt-step-credentials'),
  traktStartForm: document.getElementById('trakt-start-form'),
  traktClientId: document.getElementById('trakt-client-id'),
  traktClientSecret: document.getElementById('trakt-client-secret'),
  btnTraktStart: document.getElementById('btn-trakt-start'),
  traktStepCode: document.getElementById('trakt-step-code'),
  traktUserCode: document.getElementById('trakt-user-code'),
  traktPollStatus: document.getElementById('trakt-poll-status'),
  btnTraktActivate: document.getElementById('btn-trakt-activate'),
  btnTraktCancel: document.getElementById('btn-trakt-cancel'),

  nuvioAuthCard: document.getElementById('nuvio-auth-card'),
  loginForm: document.getElementById('login-form'),
  loginEmail: document.getElementById('login-email'),
  loginPassword: document.getElementById('login-password'),
  loginBaseUrl: document.getElementById('login-base-url'),
  loginPubKey: document.getElementById('login-pub-key'),
  btnLogin: document.getElementById('btn-login'),

  mainView: document.getElementById('main-view'),
  btnRescan: document.getElementById('btn-rescan'),
  detectedLoading: document.getElementById('detected-loading'),
  detectedEmpty: document.getElementById('detected-empty'),
  detectedCard: document.getElementById('detected-card'),
  detectedPoster: document.getElementById('detected-poster'),
  detectedTitle: document.getElementById('detected-title'),
  detectedMeta: document.getElementById('detected-meta'),
  detectedBadges: document.getElementById('detected-badges'),
  btnDetectedAction: document.getElementById('btn-detected-action'),

  searchForm: document.getElementById('search-form'),
  searchInput: document.getElementById('search-input'),
  searchResults: document.getElementById('search-results'),

  settingsView: document.getElementById('settings-view'),
  btnCloseSettings: document.getElementById('btn-close-settings'),
  settingsForm: document.getElementById('settings-form'),
  setSyncTarget: document.getElementById('set-sync-target'),
  setTraktClientId: document.getElementById('set-trakt-client-id'),
  setTraktClientSecret: document.getElementById('set-trakt-client-secret'),
  setFloatingMode: document.getElementById('set-floating-mode'),
  setIdFormat: document.getElementById('set-id-format'),
  setTmdbKey: document.getElementById('set-tmdb-key'),
  setBaseUrl: document.getElementById('set-base-url'),
  setPubKey: document.getElementById('set-pub-key'),
  btnRestoreSites: document.getElementById('btn-restore-sites')
};

let activeResolved = null;
let activeInLibrary = false;
let activeExistingContentId = null;
let activeSyncTarget = SYNC_TARGETS.TRAKT_WEB;
let traktPollTimer = null;
let pendingActivation = null;

function stopTraktPolling() {
  if (traktPollTimer) {
    window.clearTimeout(traktPollTimer);
    traktPollTimer = null;
  }
}

function getTargetButtonLabels(syncTarget) {
  if (syncTarget === SYNC_TARGETS.NUVIO) {
    return {
      add: '+ Add to Nuvio Library',
      remove: '✓ In Nuvio Library (Remove)',
      addedToast: 'Nuvio'
    };
  }
  if (syncTarget === SYNC_TARGETS.BOTH) {
    return {
      add: '+ Add to Trakt & Nuvio',
      remove: '✓ Saved in Both (Remove)',
      addedToast: 'Trakt & Nuvio'
    };
  }
  return {
    add: '+ Add to Trakt Watchlist',
    remove: '✓ In Trakt Watchlist (Remove)',
    addedToast: 'Trakt Watchlist'
  };
}

function showBanner(message, type = 'success') {
  if (!message) {
    els.banner.classList.add('hidden');
    els.banner.textContent = '';
    return;
  }
  els.banner.textContent = message;
  els.banner.className = `banner ${type}`;
}

function showView(view) {
  els.authView.classList.toggle('hidden', view !== 'auth');
  els.mainView.classList.toggle('hidden', view !== 'main');
  els.settingsView.classList.toggle('hidden', view !== 'settings');
}

function renderProfiles(profiles, selectedProfileId) {
  els.profileSelect.innerHTML = '';
  const list =
    Array.isArray(profiles) && profiles.length > 0
      ? profiles
      : [{ profile_index: 1, name: 'Main' }];

  for (const profile of list) {
    const opt = document.createElement('option');
    opt.value = String(profile.profile_index);
    opt.textContent = profile.name || `Profile ${profile.profile_index}`;
    if (Number(profile.profile_index) === Number(selectedProfileId)) {
      opt.selected = true;
    }
    els.profileSelect.appendChild(opt);
  }
}

async function notifyActiveTabRefresh() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await chrome.tabs.sendMessage(tab.id, {
        type: MESSAGE_TYPES.REFRESH_PAGE_STATUS
      });
    }
  } catch {
    // Active tab may not host a content script
  }
}

function updateDetectedActionButton() {
  const labels = getTargetButtonLabels(activeSyncTarget);
  if (activeInLibrary) {
    els.btnDetectedAction.textContent = labels.remove;
    els.btnDetectedAction.className = 'btn added full';
  } else {
    els.btnDetectedAction.textContent = labels.add;
    els.btnDetectedAction.className = 'btn primary full';
  }
}

function renderDetectedMedia(resolved, inLibrary, existingItem) {
  els.detectedLoading.classList.add('hidden');

  if (!resolved) {
    els.detectedCard.classList.add('hidden');
    els.detectedEmpty.classList.remove('hidden');
    return;
  }

  activeResolved = resolved;
  activeInLibrary = Boolean(inLibrary);
  activeExistingContentId = existingItem?.content_id || null;

  els.detectedEmpty.classList.add('hidden');
  els.detectedCard.classList.remove('hidden');

  els.detectedPoster.src = resolved.poster || '../../icons/icon-128.png';
  els.detectedTitle.textContent = resolved.name || 'Untitled';

  const parts = [];
  if (resolved.releaseInfo) parts.push(resolved.releaseInfo);
  parts.push(resolved.type === 'series' ? 'Series' : 'Movie');
  if (resolved.imdbRating) parts.push(`★ ${resolved.imdbRating}`);
  els.detectedMeta.textContent = parts.join(' • ');

  els.detectedBadges.innerHTML = '';
  if (resolved.imdbId) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = resolved.imdbId;
    els.detectedBadges.appendChild(b);
  }
  if (resolved.tmdbId) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = `tmdb:${resolved.tmdbId}`;
    els.detectedBadges.appendChild(b);
  }

  if (resolved.name && !els.searchInput.value) {
    els.searchInput.placeholder = `Wrong match? Search "${resolved.name}"`;
  }

  updateDetectedActionButton();
}

async function scanActiveTab() {
  els.detectedLoading.classList.remove('hidden');
  els.detectedEmpty.classList.add('hidden');
  els.detectedCard.classList.add('hidden');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    let extraction = null;

    if (tab?.id) {
      try {
        extraction = await chrome.tabs.sendMessage(tab.id, {
          type: MESSAGE_TYPES.EXTRACT_PAGE_MEDIA
        });
      } catch {
        const cleaned = cleanMediaTitle(tab.title || '');
        if (cleaned.title) {
          extraction = {
            title: cleaned.title,
            year: cleaned.year,
            type: cleaned.type,
            url: tab.url || ''
          };
        }
      }
    }

    if (!extraction || (!extraction.imdbId && !extraction.tmdbId && !extraction.title)) {
      renderDetectedMedia(null, false, null);
      return;
    }

    const res = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.RESOLVE_MEDIA,
      payload: extraction
    });

    if (!res?.ok) {
      throw new Error(res?.error || 'Could not resolve media metadata.');
    }

    renderDetectedMedia(res.resolved, res.inLibrary, res.existingItem);
  } catch (err) {
    els.detectedLoading.classList.add('hidden');
    els.detectedEmpty.classList.remove('hidden');
    showBanner(err?.message || 'Scan failed.', 'error');
  }
}

function renderSearchResults(results) {
  els.searchResults.innerHTML = '';
  const labels = getTargetButtonLabels(activeSyncTarget);

  if (!Array.isArray(results) || results.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'muted-state';
    empty.textContent = 'No matching titles found.';
    els.searchResults.appendChild(empty);
    return;
  }

  for (const item of results) {
    const row = document.createElement('div');
    row.className = 'result-item';

    const img = document.createElement('img');
    img.className = 'result-poster';
    img.src = item.poster || '../../icons/icon-48.png';
    img.alt = '';

    const body = document.createElement('div');
    body.className = 'result-body';

    const title = document.createElement('div');
    title.className = 'result-title';
    title.textContent = item.name;

    const sub = document.createElement('div');
    sub.className = 'result-sub';
    sub.textContent = [
      item.releaseInfo,
      item.type === 'series' ? 'Series' : 'Movie',
      item.imdbId || (item.tmdbId ? `tmdb:${item.tmdbId}` : '')
    ]
      .filter(Boolean)
      .join(' • ');

    body.append(title, sub);

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = item.inLibrary
      ? 'btn added result-btn'
      : 'btn primary result-btn';
    btn.textContent = item.inLibrary ? '✓ Added' : '+ Add';

    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        if (item.inLibrary) {
          const contentId =
            item.existingContentId ||
            item.imdbId ||
            (item.tmdbId ? `tmdb:${item.tmdbId}` : null);
          const del = await chrome.runtime.sendMessage({
            type: MESSAGE_TYPES.REMOVE_FROM_NUVIO,
            payload: {
              contentId,
              imdbId: item.imdbId || null,
              tmdbId: item.tmdbId || null,
              name: item.name,
              releaseInfo: item.releaseInfo || '',
              contentType: item.type
            }
          });
          if (!del?.ok) throw new Error(del?.error || 'Remove failed.');
          item.inLibrary = false;
          item.existingContentId = null;
          btn.className = 'btn primary result-btn';
          btn.textContent = '+ Add';
          showBanner(`Removed "${item.name}" from ${labels.addedToast}.`);
        } else {
          const add = await chrome.runtime.sendMessage({
            type: MESSAGE_TYPES.ADD_TO_NUVIO,
            payload: item
          });
          if (!add?.ok) throw new Error(add?.error || 'Add failed.');
          item.inLibrary = true;
          item.existingContentId = add.item?.content_id || null;
          btn.className = 'btn added result-btn';
          btn.textContent = '✓ Added';
          showBanner(
            `Added "${add.resolved?.name || item.name}" to ${labels.addedToast}!`
          );
        }
        await notifyActiveTabRefresh();
      } catch (err) {
        showBanner(err?.message || 'Action failed.', 'error');
      } finally {
        btn.disabled = false;
      }
    });

    row.append(img, body, btn);
    els.searchResults.appendChild(row);
  }
}

async function loadSettingsForm() {
  const res = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.GET_SETTINGS
  });
  const settings = res?.settings || {};
  activeSyncTarget = settings.syncTarget || SYNC_TARGETS.TRAKT_WEB;

  els.setSyncTarget.value = activeSyncTarget;
  els.setTraktClientId.value = settings.traktClientId || '';
  els.setTraktClientSecret.value = settings.traktClientSecret || '';
  els.traktClientId.value = settings.traktClientId || '';
  els.traktClientSecret.value = settings.traktClientSecret || '';

  els.setFloatingMode.value = settings.floatingMode || 'all_detected';
  els.setIdFormat.value = settings.preferredIdFormat || 'imdb';
  els.setTmdbKey.value = settings.tmdbApiKey || '';
  els.setBaseUrl.value = settings.baseUrl || DEFAULT_NUVIO_BASE_URL;
  els.setPubKey.value = settings.publishableKey || DEFAULT_NUVIO_PUBLISHABLE_KEY;
  els.loginBaseUrl.value = settings.baseUrl || DEFAULT_NUVIO_BASE_URL;
  els.loginPubKey.value = settings.publishableKey || DEFAULT_NUVIO_PUBLISHABLE_KEY;
  return settings;
}

function showTraktPendingUI(pending) {
  pendingActivation = pending;
  els.traktStepCredentials.classList.add('hidden');
  els.traktStepCode.classList.remove('hidden');
  els.traktUserCode.textContent = pending.userCode || '----';
  els.traktPollStatus.textContent = 'Waiting for activation on trakt.tv/activate…';
}

function showTraktCredentialsUI() {
  pendingActivation = null;
  stopTraktPolling();
  els.traktStepCode.classList.add('hidden');
  els.traktStepCredentials.classList.remove('hidden');
}

function scheduleTraktPoll(delaySec = 5) {
  stopTraktPolling();
  traktPollTimer = window.setTimeout(async () => {
    try {
      const res = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.TRAKT_POLL_DEVICE_AUTH
      });
      if (!res?.ok) {
        els.traktPollStatus.textContent = res?.error || 'Polling error.';
        scheduleTraktPoll(delaySec);
        return;
      }

      if (res.status === 'authorized') {
        stopTraktPolling();
        showBanner('Connected to Trakt!');
        await refreshAppState();
        await notifyActiveTabRefresh();
        return;
      }

      if (res.status === 'slow_down') {
        scheduleTraktPoll(delaySec + 5);
        return;
      }

      if (
        res.status === 'expired' ||
        res.status === 'denied' ||
        res.status === 'already_used' ||
        res.status === 'not_found'
      ) {
        showTraktCredentialsUI();
        showBanner(
          res.status === 'denied'
            ? 'Trakt authorization was denied.'
            : 'Trakt code expired. Please request a new code.',
          'error'
        );
        return;
      }

      scheduleTraktPoll(delaySec);
    } catch {
      scheduleTraktPoll(delaySec);
    }
  }, delaySec * 1000);
}

async function refreshAppState() {
  showBanner('');
  stopTraktPolling();
  const settings = await loadSettingsForm();

  const status = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.AUTH_STATUS
  });

  activeSyncTarget = status?.syncTarget || SYNC_TARGETS.TRAKT_WEB;
  const usesApiTrakt =
    activeSyncTarget === SYNC_TARGETS.TRAKT ||
    (activeSyncTarget === SYNC_TARGETS.BOTH && Boolean(settings.traktClientId));
  const usesWebTrakt =
    activeSyncTarget === SYNC_TARGETS.TRAKT_WEB ||
    (activeSyncTarget === SYNC_TARGETS.BOTH && !settings.traktClientId);
  const needsNuvio =
    activeSyncTarget === SYNC_TARGETS.NUVIO ||
    activeSyncTarget === SYNC_TARGETS.BOTH;

  const hasDisconnectableSession = Boolean(
    (usesApiTrakt && status?.traktAuthenticated) ||
      (needsNuvio && status?.nuvioAuthenticated)
  );
  els.btnLogout.classList.toggle('hidden', !hasDisconnectableSession);
  els.profileSelect.classList.toggle(
    'hidden',
    !(needsNuvio && status?.nuvioAuthenticated)
  );

  if (needsNuvio && status?.nuvioAuthenticated) {
    renderProfiles(status.profiles, status.selectedProfileId);
  }

  if (activeSyncTarget === SYNC_TARGETS.TRAKT_WEB && status?.traktWebAuthenticated) {
    els.accountSubtitle.textContent = `@${status.traktWebUser?.username || 'trakt'} • Trakt Web`;
  } else if (activeSyncTarget === SYNC_TARGETS.TRAKT && status?.traktAuthenticated) {
    els.accountSubtitle.textContent = `@${status.traktUser?.username || 'trakt'} • Trakt API`;
  } else if (activeSyncTarget === SYNC_TARGETS.NUVIO && status?.nuvioAuthenticated) {
    els.accountSubtitle.textContent = `${status.nuvioUser?.email || 'Connected'} • Nuvio`;
  } else if (status?.ready) {
    const tName =
      status.traktUser?.username || status.traktWebUser?.username || 'trakt';
    els.accountSubtitle.textContent = `@${tName} + Nuvio`;
  } else {
    els.accountSubtitle.textContent =
      activeSyncTarget === SYNC_TARGETS.NUVIO
        ? 'Sign in to Nuvio'
        : 'Sign in on trakt.tv';
  }

  if (!status?.ready) {
    showView('auth');
    const showWebCard = usesWebTrakt && !status?.traktWebAuthenticated;
    const showApiCard = usesApiTrakt && !status?.traktAuthenticated;
    const showNuvioCard = needsNuvio && !status?.nuvioAuthenticated;

    els.traktWebCard.classList.toggle('hidden', !showWebCard);
    els.traktAuthCard.classList.toggle('hidden', !showApiCard);
    els.nuvioAuthCard.classList.toggle('hidden', !showNuvioCard);

    if (showApiCard && status?.traktPendingAuth) {
      showTraktPendingUI(status.traktPendingAuth);
      const immediate = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.TRAKT_POLL_DEVICE_AUTH
      });
      if (immediate?.status === 'authorized') {
        await refreshAppState();
        return;
      }
      scheduleTraktPoll(status.traktPendingAuth.intervalSec || 5);
    } else {
      showTraktCredentialsUI();
    }
    return;
  }

  showView('main');
  await scanActiveTab();
}

els.btnOpenTraktSignin.addEventListener('click', async () => {
  await chrome.tabs.create({ url: TRAKT_SIGNIN_URL });
});

els.btnCheckTraktWeb.addEventListener('click', async () => {
  els.btnCheckTraktWeb.disabled = true;
  els.btnCheckTraktWeb.textContent = 'Checking…';
  try {
    const status = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.TRAKT_FORCE_SYNC
    });
    await refreshAppState();
    if (!status?.traktWebAuthenticated) {
      showBanner(
        status?.diagnosticHint || 'Not signed into app.trakt.tv yet in this browser.',
        'error'
      );
    } else {
      await notifyActiveTabRefresh();
    }
  } finally {
    els.btnCheckTraktWeb.disabled = false;
    els.btnCheckTraktWeb.textContent = 'I Signed In';
  }
});

els.traktStartForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  showBanner('');
  els.btnTraktStart.disabled = true;
  els.btnTraktStart.textContent = 'Requesting code…';

  try {
    const res = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.TRAKT_START_DEVICE_AUTH,
      payload: {
        clientId: els.traktClientId.value.trim(),
        clientSecret: els.traktClientSecret.value.trim()
      }
    });

    if (!res?.ok || !res.pending) {
      throw new Error(res?.error || 'Could not start Trakt device auth.');
    }

    showTraktPendingUI(res.pending);
    scheduleTraktPoll(res.pending.intervalSec || 5);
  } catch (err) {
    showBanner(err?.message || 'Trakt setup failed.', 'error');
  } finally {
    els.btnTraktStart.disabled = false;
    els.btnTraktStart.textContent = 'Connect with Trakt Code';
  }
});

els.btnTraktActivate.addEventListener('click', async () => {
  if (pendingActivation?.userCode) {
    try {
      await navigator.clipboard.writeText(pendingActivation.userCode);
    } catch {
      // Ignore clipboard failures
    }
  }
  await chrome.tabs.create({
    url: pendingActivation?.verificationUrl || TRAKT_ACTIVATE_URL
  });
});

els.btnTraktCancel.addEventListener('click', async () => {
  await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.TRAKT_CANCEL_DEVICE_AUTH
  });
  showTraktCredentialsUI();
});

els.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  showBanner('');
  els.btnLogin.disabled = true;
  els.btnLogin.textContent = 'Signing in…';

  try {
    const res = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.AUTH_LOGIN,
      payload: {
        email: els.loginEmail.value.trim(),
        password: els.loginPassword.value,
        baseUrl: els.loginBaseUrl.value.trim() || DEFAULT_NUVIO_BASE_URL,
        publishableKey:
          els.loginPubKey.value.trim() || DEFAULT_NUVIO_PUBLISHABLE_KEY
      }
    });

    if (!res?.ok) {
      throw new Error(res?.error || 'Sign-in failed.');
    }

    els.loginPassword.value = '';
    await refreshAppState();
    await notifyActiveTabRefresh();
  } catch (err) {
    showBanner(err?.message || 'Sign-in failed.', 'error');
  } finally {
    els.btnLogin.disabled = false;
    els.btnLogin.textContent = 'Sign in to Nuvio';
  }
});

els.btnLogout.addEventListener('click', async () => {
  if (
    activeSyncTarget === SYNC_TARGETS.TRAKT ||
    activeSyncTarget === SYNC_TARGETS.BOTH
  ) {
    await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.TRAKT_LOGOUT });
  }
  if (
    activeSyncTarget === SYNC_TARGETS.NUVIO ||
    activeSyncTarget === SYNC_TARGETS.BOTH
  ) {
    await chrome.runtime.sendMessage({ type: MESSAGE_TYPES.AUTH_LOGOUT });
  }
  await refreshAppState();
  await notifyActiveTabRefresh();
});

els.profileSelect.addEventListener('change', async () => {
  const profileId = Number(els.profileSelect.value) || 1;
  await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.SET_PROFILE,
    payload: { profileId }
  });
  await scanActiveTab();
  await notifyActiveTabRefresh();
});

els.btnRescan.addEventListener('click', async () => {
  showBanner('');
  await scanActiveTab();
});

els.btnDetectedAction.addEventListener('click', async () => {
  if (!activeResolved) return;
  els.btnDetectedAction.disabled = true;
  showBanner('');
  const labels = getTargetButtonLabels(activeSyncTarget);

  try {
    if (activeInLibrary) {
      const contentId =
        activeExistingContentId ||
        activeResolved.imdbId ||
        (activeResolved.tmdbId ? `tmdb:${activeResolved.tmdbId}` : null);
      const res = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.REMOVE_FROM_NUVIO,
        payload: {
          contentId,
          imdbId: activeResolved.imdbId || null,
          tmdbId: activeResolved.tmdbId || null,
          name: activeResolved.name,
          releaseInfo: activeResolved.releaseInfo || '',
          contentType: activeResolved.type
        }
      });
      if (!res?.ok) throw new Error(res?.error || 'Could not remove item.');
      activeInLibrary = false;
      activeExistingContentId = null;
      showBanner(`Removed "${activeResolved.name}" from ${labels.addedToast}.`);
    } else {
      const res = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.ADD_TO_NUVIO,
        payload: activeResolved
      });
      if (!res?.ok) throw new Error(res?.error || 'Could not add item.');
      activeResolved = res.resolved;
      activeInLibrary = true;
      activeExistingContentId = res.item?.content_id || null;
      showBanner(`Added "${activeResolved.name}" to ${labels.addedToast}!`);
    }
    updateDetectedActionButton();
    await notifyActiveTabRefresh();
  } catch (err) {
    showBanner(err?.message || 'Action failed.', 'error');
  } finally {
    els.btnDetectedAction.disabled = false;
  }
});

els.searchForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const query = els.searchInput.value.trim();
  if (!query) return;
  showBanner('');
  els.searchResults.innerHTML = '<p class="muted-state">Searching…</p>';

  try {
    const res = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.SEARCH_MEDIA,
      payload: { query }
    });
    if (!res?.ok) throw new Error(res?.error || 'Search failed.');
    renderSearchResults(res.results);
  } catch (err) {
    els.searchResults.innerHTML = '';
    showBanner(err?.message || 'Search failed.', 'error');
  }
});

els.btnSettings.addEventListener('click', async () => {
  showBanner('');
  stopTraktPolling();
  await loadSettingsForm();
  showView('settings');
});

els.btnCloseSettings.addEventListener('click', async () => {
  showBanner('');
  await refreshAppState();
});

els.settingsForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const res = await chrome.runtime.sendMessage({
    type: MESSAGE_TYPES.SAVE_SETTINGS,
    payload: {
      syncTarget: els.setSyncTarget.value,
      traktClientId: els.setTraktClientId.value.trim(),
      traktClientSecret: els.setTraktClientSecret.value.trim(),
      floatingMode: els.setFloatingMode.value,
      preferredIdFormat: els.setIdFormat.value,
      tmdbApiKey: els.setTmdbKey.value.trim(),
      baseUrl: els.setBaseUrl.value.trim() || DEFAULT_NUVIO_BASE_URL,
      publishableKey:
        els.setPubKey.value.trim() || DEFAULT_NUVIO_PUBLISHABLE_KEY
    }
  });
  if (res?.ok) {
    await notifyActiveTabRefresh();
    await refreshAppState();
    showBanner('Settings saved.');
  } else {
    showBanner(res?.error || 'Failed to save settings.', 'error');
  }
});

els.btnRestoreSites.addEventListener('click', async () => {
  await chrome.storage.local.remove(STORAGE_KEYS.DISMISSED_HOSTS);
  showBanner('Restored floating buttons on all previously dismissed sites.');
  await notifyActiveTabRefresh();
});

document.addEventListener('DOMContentLoaded', () => {
  refreshAppState();
});
