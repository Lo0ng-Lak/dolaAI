export const AUTH_LOCK_SCRIPT = `(() => {
  if (window.__DOLA_AUTH_LOCK_BOOT) return;
  window.__DOLA_AUTH_LOCK_BOOT = true;
  window.__DOLA_REWRITE_READY = false;
  window.__DOLA_DURATION_HITS = window.__DOLA_DURATION_HITS || 0;
  window.__DOLA_HOLD_SESSION = true;
  window.__DOLA_NATIVE_FETCH = window.fetch.bind(window);
  window.__DOLA_NATIVE_XHR_SEND = XMLHttpRequest.prototype.send;
})();`;

export const FETCH_GATE_SCRIPT = `(() => {
  if (window.__DOLA_FETCH_GATED) return;
  window.__DOLA_FETCH_GATED = true;
  window.__DOLA_REWRITE_READY = window.__DOLA_REWRITE_READY === true;
  const nativeFetch = window.__DOLA_NATIVE_FETCH || window.fetch.bind(window);
  const hookedFetch = window.fetch;
  window.fetch = function () {
    if (!window.__DOLA_REWRITE_READY) return nativeFetch.apply(this, arguments);
    return hookedFetch.apply(this, arguments);
  };
  const nativeXhr = window.__DOLA_NATIVE_XHR_SEND || XMLHttpRequest.prototype.send;
  const hookedXhr = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    if (!window.__DOLA_REWRITE_READY) return nativeXhr.apply(this, arguments);
    return hookedXhr.apply(this, arguments);
  };
})();`;

export async function attachAuthLock(context) {
  if (!context || context._authLock) return;
  await context.addInitScript(AUTH_LOCK_SCRIPT);
  context._authLock = true;
  for (const page of context.pages()) {
    if (page.isClosed()) continue;
    await page.evaluate(AUTH_LOCK_SCRIPT).catch(() => {});
  }
}

export async function armFetchGate(page) {
  if (!page || page.isClosed()) return;
  await page.evaluate(AUTH_LOCK_SCRIPT).catch(() => {});
  await page.evaluate(FETCH_GATE_SCRIPT).catch(() => {});
  await page.evaluate(() => {
    window.__DOLA_REWRITE_READY = false;
  }).catch(() => {});
}

export async function snapshotSession(page, context) {
  const cookies = await context.cookies().catch(() => []);
  return { cookies, url: page.url() };
}

export async function restoreSession(page, context, snap) {
  if (!snap?.cookies?.length) return false;
  await context.addCookies(snap.cookies).catch(() => {});
  return true;
}
