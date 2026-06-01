import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

dotenv.config({ quiet: true });

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const CONFIG_PATH = path.join(ROOT, "config.json");

export const DEFAULT_CONFIG = {
  apiKey: "",
  model: "deepseek-v4-pro",
  port: 11435,
  autoOpen: true,
  pricing: {
    currency: "USD",
    inputPerMTok: 0,
    cacheHitInputPerMTok: 0,
    outputPerMTok: 0,
  },
};

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function normalizePricing(raw = {}) {
  return {
    currency: String(raw.currency ?? DEFAULT_CONFIG.pricing.currency).trim() || DEFAULT_CONFIG.pricing.currency,
    inputPerMTok: number(raw.inputPerMTok),
    cacheHitInputPerMTok: number(raw.cacheHitInputPerMTok),
    outputPerMTok: number(raw.outputPerMTok),
  };
}

function normalizeConfig(raw = {}) {
  const port = Number(raw.port ?? process.env.PORT ?? DEFAULT_CONFIG.port);
  return {
    apiKey: String(raw.apiKey ?? process.env.api_key ?? "").trim(),
    model: String(raw.model ?? process.env.MODEL ?? DEFAULT_CONFIG.model).trim() || DEFAULT_CONFIG.model,
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_CONFIG.port,
    autoOpen: raw.autoOpen !== false,
    pricing: normalizePricing(raw.pricing),
  };
}

export function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return normalizeConfig();
    return normalizeConfig(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")));
  } catch {
    return normalizeConfig();
  }
}

export function saveConfig(nextConfig) {
  const current = loadConfig();
  const config = normalizeConfig({ ...current, ...nextConfig });
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), "utf8");
  return config;
}

export function publicConfig(config = loadConfig()) {
  return {
    model: config.model,
    port: config.port,
    autoOpen: config.autoOpen,
    pricing: config.pricing,
    hasApiKey: Boolean(config.apiKey),
    apiKeyPreview: config.apiKey ? config.apiKey.slice(0, 6) + "..." + config.apiKey.slice(-4) : "",
  };
}

