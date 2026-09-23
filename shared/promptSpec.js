export const SPEC_MARKER = "--- DOLA SPECS ---";

const RATIOS = new Set(["16:9", "9:16", "1:1"]);

export function forcedDuration(settings = {}) {
  const seconds = Number(String(settings.duration || "30s").replace(/\D/g, ""));
  return seconds >= 60 ? "60s" : "30s";
}

export function normalizeRatio(value) {
  const raw = String(value || "").trim();
  if (RATIOS.has(raw)) return raw;
  if (/9\s*[:/x]\s*16/.test(raw)) return "9:16";
  if (/1\s*[:/x]\s*1/.test(raw)) return "1:1";
  return "16:9";
}

export function specBlock(settings = {}) {
  return `${normalizeRatio(settings.ratio)}, ${forcedDuration(settings)}`;
}

export function stripSpecBlock(prompt = "") {
  let text = String(prompt || "");
  const index = text.indexOf(SPEC_MARKER);
  if (index >= 0) text = text.slice(0, index);
  return text
    .replace(/(?:\n|\s)+(?:16:9|9:16|1:1)\s*[,·\s]\s*\d+\s*s\s*$/i, "")
    .replace(/(?:\n|\s)+\d+\s*(?:s|seconds?)\s*$/i, "")
    .replace(/(?:\n|\s)+(?:tỷ lệ khung|aspect ratio)[:\s]*(?:16:9|9:16|1:1)\s*$/i, "")
    .replace(/(?:\n|\s)+(?:16:9|9:16|1:1)\s*$/i, "")
    .trim();
}

export function buildPromptWithSpecs(prompt = "", settings = {}) {
  const body = stripSpecBlock(prompt);
  if (!body) return "";
  return `${body}\n\n${specBlock(settings)}`;
}

export function continueAfterDurationRefusal(_settings = {}) {
  return "OK";
}
