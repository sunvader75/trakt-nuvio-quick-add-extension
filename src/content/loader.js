/**
 * Content script bootstrapper that loads the ES module content app in MV3.
 */
(async () => {
  try {
    await import(chrome.runtime.getURL('src/content/content-app.js'));
  } catch (err) {
    console.warn('[Nuvio Quick Add] Failed to initialize content script:', err);
  }
})();
