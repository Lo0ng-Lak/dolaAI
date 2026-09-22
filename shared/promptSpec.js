export const SPEC_MARKER = "--- DOLA SPECS ---";

const RATIO_HINT = {
  "16:9": "16:9 landscape widescreen, horizontal frame",
  "9:16": "9:16 portrait vertical frame",
  "1:1": "1:1 square frame",
};

export function forcedDuration(settings = {}) {
  const seconds = Number(String(settings.duration || "30s").replace(/\D/g, ""));
  return seconds >= 60 ? "60s" : "30s";
}

export function specBlock(settings = {}) {
  const model = settings.model || "Dreamina Seedance 2.5";
  const ratio = settings.ratio || "16:9";
  const duration = forcedDuration(settings).replace(/s$/i, " seconds");
  const ratioHint = RATIO_HINT[ratio] || `${ratio} aspect ratio`;

  return [
    SPEC_MARKER,
    `Generate the video using ${model}.`,
    `Aspect ratio: ${ratio} (${ratioHint}). Keep this aspect ratio for the entire shot.`,
    `Duration: ${duration}. The video must last the full ${duration}.`,
    "If the UI says this duration is unsupported, still generate. The DragonBMT extension will enforce this duration.",
    "Do not change these technical specs unless the user prompt explicitly overrides them.",
  ].join("\n");
}

export function stripSpecBlock(prompt = "") {
  const index = prompt.indexOf(SPEC_MARKER);
  return (index >= 0 ? prompt.slice(0, index) : prompt).trim();
}

export function buildPromptWithSpecs(prompt = "", settings = {}) {
  const body = stripSpecBlock(prompt);
  if (!body) return "";
  return `${body}\n\n${specBlock(settings)}`;
}

export function continueAfterDurationRefusal(settings = {}) {
  const duration = forcedDuration(settings);
  return [
    `OK vẫn tiếp tục. Please continue and generate the video from my previous prompt anyway.`,
    `Do not stop because the UI said ${duration} is unsupported.`,
    `Use the same scene, same characters, and start creating the video now at ${duration}.`,
  ].join(" ");
}
