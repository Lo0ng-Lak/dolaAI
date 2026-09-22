import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "./paths.js";
import { DEFAULT_DAILY_LIMIT, normalizeAccountQuota } from "../shared/quota.js";

const ACCOUNTS_FILE = path.join(DATA_DIR, "accounts.json");
const PROXIES_FILE = path.join(DATA_DIR, "proxies.json");

const ACCENTS = ["#38bdf8", "#a855f7", "#22c55e", "#f59e0b", "#ef4444", "#14b8a6"];

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

async function writeJson(file, value) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(file, JSON.stringify(value, null, 2));
}

export async function loadAccounts() {
  const raw = await readJson(ACCOUNTS_FILE, []);
  let changed = false;
  const next = raw.map((account) => {
    const normalized = normalizeAccountQuota(account);
    if (
      normalized.sentToday !== account.sentToday ||
      normalized.sentDate !== account.sentDate ||
      normalized.dailyLimit !== account.dailyLimit
    ) {
      changed = true;
    }
    return normalized;
  });
  if (changed) await writeJson(ACCOUNTS_FILE, next);
  return next;
}

export async function saveAccounts(accounts) {
  await writeJson(ACCOUNTS_FILE, accounts);
  return accounts;
}

export async function loadProxies() {
  return readJson(PROXIES_FILE, []);
}

export async function saveProxies(proxies) {
  await writeJson(PROXIES_FILE, proxies);
  return proxies;
}

export function makeAccount(email, extras = {}, existingCount = 0) {
  return {
    id: extras.id || crypto.randomUUID(),
    email: email.trim(),
    status: extras.status || "need_login",
    leftover: extras.leftover ?? 0,
    accent: extras.accent || ACCENTS[existingCount % ACCENTS.length],
    proxyMode: extras.proxyMode || "direct",
    proxyId: extras.proxyId || "",
    dailyLimit: extras.dailyLimit === 1 || extras.dailyLimit === 2 || extras.dailyLimit === 3 ? extras.dailyLimit : DEFAULT_DAILY_LIMIT,
    sentToday: extras.sentToday || 0,
    sentDate: extras.sentDate || null,
    sessionOk: extras.sessionOk || false,
    lastCheck: extras.lastCheck || null,
    note: extras.note || "",
  };
}
