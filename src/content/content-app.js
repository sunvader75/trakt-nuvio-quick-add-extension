/**
 * In-page Nuvio Quick Add controller:
 * - Extracts page movie/series metadata
 * - Injects quick-add overlay buttons directly onto movie/series poster cards
 * - Injects a native-styled Letterboxd sidebar action on film pages
 * - Renders an isolated Shadow DOM floating pill on detected single movie/download pages
 * - Displays Shadow DOM toast confirmations for context-menu & poster actions
 */

import {
  DEFAULT_SETTINGS,
  FLOATING_MODES,
  MESSAGE_TYPES,
  STORAGE_KEYS,
  SYNC_TARGETS
} from '../shared/constants.js';
import { extractMediaFromDocument } from '../shared/extractor.js';
import { findMoviePosterCards } from '../shared/poster-detector.js';

const HOST_ID = 'nuvio-quick-add-root';
const LETTERBOXD_ITEM_ID = 'nuvio-letterboxd-action-item';
const POSTER_STYLE_ID = 'nuvio-poster-overlay-style';
const POSTER_BTN_CLASS = 'nuvio-poster-add-btn';
const POSTER_STATE_MAP = new WeakMap();

let shadowRootRef = null;
let currentExtraction = null;
let currentResolved = null;
let currentInLibrary = false;
let currentExistingContentId = null;
let currentSyncTarget = SYNC_TARGETS.TRAKT_WEB;
let lastHref = location.href;
let rescanTimer = null;

function getUiLabels(syncTarget) {
  if (syncTarget === SYNC_TARGETS.NUVIO) {
    return {
      targetName: 'Nuvio',
      shortLabel: 'Nuvio',
      addShort: '+ Add to Nuvio',
      addedShort: '✓ In Nuvio',
      addFull: '+ Add to Nuvio Library',
      addedFull: '✓ In Nuvio Library',
      subPrompt: 'Detected for Nuvio'
    };
  }
  if (syncTarget === SYNC_TARGETS.BOTH) {
    return {
      targetName: 'Trakt & Nuvio',
      shortLabel: 'Both',
      addShort: '+ Trakt & Nuvio',
      addedShort: '✓ In Both',
      addFull: '+ Add to Trakt & Nuvio',
      addedFull: '✓ Saved in Both',
      subPrompt: 'Detected for Trakt & Nuvio'
    };
  }
  return {
    targetName: 'Trakt Watchlist',
    shortLabel: 'Trakt',
    addShort: '+ Add to Trakt',
    addedShort: '✓ In Trakt',
    addFull: '+ Add to Trakt Watchlist',
    addedFull: '✓ In Trakt Watchlist',
    subPrompt: 'Detected for Trakt → Nuvio'
  };
}

function ensurePosterOverlayStyles() {
  if (document.getElementById(POSTER_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = POSTER_STYLE_ID;
  style.textContent = `
    .${POSTER_BTN_CLASS} {
      position: absolute;
      top: 7px;
      right: 7px;
      z-index: 2147483000;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      height: 26px;
      padding: 0 8px;
      border: 1px solid rgba(124, 92, 255, 0.55);
      border-radius: 999px;
      background: rgba(12, 14, 22, 0.88);
      backdrop-filter: blur(6px);
      color: #ffffff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 11px;
      font-weight: 700;
      line-height: 1;
      cursor: pointer;
      box-shadow: 0 4px 12px rgba(0, 0, 0, 0.45);
      opacity: 0.92;
      transition: transform 0.12s ease, background 0.15s ease, opacity 0.15s ease;
    }
    .${POSTER_BTN_CLASS}:hover:not(:disabled) {
      opacity: 1;
      transform: scale(1.05);
      background: rgba(91, 61, 245, 0.95);
      border-color: rgba(196, 181, 253, 0.85);
    }
    .${POSTER_BTN_CLASS}.added {
      background: rgba(22, 163, 74, 0.94);
      border-color: rgba(134, 239, 172, 0.75);
    }
    .${POSTER_BTN_CLASS}:disabled {
      opacity: 0.7;
      cursor: wait;
    }
  `;
  (document.head || document.documentElement).appendChild(style);
}

function ensureShadowRoot() {
  let host = document.getElementById(HOST_ID);
  if (host && shadowRootRef) return shadowRootRef;

  host = document.createElement('div');
  host.id = HOST_ID;
  host.style.all = 'initial';
  shadowRootRef = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = `
    :host {
      all: initial;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    .nuvio-pill-wrap {
      position: fixed;
      right: 18px;
      bottom: 18px;
      z-index: 2147483645;
      display: flex;
      align-items: center;
      gap: 8px;
      background: rgba(15, 17, 26, 0.94);
      backdrop-filter: blur(12px);
      color: #f4f5f8;
      border: 1px solid rgba(124, 92, 255, 0.42);
      border-radius: 999px;
      padding: 6px 8px 6px 12px;
      box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
      font-size: 13px;
      line-height: 1.2;
      max-width: min(360px, calc(100vw - 32px));
    }
    .nuvio-pill-meta {
      display: flex;
      flex-direction: column;
      min-width: 0;
      margin-right: 4px;
    }
    .nuvio-pill-title {
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 170px;
      color: #ffffff;
    }
    .nuvio-pill-sub {
      font-size: 11px;
      color: #a5acc4;
    }
    .nuvio-btn {
      appearance: none;
      border: none;
      border-radius: 999px;
      padding: 7px 12px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      background: linear-gradient(135deg, #7c5cff 0%, #5b3df5 100%);
      color: #ffffff;
      white-space: nowrap;
      transition: transform 0.12s ease, opacity 0.12s ease, background 0.15s ease;
    }
    .nuvio-btn:hover:not(:disabled) {
      transform: translateY(-1px);
    }
    .nuvio-btn:disabled {
      opacity: 0.7;
      cursor: wait;
    }
    .nuvio-btn.added {
      background: linear-gradient(135deg, #16a34a 0%, #15803d 100%);
    }
    .nuvio-dismiss {
      appearance: none;
      border: none;
      background: transparent;
      color: #8f96ad;
      cursor: pointer;
      font-size: 15px;
      line-height: 1;
      padding: 4px 6px;
      border-radius: 50%;
    }
    .nuvio-dismiss:hover {
      color: #ffffff;
      background: rgba(255, 255, 255, 0.08);
    }
    .nuvio-toast {
      position: fixed;
      top: 18px;
      right: 18px;
      z-index: 2147483646;
      display: flex;
      align-items: center;
      gap: 10px;
      min-width: 240px;
      max-width: 340px;
      padding: 10px 14px;
      border-radius: 12px;
      background: rgba(15, 17, 26, 0.96);
      color: #f4f5f8;
      border: 1px solid rgba(124, 92, 255, 0.45);
      box-shadow: 0 12px 30px rgba(0, 0, 0, 0.5);
      font-size: 13px;
    }
    .nuvio-toast.error {
      border-color: rgba(220, 38, 38, 0.7);
    }
    .nuvio-toast-poster {
      width: 32px;
      height: 48px;
      object-fit: cover;
      border-radius: 6px;
      flex-shrink: 0;
      background: #1f2335;
    }
    .nuvio-toast-body {
      display: flex;
      flex-direction: column;
      gap: 2px;
      min-width: 0;
    }
    .nuvio-toast-title {
      font-weight: 700;
      font-size: 12px;
      color: #c4b5fd;
    }
    .nuvio-toast.error .nuvio-toast-title {
      color: #fca5a5;
    }
    .nuvio-toast-msg {
      color: #ffffff;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  `;

  shadowRootRef.appendChild(style);
  const targetParent = document.body || document.documentElement;
  targetParent.appendChild(host);
  return shadowRootRef;
}

function showToast({ status = 'success', title = 'Nuvio Quick Add', message = '', poster = '' }) {
  requestAnimationFrame(() => {
    const root = ensureShadowRoot();
    const existing = root.querySelector('.nuvio-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `nuvio-toast ${status === 'error' ? 'error' : ''}`;

    if (poster) {
      const img = document.createElement('img');
      img.className = 'nuvio-toast-poster';
      img.src = poster;
      img.alt = '';
      toast.appendChild(img);
    }

    const body = document.createElement('div');
    body.className = 'nuvio-toast-body';

    const titleEl = document.createElement('div');
    titleEl.className = 'nuvio-toast-title';
    titleEl.textContent = title;

    const msgEl = document.createElement('div');
    msgEl.className = 'nuvio-toast-msg';
    msgEl.textContent = message;

    body.append(titleEl, msgEl);
    toast.appendChild(body);
    root.appendChild(toast);

    window.setTimeout(() => {
      toast.remove();
    }, 3600);
  });
}

async function getExtensionPreferences() {
  const data = await chrome.storage.local.get([
    STORAGE_KEYS.SETTINGS,
    STORAGE_KEYS.DISMISSED_HOSTS
  ]);
  const settings = { ...DEFAULT_SETTINGS, ...(data[STORAGE_KEYS.SETTINGS] || {}) };
  const dismissedHosts = data[STORAGE_KEYS.DISMISSED_HOSTS] || {};
  currentSyncTarget = settings.syncTarget || SYNC_TARGETS.TRAKT_WEB;
  return { settings, dismissedHosts };
}

async function toggleLibraryAction(triggerButton) {
  if (!currentExtraction) return;
  if (triggerButton) triggerButton.disabled = true;

  const labels = getUiLabels(currentSyncTarget);

  try {
    if (
      currentInLibrary &&
      (currentExistingContentId || currentResolved?.imdbId || currentExtraction.imdbId || currentExtraction.title)
    ) {
      const contentId =
        currentExistingContentId ||
        currentResolved?.imdbId ||
        currentExtraction.imdbId ||
        (currentResolved?.tmdbId ? `tmdb:${currentResolved.tmdbId}` : null);

      const res = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.REMOVE_FROM_NUVIO,
        payload: {
          contentId,
          imdbId: currentResolved?.imdbId || currentExtraction.imdbId || null,
          tmdbId: currentResolved?.tmdbId || currentExtraction.tmdbId || null,
          name: currentResolved?.name || currentExtraction.title || '',
          releaseInfo: currentResolved?.releaseInfo || currentExtraction.year || '',
          contentType: currentResolved?.type || currentExtraction.type || 'movie'
        }
      });

      if (!res?.ok) throw new Error(res?.error || 'Could not remove item.');

      currentInLibrary = false;
      currentExistingContentId = null;
      showToast({
        status: 'success',
        title: `Removed from ${labels.targetName}`,
        message: currentResolved?.name || currentExtraction.title
      });
    } else {
      const res = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.ADD_TO_NUVIO,
        payload: currentResolved || currentExtraction
      });

      if (!res?.ok) throw new Error(res?.error || 'Could not add item.');

      currentResolved = res.resolved;
      currentInLibrary = true;
      currentExistingContentId = res.item?.content_id || null;
      showToast({
        status: 'success',
        title: `Added to ${labels.targetName}`,
        message: res.resolved?.releaseInfo
          ? `${res.resolved.name} (${res.resolved.releaseInfo})`
          : res.resolved?.name || currentExtraction.title,
        poster: res.resolved?.poster || currentExtraction.poster || ''
      });
    }
  } catch (err) {
    showToast({
      status: 'error',
      title: 'Nuvio Quick Add',
      message: err?.message || 'Action failed.'
    });
  } finally {
    if (triggerButton) triggerButton.disabled = false;
    renderLetterboxdButton();
    await renderFloatingPill();
  }
}

function updatePosterButtonVisual(btn, inLibrary, labels) {
  btn.className = inLibrary ? `${POSTER_BTN_CLASS} added` : POSTER_BTN_CLASS;
  btn.textContent = inLibrary ? `✓ ${labels.shortLabel}` : `+ ${labels.shortLabel}`;
  btn.title = inLibrary
    ? `In ${labels.targetName} (click to remove)`
    : `Add to ${labels.targetName}`;
}

async function handlePosterButtonClick(event, card, btn) {
  event.preventDefault();
  event.stopPropagation();

  const state = POSTER_STATE_MAP.get(card.element) || {
    inLibrary: false,
    existingContentId: null,
    resolved: null
  };
  const labels = getUiLabels(currentSyncTarget);

  btn.disabled = true;
  btn.textContent = '…';

  try {
    if (state.inLibrary) {
      const res = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.REMOVE_FROM_NUVIO,
        payload: {
          contentId: state.existingContentId || state.resolved?.imdbId || card.imdbId,
          imdbId: state.resolved?.imdbId || card.imdbId || null,
          tmdbId: state.resolved?.tmdbId || card.tmdbId || null,
          name: state.resolved?.name || card.title,
          releaseInfo: state.resolved?.releaseInfo || card.year || '',
          contentType: state.resolved?.type || card.type || 'movie'
        }
      });
      if (!res?.ok) throw new Error(res?.error || 'Could not remove item.');
      state.inLibrary = false;
      state.existingContentId = null;
      POSTER_STATE_MAP.set(card.element, state);
      showToast({
        status: 'success',
        title: `Removed from ${labels.targetName}`,
        message: state.resolved?.name || card.title,
        poster: state.resolved?.poster || card.poster || ''
      });
    } else {
      const res = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.ADD_TO_NUVIO,
        payload: {
          imdbId: card.imdbId,
          tmdbId: card.tmdbId,
          type: card.type,
          title: card.title,
          year: card.year,
          poster: card.poster
        }
      });
      if (!res?.ok) throw new Error(res?.error || 'Could not add item.');
      state.inLibrary = true;
      state.resolved = res.resolved;
      state.existingContentId = res.item?.content_id || null;
      POSTER_STATE_MAP.set(card.element, state);
      showToast({
        status: 'success',
        title: `Added to ${labels.targetName}`,
        message: res.resolved?.releaseInfo
          ? `${res.resolved.name} (${res.resolved.releaseInfo})`
          : res.resolved?.name || card.title,
        poster: res.resolved?.poster || card.poster || ''
      });
    }
  } catch (err) {
    showToast({
      status: 'error',
      title: 'Nuvio Quick Add',
      message: err?.message || 'Action failed.'
    });
  } finally {
    btn.disabled = false;
    updatePosterButtonVisual(btn, state.inLibrary, labels);
  }
}

async function renderPosterOverlays(settings, dismissedHosts) {
  const mode = settings.floatingMode || FLOATING_MODES.ALL_DETECTED;
  const host = location.hostname;
  const postersEnabled =
    !dismissedHosts[host] &&
    (mode === FLOATING_MODES.ALL_DETECTED ||
      mode === FLOATING_MODES.POSTERS_ONLY ||
      (mode === FLOATING_MODES.LETTERBOXD_ONLY && /letterboxd\.com/i.test(host)));

  if (!postersEnabled) {
    requestAnimationFrame(() => {
      for (const btn of document.querySelectorAll(`.${POSTER_BTN_CLASS}`)) {
        btn.remove();
      }
    });
    return;
  }

  const cards = findMoviePosterCards(document, location.href);
  if (cards.length === 0) return;

  let statusMap = {};
  try {
    const check = await chrome.runtime.sendMessage({
      type: MESSAGE_TYPES.CHECK_POSTERS_IN_LIBRARY,
      payload: {
        cards: cards.map((c) => ({
          key: c.key,
          imdbId: c.imdbId,
          tmdbId: c.tmdbId,
          type: c.type,
          title: c.title,
          year: c.year
        }))
      }
    });
    if (check?.ok && check.map) {
      statusMap = check.map;
    }
  } catch {
    // Ignore transient messaging errors
  }

  ensurePosterOverlayStyles();
  const labels = getUiLabels(settings.syncTarget);
  const BATCH = 20;

  for (let i = 0; i < cards.length; i += BATCH) {
    const slice = cards.slice(i, i + BATCH);
    await new Promise((resolve) =>
      requestAnimationFrame(() => {
        for (const card of slice) {
          const el = card.element;
          if (!el || !el.isConnected) continue;

          const computedPos = window.getComputedStyle(el).position;
          if (computedPos === 'static') {
            el.style.position = 'relative';
          }

          let btn = el.querySelector(`:scope > .${POSTER_BTN_CLASS}`);
          const match = statusMap[card.key];
          const prev = POSTER_STATE_MAP.get(el) || {};
          const inLibrary = Boolean(match?.inLibrary ?? prev.inLibrary);
          POSTER_STATE_MAP.set(el, {
            ...prev,
            inLibrary,
            existingContentId: match?.existingItem?.content_id || prev.existingContentId || null
          });

          if (!btn) {
            btn = document.createElement('button');
            btn.type = 'button';
            btn.addEventListener('click', (event) =>
              handlePosterButtonClick(event, card, btn)
            );
            el.appendChild(btn);
          }

          updatePosterButtonVisual(btn, inLibrary, labels);
        }
        resolve();
      })
    );
    if (globalThis.scheduler?.yield) {
      await scheduler.yield();
    }
  }
}

function renderLetterboxdButton() {
  if (!currentExtraction || currentExtraction.source !== 'letterboxd') return;
  const panel = document.querySelector('ul.js-actions-panel, .js-actions-panel');
  if (!panel) return;

  const labels = getUiLabels(currentSyncTarget);

  requestAnimationFrame(() => {
    let item = document.getElementById(LETTERBOXD_ITEM_ID);
    if (!item) {
      item = document.createElement('li');
      item.id = LETTERBOXD_ITEM_ID;
      item.style.cssText = 'list-style:none;';
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.style.cssText = [
        'width:100%',
        'display:flex',
        'align-items:center',
        'justify-content:center',
        'gap:6px',
        'padding:10px 12px',
        'border:none',
        'border-top:1px solid rgba(255,255,255,0.08)',
        'background:transparent',
        'color:#def',
        'font-size:13px',
        'font-weight:600',
        'cursor:pointer',
        'letter-spacing:0.02em'
      ].join(';');
      btn.addEventListener('click', () => toggleLibraryAction(btn));
      item.appendChild(btn);
      panel.appendChild(item);
    }

    const btn = item.querySelector('button');
    if (btn) {
      btn.textContent = currentInLibrary ? labels.addedFull : labels.addFull;
      btn.style.color = currentInLibrary ? '#4ade80' : '#c4b5fd';
    }
  });
}

async function renderFloatingPill() {
  const { settings, dismissedHosts } = await getExtensionPreferences();
  const host = location.hostname;
  const labels = getUiLabels(settings.syncTarget);
  const mode = settings.floatingMode || FLOATING_MODES.ALL_DETECTED;

  const pillAllowedByMode =
    mode === FLOATING_MODES.ALL_DETECTED ||
    mode === FLOATING_MODES.PILL_ONLY ||
    (mode === FLOATING_MODES.LETTERBOXD_ONLY &&
      currentExtraction?.source === 'letterboxd');

  const shouldShow =
    currentExtraction?.isMoviePage &&
    pillAllowedByMode &&
    !dismissedHosts[host];

  requestAnimationFrame(() => {
    const existingHost = document.getElementById(HOST_ID);
    if (!shouldShow) {
      const pill = shadowRootRef?.querySelector('.nuvio-pill-wrap');
      if (pill) pill.remove();
      return;
    }

    if (
      currentExtraction.source === 'letterboxd' &&
      document.getElementById(LETTERBOXD_ITEM_ID)
    ) {
      const pill = existingHost?.shadowRoot?.querySelector('.nuvio-pill-wrap');
      if (pill) pill.remove();
      return;
    }

    const root = ensureShadowRoot();
    let wrap = root.querySelector('.nuvio-pill-wrap');
    if (!wrap) {
      wrap = document.createElement('div');
      wrap.className = 'nuvio-pill-wrap';

      const meta = document.createElement('div');
      meta.className = 'nuvio-pill-meta';

      const titleEl = document.createElement('span');
      titleEl.className = 'nuvio-pill-title';

      const subEl = document.createElement('span');
      subEl.className = 'nuvio-pill-sub';

      meta.append(titleEl, subEl);

      const actionBtn = document.createElement('button');
      actionBtn.type = 'button';
      actionBtn.className = 'nuvio-btn';
      actionBtn.addEventListener('click', () => toggleLibraryAction(actionBtn));

      const dismissBtn = document.createElement('button');
      dismissBtn.type = 'button';
      dismissBtn.className = 'nuvio-dismiss';
      dismissBtn.title = `Hide floating buttons on ${host}`;
      dismissBtn.textContent = '×';
      dismissBtn.addEventListener('click', async () => {
        const stored = await chrome.storage.local.get(STORAGE_KEYS.DISMISSED_HOSTS);
        const map = stored[STORAGE_KEYS.DISMISSED_HOSTS] || {};
        map[host] = true;
        await chrome.storage.local.set({ [STORAGE_KEYS.DISMISSED_HOSTS]: map });
        wrap.remove();
        for (const btn of document.querySelectorAll(`.${POSTER_BTN_CLASS}`)) {
          btn.remove();
        }
      });

      wrap.append(meta, actionBtn, dismissBtn);
      root.appendChild(wrap);
    }

    const titleEl = wrap.querySelector('.nuvio-pill-title');
    const subEl = wrap.querySelector('.nuvio-pill-sub');
    const actionBtn = wrap.querySelector('.nuvio-btn');

    const displayTitle = currentResolved?.name || currentExtraction.title || 'Movie';
    const displayYear = currentResolved?.releaseInfo || currentExtraction.year || '';
    titleEl.textContent = displayTitle;
    subEl.textContent = displayYear
      ? `${displayYear} • ${currentExtraction.type === 'series' ? 'Series' : 'Movie'}`
      : labels.subPrompt;

    actionBtn.textContent = currentInLibrary ? labels.addedShort : labels.addShort;
    actionBtn.className = currentInLibrary ? 'nuvio-btn added' : 'nuvio-btn';
  });
}

async function scanAndSyncPage() {
  const { settings, dismissedHosts } = await getExtensionPreferences();
  currentExtraction = extractMediaFromDocument(document, location.href);
  currentResolved = null;
  currentInLibrary = false;
  currentExistingContentId = null;

  if (currentExtraction.isMoviePage) {
    try {
      const check = await chrome.runtime.sendMessage({
        type: MESSAGE_TYPES.CHECK_IN_LIBRARY,
        payload: currentExtraction
      });
      if (check?.ok) {
        currentInLibrary = Boolean(check.inLibrary);
        currentExistingContentId = check.existingItem?.content_id || null;
      }
    } catch {
      // Ignore transient messaging errors during page unload
    }

    renderLetterboxdButton();
  }

  await renderFloatingPill();
  await renderPosterOverlays(settings, dismissedHosts);
}

function scheduleRescan() {
  if (rescanTimer) window.clearTimeout(rescanTimer);
  rescanTimer = window.setTimeout(() => {
    scanAndSyncPage();
  }, 400);
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === MESSAGE_TYPES.EXTRACT_PAGE_MEDIA) {
    const extracted = extractMediaFromDocument(document, location.href);
    sendResponse(extracted);
    return false;
  }

  if (message?.type === MESSAGE_TYPES.SHOW_TOAST) {
    showToast(message.payload || {});
    sendResponse({ ok: true });
    return false;
  }

  if (message?.type === MESSAGE_TYPES.REFRESH_PAGE_STATUS) {
    scanAndSyncPage();
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

const observer = new MutationObserver((mutations) => {
  if (location.href !== lastHref) {
    lastHref = location.href;
    scheduleRescan();
    return;
  }

  if (
    currentExtraction?.source === 'letterboxd' &&
    !document.getElementById(LETTERBOXD_ITEM_ID) &&
    document.querySelector('ul.js-actions-panel, .js-actions-panel')
  ) {
    renderLetterboxdButton();
  }

  const addedImages = mutations.some((m) =>
    Array.from(m.addedNodes || []).some(
      (n) =>
        n.nodeType === 1 &&
        !n.classList?.contains(POSTER_BTN_CLASS) &&
        (n.tagName === 'IMG' || n.querySelector?.('img'))
    )
  );
  if (addedImages) {
    scheduleRescan();
  }
});

if (document.body) {
  observer.observe(document.body, { childList: true, subtree: true });
}

scanAndSyncPage();
