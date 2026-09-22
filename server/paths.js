import path from "node:path";

const root = process.env.APP_DATA_DIR
  ? path.resolve(process.env.APP_DATA_DIR)
  : path.resolve(process.cwd());

export const DATA_DIR = path.join(root, "data");
export const PROFILE_ROOT = path.join(root, "profiles");
export const EXTENSION_DIR = path.join(DATA_DIR, "extensions", "dragonbmt");
export const VIDEO_DIR = path.join(DATA_DIR, "videos");
export const VIDEO_RAW = path.join(VIDEO_DIR, "raw");
export const VIDEO_OUT = path.join(VIDEO_DIR, "lanczos");
export const VIDEOS_FILE = path.join(DATA_DIR, "videos.json");
