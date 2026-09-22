const DOWNLOAD_CLICK = /^\s*(fetch\s*(?:&|and)\s*download|download(?:\s+video)?|tải(?:\s+xuống|\s+video)?)\s*$/i;
const DOWNLOAD_DONE = /downloaded!?|fetch\s*&\s*download\s*done|đã\s*tải/i;
const IGNORE_CLICK = /send|submit|gửi|sign in|log in|đăng nhập|upgrade|pro|settings|share/i;

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(99, Math.max(0, Math.round(n)));
}

export async function readDolaTaskState(page, { promptHint = "" } = {}) {
  if (!page || page.isClosed()) return { percent: null, stage: "unknown", downloadReady: false, failed: false };
  return page.evaluate((hint) => {
    const body = document.body;
    if (!body) return { percent: null, stage: "unknown", downloadReady: false, failed: false };

    const hintNorm = String(hint || "")
      .toLowerCase()
      .replace(/\s+/g, " ")
      .slice(0, 48);

    const cards = [];
    const candidates = document.querySelectorAll(
      "article, [role='article'], [class*='card'], [class*='Card'], [class*='message'], [class*='Message'], [class*='video'], [class*='Video']",
    );
    const nodes = candidates.length ? [...candidates, body] : [body];

    for (const node of nodes) {
      if (!(node instanceof Element)) continue;
      const text = (node.innerText || "").replace(/\s+/g, " ").trim();
      if (!text || text.length < 8) continue;

      let percent = null;
      const bars = node.querySelectorAll("[role='progressbar'], progress, [aria-valuenow]");
      for (const bar of bars) {
        const now = Number(bar.getAttribute("aria-valuenow") || bar.value);
        const max = Number(bar.getAttribute("aria-valuemax") || 100) || 100;
        if (Number.isFinite(now) && now >= 0 && now <= max) {
          percent = Math.round((now / max) * 100);
          break;
        }
      }
      if (percent == null) {
        for (const el of node.querySelectorAll("[class*='progress'], [class*='Progress'], [style*='width']")) {
          const width = String(el.style?.width || "");
          const match = width.match(/(\d{1,3}(?:\.\d+)?)\s*%/);
          if (match) {
            const n = Number(match[1]);
            if (n >= 0 && n <= 100) {
              percent = Math.round(n);
              break;
            }
          }
        }
      }
      if (percent == null) {
        const matches = [...text.matchAll(/(\d{1,3})\s*%/g)].map((m) => Number(m[1])).filter((n) => n <= 100);
        if (matches.length) percent = matches[matches.length - 1];
      }

      const hasPlayer = [...node.querySelectorAll("video")].some((el) => {
        const src = el.currentSrc || el.src || el.querySelector("source")?.src || "";
        return Boolean(src) && el.readyState >= 1;
      });
      const hasDownload = [...node.querySelectorAll("button, a, [role='button']")].some((el) =>
        /^(fetch\s*(&|and)\s*download|download(\s+video)?|tải(\s+xuống|\s+video)?)$/i.test(
          `${el.innerText || ""} ${el.getAttribute("aria-label") || ""}`.replace(/\s+/g, " ").trim(),
        ),
      );
      const hintMatched = Boolean(hintNorm) && text.toLowerCase().includes(hintNorm.slice(0, 24));
      const failed = /unable to generate|generation failed|something went wrong|thất bại|failed to (create|generate)/i.test(text);
      const queued = /queued|in queue|đang chờ|waiting in/i.test(text);
      const generating = /đang tạo|creating video|rendering|processing video|in progress/i.test(text);
      const thisTask = hintMatched || !hintNorm;
      const isBody = node === body;
      const downloadReady =
        thisTask &&
        !isBody &&
        (hasPlayer || hasDownload || ((percent != null && percent >= 100) && /download|tải/i.test(text)));
      const done = thisTask && !isBody && (hasPlayer || hasDownload || /downloaded!?|fetch\s*&\s*download\s*done|video ready/i.test(text));

      let stage = "unknown";
      if (failed) stage = "failed";
      else if (done || (percent != null && percent >= 100 && downloadReady)) stage = "ready";
      else if (generating || (percent != null && percent > 0 && percent < 100)) stage = "generating";
      else if (queued) stage = "queued";
      else if (downloadReady) stage = "ready";

      let score = 0;
      if (hintMatched) score += 8;
      if (!thisTask && (done || downloadReady)) score -= 6;
      if (stage === "generating") score += 3;
      if (stage === "ready") score += 2;
      if (stage === "queued") score += 1;
      if (percent != null) score += 1;
      if (node === body) score -= 2;

      cards.push({ percent, stage, downloadReady: Boolean(downloadReady || done), failed, score });
    }

    cards.sort((a, b) => b.score - a.score);
    const best = cards[0] || { percent: null, stage: "unknown", downloadReady: false, failed: false };

    const pageText = (body.innerText || "").slice(0, 20000);
    if (best.stage === "unknown") {
      if (/generation failed|unable to generate|thất bại|failed to (create|generate)/i.test(pageText)) best.stage = "failed";
      else if (/queued|in queue/i.test(pageText)) best.stage = "queued";
      else if (/đang tạo video|generating video|creating video now/i.test(pageText)) best.stage = "generating";
    }
    if (best.percent == null) {
      const percents = [...pageText.matchAll(/(\d{1,3})\s*%/g)]
        .map((item) => Number(item[1]))
        .filter((value) => value >= 0 && value <= 100);
      if (percents.length) best.percent = percents[percents.length - 1];
    }

    return {
      percent: best.percent == null ? null : Math.min(100, Math.max(0, Math.round(best.percent))),
      stage: best.stage,
      downloadReady: Boolean(best.downloadReady),
      failed: best.stage === "failed" || Boolean(best.failed),
    };
  }, promptHint).catch(() => ({ percent: null, stage: "unknown", downloadReady: false, failed: false }));
}

export async function clickReadyDownloads(page) {
  if (!page || page.isClosed()) return 0;
  return page.evaluate(
    ({ clickRe, doneRe, ignoreRe }) => {
      const clickPattern = new RegExp(clickRe, "i");
      const donePattern = new RegExp(doneRe, "i");
      const ignorePattern = new RegExp(ignoreRe, "i");
      let clicked = 0;
      const nodes = [...document.querySelectorAll("button, a, [role='button'], [class*='download'], [class*='Download']")];
      for (const el of nodes) {
        if (!(el instanceof HTMLElement)) continue;
        if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
        const label = `${el.innerText || ""} ${el.getAttribute("aria-label") || ""} ${el.title || ""}`.trim();
        if (!label || donePattern.test(label) || ignorePattern.test(label)) continue;
        if (!clickPattern.test(label)) continue;
        el.click();
        clicked += 1;
        if (clicked >= 2) break;
      }
      return clicked;
    },
    {
      clickRe: DOWNLOAD_CLICK.source,
      doneRe: DOWNLOAD_DONE.source,
      ignoreRe: IGNORE_CLICK.source,
    },
  ).catch(() => 0);
}

export function mapDolaPercent(snapshot, current = 8) {
  if (snapshot?.failed) return Math.max(current, 0);
  if (snapshot?.downloadReady || snapshot?.stage === "ready") return Math.max(current, 85);
  if (snapshot?.stage === "queued") return Math.max(current, 8);
  const raw = clampPercent(snapshot?.percent);
  if (raw == null) return current;
  if (raw >= 100) return Math.max(current, 85);
  return Math.max(current, Math.min(82, raw));
}
