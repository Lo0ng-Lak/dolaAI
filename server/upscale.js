import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import ffmpegPath from "ffmpeg-static";

export const PRESET_HEIGHT = {
  "1080p": 1080,
  "1440p": 1440,
  "2160p": 2160,
};

const PRESETS = PRESET_HEIGHT;

export function upscaleLabel(preset) {
  if (preset === "1080p") return "1080p Full HD (Lanczos + Unsharp)";
  if (preset === "1440p") return "2K 1440p QHD (Lanczos + Unsharp)";
  if (preset === "2160p") return "4K 2160p Ultra HD (Lanczos + Unsharp)";
  return "Tắt (giữ 720p gốc)";
}

function parseClock(value) {
  const match = String(value || "").match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

async function probeDuration(filePath) {
  if (!ffmpegPath) return 0;
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, ["-i", filePath]);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", () => resolve(0));
    child.on("close", () => {
      const match = stderr.match(/Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/);
      resolve(match ? parseClock(match[1]) : 0);
    });
  });
}

export async function upscaleVideo(inputPath, preset, outputDir, { onProgress } = {}) {
  const height = PRESETS[preset];
  if (!height) {
    return { skipped: true, outputPath: inputPath };
  }
  if (!ffmpegPath) throw new Error("Không tìm thấy ffmpeg để nâng cấp Lanczos.");

  const ext = path.extname(inputPath) || ".mp4";
  const fileName = `${path.basename(inputPath, ext)}_lanczos_${preset}${ext}`;
  const outputPath = path.join(outputDir || path.dirname(inputPath), fileName);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const filter = [
    `scale=-2:${height}:flags=lanczos+accurate_rnd+full_chroma_int`,
    "unsharp=5:5:0.85:5:5:0.0",
  ].join(",");
  await new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      "-y",
      "-i",
      inputPath,
      "-vf",
      filter,
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-crf",
      "19",
      "-threads",
      "0",
      "-c:a",
      "copy",
      outputPath,
    ]);
    let stderr = "";
    let durationSec = 0;
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (!durationSec) {
        const found = stderr.match(/Duration:\s*(\d+:\d+:\d+(?:\.\d+)?)/);
        if (found) durationSec = parseClock(found[1]);
      }
      if (!onProgress || !durationSec) return;
      const times = [...stderr.matchAll(/time=(\d+:\d+:\d+(?:\.\d+)?)/g)];
      const last = times[times.length - 1];
      if (!last) return;
      onProgress(Math.min(100, Math.max(0, (parseClock(last[1]) / durationSec) * 100)));
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.slice(-400) || `ffmpeg thoát với mã ${code}`));
    });
  });

  const stat = await fs.stat(outputPath);
  const heightOut = await probeHeight(outputPath);
  return { skipped: false, outputPath, bytes: stat.size, preset, height: heightOut };
}

export async function probeHeight(filePath) {
  if (!ffmpegPath) return 0;
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath, ["-i", filePath]);
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", () => resolve(0));
    child.on("close", () => {
      const match = stderr.match(/(\d{2,5})x(\d{2,5})/);
      resolve(match ? Number(match[2]) : 0);
    });
  });
}
