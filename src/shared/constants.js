/**
 * Shared constants, default settings, storage keys, and runtime message types
 * for the Nuvio Quick Add browser extension.
 */

export const DEFAULT_NUVIO_BASE_URL = 'https://api.nuvio.tv';
export const DEFAULT_NUVIO_PUBLISHABLE_KEY =
  'sb_publishable_1Clq8rlTVACkdcZuqr6_AD__xUUC_EN';

export const TRAKT_WEB_URL = 'https://trakt.tv';
export const TRAKT_APP_URL = 'https://app.trakt.tv';
export const TRAKT_SIGNIN_URL = 'https://app.trakt.tv/';
export const TRAKT_BASE_URL = 'https://api.trakt.tv';
export const TRAKT_OAUTH_APP_URL = 'https://trakt.tv/oauth/applications/new';
export const TRAKT_ACTIVATE_URL = 'https://trakt.tv/activate';

export const CINEMETA_BASE_URL = 'https://v3-cinemeta.strem.io';
export const TMDB_BASE_URL = 'https://api.themoviedb.org/3';
export const TMDB_IMAGE_BASE_URL = 'https://image.tmdb.org/t/p/w500';
export const TMDB_BACKDROP_BASE_URL = 'https://image.tmdb.org/t/p/w1280';

export const SYNC_TARGETS = Object.freeze({
  TRAKT_WEB: 'trakt_web',
  TRAKT: 'trakt',
  NUVIO: 'nuvio',
  BOTH: 'both'
});

export const STORAGE_KEYS = Object.freeze({
  SESSION: 'nuvioSession',
  TRAKT_SESSION: 'traktSession',
  TRAKT_PENDING_AUTH: 'traktPendingAuth',
  TRAKT_WATCHLIST_CACHE: 'traktWatchlistCache',
  TRAKT_WEB_CACHE: 'traktWebWatchlistCache',
  TRAKT_CAPTURED_AUTH: 'traktCapturedAuth',
  SETTINGS: 'nuvioSettings',
  ORIGIN_CLIENT_ID: 'nuvioOriginClientId',
  SELECTED_PROFILE_ID: 'nuvioSelectedProfileId',
  PROFILES_CACHE: 'nuvioProfilesCache',
  LIBRARY_CACHE: 'nuvioLibraryCache',
  DISMISSED_HOSTS: 'nuvioDismissedHosts'
});

export const FLOATING_MODES = Object.freeze({
  ALL_DETECTED: 'all_detected',
  POSTERS_ONLY: 'posters_only',
  PILL_ONLY: 'pill_only',
  LETTERBOXD_ONLY: 'letterboxd_only',
  DISABLED: 'disabled'
});

export const ID_FORMATS = Object.freeze({
  IMDB: 'imdb',
  TMDB: 'tmdb'
});

export const DEFAULT_SETTINGS = Object.freeze({
  syncTarget: SYNC_TARGETS.TRAKT_WEB,
  traktClientId: '',
  traktClientSecret: '',
  baseUrl: DEFAULT_NUVIO_BASE_URL,
  publishableKey: DEFAULT_NUVIO_PUBLISHABLE_KEY,
  floatingMode: FLOATING_MODES.ALL_DETECTED,
  preferredIdFormat: ID_FORMATS.IMDB,
  tmdbApiKey: ''
});

export const MESSAGE_TYPES = Object.freeze({
  AUTH_LOGIN: 'AUTH_LOGIN',
  AUTH_LOGOUT: 'AUTH_LOGOUT',
  AUTH_STATUS: 'AUTH_STATUS',
  TRAKT_START_DEVICE_AUTH: 'TRAKT_START_DEVICE_AUTH',
  TRAKT_POLL_DEVICE_AUTH: 'TRAKT_POLL_DEVICE_AUTH',
  TRAKT_CANCEL_DEVICE_AUTH: 'TRAKT_CANCEL_DEVICE_AUTH',
  TRAKT_LOGOUT: 'TRAKT_LOGOUT',
  TRAKT_CAPTURE_AUTH: 'TRAKT_CAPTURE_AUTH',
  TRAKT_FORCE_SYNC: 'TRAKT_FORCE_SYNC',
  GET_PROFILES: 'GET_PROFILES',
  SET_PROFILE: 'SET_PROFILE',
  RESOLVE_MEDIA: 'RESOLVE_MEDIA',
  SEARCH_MEDIA: 'SEARCH_MEDIA',
  ADD_TO_NUVIO: 'ADD_TO_NUVIO',
  REMOVE_FROM_NUVIO: 'REMOVE_FROM_NUVIO',
  CHECK_IN_LIBRARY: 'CHECK_IN_LIBRARY',
  CHECK_POSTERS_IN_LIBRARY: 'CHECK_POSTERS_IN_LIBRARY',
  GET_SETTINGS: 'GET_SETTINGS',
  SAVE_SETTINGS: 'SAVE_SETTINGS',
  EXTRACT_PAGE_MEDIA: 'EXTRACT_PAGE_MEDIA',
  SHOW_TOAST: 'SHOW_TOAST',
  REFRESH_PAGE_STATUS: 'REFRESH_PAGE_STATUS'
});
