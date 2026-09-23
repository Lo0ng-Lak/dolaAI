export const AUTH_LOCK_SCRIPT = `(() => {
  if (window.__DOLA_AUTH_LOCK_BOOT) return;
  window.__DOLA_AUTH_LOCK_BOOT = true;
  window.__DOLA_REWRITE_READY = false;
  window.__DOLA_DURATION_HITS = window.__DOLA_DURATION_HITS || 0;
  window.__DOLA_HOLD_SESSION = true;
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

// Never wrap window.fetch / XHR here: Dola's own security SDK wraps them after load to
// sign every request, and calling a saved "native" function skips that signature
// (uploads fail with "!", chat returns busy / System error). DragonBMT's hooks already
// pass requests through untouched while __DOLA_REWRITE_READY is false.
export async function armFetchGate(page) {
  if (!page || page.isClosed()) return;
  await page.evaluate(AUTH_LOCK_SCRIPT).catch(() => {});
  await page
    .evaluate(() => {
      window.__DOLA_REWRITE_READY = false;
    })
    .catch(() => {});
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
