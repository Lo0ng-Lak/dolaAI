import axios from "axios";
import sharp from "sharp";

const CAPTCHA_FRAME_URL = "captcha.uvfuns.com";
const CAPTCHA_VERBOSE = process.env.CAPTCHA_VERBOSE === "true";
const CAPTCHA_MAX_CANDIDATES = Number(process.env.CAPTCHA_MAX_CANDIDATES || 8);
const CAPTCHA_DRAG_WAIT_MS = Number(process.env.CAPTCHA_DRAG_WAIT_MS || 1200);
const CAPTCHA_DRAG_POLL_MS = Number(process.env.CAPTCHA_DRAG_POLL_MS || 300);

async function downloadImage(url) {
  const { data } = await axios.get(url, {
    responseType: "arraybuffer",
    timeout: 30000,
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
      Referer: "https://captcha.uvfuns.com/",
    },
  });
  return Buffer.from(data);
}

async function loadRgba(buffer) {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function luma(data, idx) {
  return 0.299 * data[idx] + 0.587 * data[idx + 1] + 0.114 * data[idx + 2];
}

/** Bounding box phần puzzle thật (bỏ viền trong suốt) */
function getOpaqueBounds(cut, alphaMin = 40) {
  let minX = cut.width;
  let minY = cut.height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < cut.height; y++) {
    for (let x = 0; x < cut.width; x++) {
      const a = cut.data[(y * cut.width + x) * 4 + 3];
      if (a < alphaMin) continue;
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < 0) {
    return { minX: 0, minY: 0, maxX: cut.width - 1, maxY: cut.height - 1, width: cut.width, height: cut.height };
  }

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

/** Edge map Sobel đơn giản (Float32) */
function buildEdgeMap(img) {
  const { data, width, height } = img;
  const gray = new Float32Array(width * height);
  for (let i = 0, p = 0; i < gray.length; i++, p += 4) {
    gray[i] = luma(data, p);
  }

  const edges = new Float32Array(width * height);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      const gx =
        -gray[i - width - 1] +
        gray[i - width + 1] -
        2 * gray[i - 1] +
        2 * gray[i + 1] -
        gray[i + width - 1] +
        gray[i + width + 1];
      const gy =
        -gray[i - width - 1] -
        2 * gray[i - width] -
        gray[i - width + 1] +
        gray[i + width - 1] +
        2 * gray[i + width] +
        gray[i + width + 1];
      edges[i] = Math.hypot(gx, gy);
    }
  }
  return edges;
}

/** Pixel nằm trên viền silhouette (có alpha nhưng có lân cận trong suốt) */
function isContourPixel(cut, x, y, alphaMin = 40) {
  const a = cut.data[(y * cut.width + x) * 4 + 3];
  if (a < alphaMin) return false;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= cut.width || ny >= cut.height) return true;
      if (cut.data[(ny * cut.width + nx) * 4 + 3] < alphaMin) return true;
    }
  }
  return false;
}

/**
 * Match miếng cắt lên lỗ trên nền.
 * Trả về X = vị trí style.left của ảnh cut (mép PNG), không phải mép opaque.
 */
function matchPieceOnBackground(bg, cut) {
  const bounds = getOpaqueBounds(cut);
  const bgEdges = buildEdgeMap(bg);
  const cutEdges = buildEdgeMap(cut);

  const contour = [];
  for (let cy = bounds.minY; cy <= bounds.maxY; cy++) {
    for (let cx = bounds.minX; cx <= bounds.maxX; cx++) {
      if (!isContourPixel(cut, cx, cy)) continue;
      contour.push({
        cx,
        cy,
        ce: Math.max(cutEdges[cy * cut.width + cx], 1),
      });
    }
  }

  const interior = [];
  for (let cy = bounds.minY; cy <= bounds.maxY; cy += 2) {
    for (let cx = bounds.minX; cx <= bounds.maxX; cx += 2) {
      if (cut.data[(cy * cut.width + cx) * 4 + 3] < 40) continue;
      if (isContourPixel(cut, cx, cy)) continue;
      interior.push({ cx, cy });
    }
  }

  const yCandidates = [];
  const yMid = Math.round((bg.height - cut.height) / 2);
  for (let d = -24; d <= 24; d += 2) {
    const y = yMid + d;
    if (y >= -bounds.minY && y + bounds.maxY < bg.height) yCandidates.push(y);
  }
  if (!yCandidates.length) yCandidates.push(Math.max(0, yMid));

  const xStart = Math.max(0, Math.floor(bg.width * 0.1));
  const xEnd = Math.max(xStart, bg.width - cut.width - 1);

  let best = { x: xStart, y: yCandidates[0], score: Number.NEGATIVE_INFINITY, bounds };

  const scoreAt = (baseX, baseY) => {
    let edgeScore = 0;
    let edgeN = 0;
    for (const p of contour) {
      const bx = baseX + p.cx;
      const by = baseY + p.cy;
      if (bx <= 0 || by <= 0 || bx >= bg.width - 1 || by >= bg.height - 1) continue;
      edgeScore += bgEdges[by * bg.width + bx] * p.ce;
      edgeN++;
    }
    if (edgeN < 20) return null;

    let dark = 0;
    let darkN = 0;
    let outside = 0;
    let outsideN = 0;
    for (const p of interior) {
      const bx = baseX + p.cx;
      const by = baseY + p.cy;
      if (bx < 0 || by < 0 || bx >= bg.width || by >= bg.height) continue;
      dark += luma(bg.data, (by * bg.width + bx) * 4);
      darkN++;
    }
    for (const p of contour) {
      const ox = baseX + p.cx + (p.cx < bounds.minX + bounds.width / 2 ? -3 : 3);
      const oy = baseY + p.cy;
      if (ox < 0 || oy < 0 || ox >= bg.width || oy >= bg.height) continue;
      outside += luma(bg.data, (oy * bg.width + ox) * 4);
      outsideN++;
    }

    const edgeAvg = edgeScore / edgeN;
    const darkAvg = darkN ? dark / darkN : 128;
    const outAvg = outsideN ? outside / outsideN : darkAvg;
    return edgeAvg * 1.2 + (outAvg - darkAvg) * 2.5 - darkAvg * 0.15;
  };

  for (const baseY of yCandidates) {
    for (let x = xStart; x <= xEnd; x += 2) {
      const score = scoreAt(x, baseY);
      if (score == null) continue;
      if (score > best.score) best = { x, y: baseY, score, bounds };
    }
  }

  const rx0 = Math.max(xStart, best.x - 3);
  const rx1 = Math.min(xEnd, best.x + 3);
  const ry0 = best.y - 2;
  const ry1 = best.y + 2;
  for (let y = ry0; y <= ry1; y++) {
    if (y + bounds.maxY >= bg.height || y + bounds.minY < 0) continue;
    for (let x = rx0; x <= rx1; x++) {
      const score = scoreAt(x, y);
      if (score == null) continue;
      if (score > best.score) best = { x, y, score, bounds };
    }
  }

  return best;
}

/**
 * Ước lượng mép trái PNG tại lỗ tối (dùng khi edge-match yếu).
 */
function findShadowGapX(bg, cut, bounds) {
  const y0 = Math.max(0, Math.floor(bg.height * 0.15));
  const y1 = Math.min(bg.height, Math.ceil(bg.height * 0.85));
  const xStart = Math.max(0, Math.floor(bg.width * 0.1));
  const xEnd = Math.max(xStart, bg.width - cut.width - 1);

  let bestX = xStart;
  let bestScore = Number.POSITIVE_INFINITY;

  for (let x = xStart; x <= xEnd; x++) {
    let dark = 0;
    let n = 0;
    for (let cy = bounds.minY; cy <= bounds.maxY; cy += 2) {
      const by = Math.round((bg.height - cut.height) / 2) + cy;
      if (by < y0 || by >= y1) continue;
      for (let cx = bounds.minX; cx <= bounds.maxX; cx += 2) {
        if (cut.data[(cy * cut.width + cx) * 4 + 3] < 40) continue;
        const bx = x + cx;
        if (bx < 0 || bx >= bg.width) continue;
        dark += luma(bg.data, (by * bg.width + bx) * 4);
        n++;
      }
    }
    if (n < 20) continue;
    const avg = dark / n;
    if (avg < bestScore) {
      bestScore = avg;
      bestX = x;
    }
  }

  return bestX;
}

export async function findSlideDistance(bgUrl, cutUrl) {
  const [bgBuffer, cutBuffer] = await Promise.all([downloadImage(bgUrl), downloadImage(cutUrl)]);
  const [bg, cut] = await Promise.all([loadRgba(bgBuffer), loadRgba(cutBuffer)]);

  const bounds = getOpaqueBounds(cut);
  const edgeMatch = matchPieceOnBackground(bg, cut);
  const shadowX = findShadowGapX(bg, cut, bounds);

  let targetX = edgeMatch.x;
  const delta = Math.abs(edgeMatch.x - shadowX);
  if (edgeMatch.score < 400 && delta > 6) {
    targetX = shadowX;
  } else if (delta <= 4) {
    targetX = Math.round((edgeMatch.x + shadowX) / 2);
  }

  if (CAPTCHA_VERBOSE) {
    console.log(
      `   CAPTCHA match: pieceLeftX=${edgeMatch.x} score=${edgeMatch.score.toFixed(1)} shadowX=${shadowX} pad=${bounds.minX} → ${targetX}`
    );
  }

  return {
    targetX,
    templateX: edgeMatch.x,
    edgeX: shadowX,
    edgeCandidates: [shadowX, edgeMatch.x],
    templateScore: edgeMatch.score,
    bgWidth: bg.width,
    cutWidth: cut.width,
    opaqueWidth: bounds.width,
    matchY: edgeMatch.y,
    opaquePadX: bounds.minX,
  };
}

function getDisplayScale(metrics, analysis) {
  const naturalWidth = metrics.bgNaturalWidth || analysis?.bgWidth || metrics.bgWidth || 1;
  const displayBg = metrics.bgWidth > 0 ? metrics.bgWidth : metrics.barWidth;
  return displayBg > 0 && naturalWidth > 0 ? displayBg / naturalWidth : 1;
}

function toDragDistance(targetX, metrics, scale) {
  const displayTarget = targetX * scale;
  return Math.max(0, Math.round(displayTarget - metrics.pieceLeft - metrics.btnMarginLeft));
}

function buildDragCandidates(analysis, metrics) {
  const scale = getDisplayScale(metrics, analysis);
  const primary = toDragDistance(analysis.targetX, metrics, scale);
  const offsets = [0, -1, 1, -2, 2];
  const unique = [];
  const seen = new Set();

  for (const off of offsets) {
    const d = Math.max(0, primary + off);
    if (seen.has(d)) continue;
    seen.add(d);
    unique.push(d);
    if (unique.length >= CAPTCHA_MAX_CANDIDATES) break;
  }

  if (Number.isFinite(analysis.edgeX) && Math.abs(analysis.edgeX - analysis.targetX) > 2) {
    const alt = toDragDistance(analysis.edgeX, metrics, scale);
    if (!seen.has(alt)) unique.push(alt);
  }

  return unique;
}

export function getCaptchaFrame(page) {
  const frames = page.frames().filter((frame) => frame.url().includes(CAPTCHA_FRAME_URL));
  if (!frames.length) return null;
  for (const frame of frames) {
    try {
      if (frame !== page.mainFrame()) return frame;
    } catch {
      // ignore
    }
  }
  return frames[0];
}

export async function waitForCaptchaFrame(page, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const frame = getCaptchaFrame(page);
    if (frame) {
      try {
        const ready = await frame.evaluate(() => {
          const bg = document.querySelector(".bg-img");
          const cut = document.querySelector(".slider-img");
          return !!(bg?.src && cut?.src && bg.naturalWidth > 0);
        });
        if (ready) return frame;
      } catch {
        // frame đang load / detached
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  return null;
}

async function getCaptchaMetrics(frame) {
  return frame.evaluate(() => {
    const bg = document.querySelector(".bg-img");
    const bar = document.querySelector(".bar-container");
    const piece = document.querySelector(".slider-img");
    const btn = document.querySelector(".slider-btn");

    const bgRect = bg?.getBoundingClientRect?.();
    const pieceRect = piece?.getBoundingClientRect?.();
    const btnRect = btn?.getBoundingClientRect?.();

    return {
      bgSrc: bg?.src || "",
      cutSrc: piece?.src || "",
      bgWidth: bg?.clientWidth || bgRect?.width || 0,
      bgNaturalWidth: bg?.naturalWidth || 0,
      barWidth: bar?.clientWidth || 0,
      pieceLeft: parseFloat(piece?.style?.left || "0") || 0,
      btnMarginLeft: parseFloat(btn?.style?.marginLeft || "0") || 0,
      btnWidth: btn?.clientWidth || btnRect?.width || 0,
      bgScreenLeft: bgRect?.left || 0,
      pieceScreenLeft: pieceRect?.left || 0,
      btnScreenLeft: btnRect?.left || 0,
    };
  });
}

async function humanDrag(page, frame, distance) {
  const btn = await frame.$(".slider-btn");
  if (!btn) throw new Error("Slider button not found");

  const box = await btn.boundingBox();
  if (!box) throw new Error("Slider button not visible");

  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  const endX = startX + distance;

  try {
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await new Promise((r) => setTimeout(r, 60 + Math.random() * 60));

    const steps = 16 + Math.floor(Math.random() * 6);
    for (let i = 1; i <= steps; i++) {
      const progress = i / steps;
      const eased = 1 - Math.pow(1 - progress, 2.2);
      const jitter = progress < 0.9 ? (Math.random() - 0.5) * 0.8 : 0;
      let x = startX + distance * eased + jitter;
      if (x > endX) x = endX;
      const y = startY + (Math.random() - 0.5) * 0.8;
      await page.mouse.move(x, y);
      await new Promise((r) => setTimeout(r, 8 + Math.random() * 12));
    }

    await page.mouse.move(endX, startY);
    await new Promise((r) => setTimeout(r, 50 + Math.random() * 40));
    await page.mouse.up();
  } catch (err) {
    try {
      await page.mouse.up();
    } catch {
      // ignore
    }
    if (/Target closed|detached|Execution context|Cannot find context/i.test(err.message)) {
      const closedErr = new Error(err.message);
      closedErr.targetClosed = true;
      throw closedErr;
    }
    throw err;
  }
}

export async function isCaptchaStillActive(page) {
  const frame = getCaptchaFrame(page);
  if (!frame) return false;

  try {
    return frame.evaluate(() => {
      const bg = document.querySelector(".bg-img");
      const text = document.body?.innerText || "";
      const failed = /fail|error|try again|refresh|失败|重试/i.test(text);
      if (!bg) return failed;
      const rect = bg.getBoundingClientRect();
      const isVisible = rect.width > 0 && rect.height > 0;
      return isVisible || failed;
    });
  } catch {
    return !!getCaptchaFrame(page);
  }
}

async function waitCaptchaResult(page, timeoutMs = CAPTCHA_DRAG_WAIT_MS) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!(await isCaptchaStillActive(page))) {
      return true;
    }
    await new Promise((r) => setTimeout(r, CAPTCHA_DRAG_POLL_MS));
  }

  return !(await isCaptchaStillActive(page));
}

async function refreshCaptcha(frame) {
  await frame.click(".icon-refresh");
  await new Promise((r) => setTimeout(r, 1200));
}

async function tryDragCandidates(page, frame, analysis, metrics, log) {
  const candidates = buildDragCandidates(analysis, metrics);
  const maxCandidates = Math.min(candidates.length, Number(process.env.CAPTCHA_TRY_CANDIDATES || 4));

  for (let i = 0; i < maxCandidates; i++) {
    let distance = candidates[i];
    if (CAPTCHA_VERBOSE) {
      log?.(`CAPTCHA kéo ${i + 1}/${maxCandidates}: ${distance}px`);
    }

    for (let dragRound = 1; dragRound <= 2; dragRound++) {
      if (dragRound === 2) {
        log?.("Captcha còn kéo — tính lại rồi kéo lần 2...");
        await new Promise((r) => setTimeout(r, 350));

        frame = getCaptchaFrame(page);
        if (!frame) return { solved: true };

        try {
          const m2 = await getCaptchaMetrics(frame);
          if (m2.bgSrc && m2.cutSrc) {
            const a2 = await findSlideDistance(m2.bgSrc, m2.cutSrc);
            const scale = getDisplayScale(m2, a2);
            distance = toDragDistance(a2.targetX, m2, scale);
            metrics = m2;
            analysis = a2;
            log?.(`Captcha lần 2: target=${a2.targetX}, kéo ${distance}px`);
          }
        } catch {
          // giữ distance cũ
        }
      }

      try {
        await humanDrag(page, frame, distance);
      } catch (err) {
        if (err.targetClosed || /Target closed|detached|Execution context/i.test(err.message)) {
          return { solved: false, targetClosed: true };
        }
        throw err;
      }

      if (await waitCaptchaResult(page)) {
        return { solved: true, distance, analysis, candidateIndex: i + 1, dragRound };
      }

      frame = getCaptchaFrame(page);
      if (!frame) return { solved: true };
    }
  }

  return { solved: false };
}

export async function solveSliderCaptcha(page, options = {}) {
  const maxRetries = options.maxRetries || Number(process.env.CAPTCHA_MAX_RETRIES || 8);
  const log = options.log;
  let frame = options.frame || (await waitForCaptchaFrame(page));

  if (!frame) {
    return { solved: false, reason: "Captcha iframe not found" };
  }

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    frame = getCaptchaFrame(page);
    if (!frame) {
      return { solved: true, attempt };
    }

    let metrics = await getCaptchaMetrics(frame);
    if (!metrics.bgSrc || !metrics.cutSrc) {
      const imgDeadline = Date.now() + 8000;
      while (Date.now() < imgDeadline && (!metrics.bgSrc || !metrics.cutSrc)) {
        await new Promise((r) => setTimeout(r, 300));
        frame = getCaptchaFrame(page);
        if (!frame) break;
        metrics = await getCaptchaMetrics(frame);
      }
      if (!metrics?.bgSrc || !metrics?.cutSrc) {
        log?.(`Captcha ${attempt}/${maxRetries}: ảnh chưa sẵn — refresh...`);
        if (frame) {
          try {
            await refreshCaptcha(frame);
          } catch {
            // ignore
          }
        }
        continue;
      }
    }

    const analysis = await findSlideDistance(metrics.bgSrc, metrics.cutSrc);
    log?.(`Captcha ${attempt}/${maxRetries}: target=${analysis.targetX}, score=${Math.round(analysis.templateScore)}`);

    const dragResult = await tryDragCandidates(page, frame, analysis, metrics, log);
    if (dragResult.solved) {
      return { solved: true, attempt, ...dragResult };
    }

    if (dragResult.targetClosed) {
      log?.("Captcha: tab/frame đóng giữa chừng — thử lại...");
      await new Promise((r) => setTimeout(r, 1500));
      frame = getCaptchaFrame(page) || (await waitForCaptchaFrame(page, 8000));
      if (!frame) return { solved: true, attempt };
      continue;
    }

    frame = getCaptchaFrame(page);
    if (!frame) return { solved: true, attempt };

    try {
      await refreshCaptcha(frame);
    } catch {
      // ignore
    }
  }

  return { solved: false, reason: "Max captcha retries exceeded" };
}

/**
 * Kiểm tra nhanh captcha.uvfuns.com. Có thì giải, không thì bỏ qua.
 * Xong khi iframe biến mất (isCaptchaStillActive = false).
 */
export async function maybeSolveCaptcha(page, log) {
  if (!page) return false;
  try {
    if (typeof page.isClosed === "function" && page.isClosed()) return false;
  } catch {
    return false;
  }

  let frame = getCaptchaFrame(page);
  if (frame) {
    frame = (await waitForCaptchaFrame(page, 8000)) || frame;
  } else {
    frame = await waitForCaptchaFrame(page, 700);
  }
  if (!frame) return false;

  log?.("Gặp captcha kéo — đang giải...");
  const result = await solveSliderCaptcha(page, { frame, maxRetries: 8, log });
  if (result.solved) {
    log?.("Đã giải captcha kéo.");
    return true;
  }
  log?.(`Captcha kéo chưa xong: ${result.reason || "thất bại"}`);
  return false;
}
