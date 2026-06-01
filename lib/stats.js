import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
let statsPath = path.join(ROOT, "stats.json");
const MAX_HISTORY = 10000;

const EMPTY_STATS = {
  requests: 0,
  tokens: { input: 0, output: 0, total: 0, cacheHit: 0, cacheMiss: 0 },
  cost: { estimated: 0 },
  lastRequest: null,
  updatedAt: null,
  history: [],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function number(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function normalizeStoredStats(raw = {}) {
  return {
    requests: number(raw.requests),
    tokens: {
      input: number(raw.tokens?.input),
      output: number(raw.tokens?.output),
      total: number(raw.tokens?.total),
      cacheHit: number(raw.tokens?.cacheHit),
      cacheMiss: number(raw.tokens?.cacheMiss),
    },
    cost: { estimated: number(raw.cost?.estimated) },
    lastRequest: raw.lastRequest ?? null,
    updatedAt: raw.updatedAt ?? null,
    history: Array.isArray(raw.history) ? raw.history : [],
  };
}

function readStats() {
  try {
    if (!fs.existsSync(statsPath)) return clone(EMPTY_STATS);
    return normalizeStoredStats(JSON.parse(fs.readFileSync(statsPath, "utf8")));
  } catch {
    return clone(EMPTY_STATS);
  }
}

function writeStats(stats) {
  fs.writeFileSync(statsPath, JSON.stringify(stats, null, 2), "utf8");
}

function dashboardTotal(tokens) {
  const splitInput = number(tokens.cacheHit) + number(tokens.cacheMiss);
  return splitInput > 0 || tokens.cacheReported ? splitInput + number(tokens.output) : number(tokens.total) || number(tokens.input) + number(tokens.output);
}

function emptyAggregate(pricing) {
  return {
    requests: 0,
    tokens: { input: 0, output: 0, total: 0, cacheHit: 0, cacheMiss: 0 },
    cost: { currency: pricing.currency, estimated: null, configured: false },
    cacheReported: false,
  };
}

function addRecord(aggregate, record, pricing) {
  const tokens = normalizeRecordTokens(record.tokens);
  const cost = record.cost ?? estimateCost(tokens, pricing);
  aggregate.requests += 1;
  aggregate.tokens.input += tokens.input;
  aggregate.tokens.output += tokens.output;
  aggregate.tokens.cacheHit += tokens.cacheHit;
  aggregate.tokens.cacheMiss += tokens.cacheMiss;
  aggregate.tokens.total += dashboardTotal(tokens);
  aggregate.cacheReported ||= tokens.cacheReported;
  aggregate.cost.estimated = number(aggregate.cost.estimated) + (cost.estimated ?? 0);
  aggregate.cost.configured ||= Boolean(cost.configured);
  aggregate.cost.currency = cost.currency ?? aggregate.cost.currency;
}

function normalizeRecordTokens(tokens = {}) {
  const cacheHit = number(tokens.cacheHit);
  const cacheMiss = number(tokens.cacheMiss);
  const output = number(tokens.output);
  const input = number(tokens.input) || cacheHit + cacheMiss;
  const cacheReported = Boolean(tokens.cacheReported) || cacheHit > 0 || cacheMiss > 0;
  const total = dashboardTotal({ ...tokens, input, output, cacheHit, cacheMiss, cacheReported });
  return { input, output, total, cacheHit, cacheMiss, cacheReported };
}

function rangeStart(range, now) {
  const d = new Date(now);
  if (range === "today") return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  if (range === "7d") return d.getTime() - 7 * 24 * 60 * 60 * 1000;
  if (range === "30d") return d.getTime() - 30 * 24 * 60 * 60 * 1000;
  if (range === "month") return new Date(d.getFullYear(), d.getMonth(), 1).getTime();
  return null;
}

function normalizeRange(range) {
  return ["today", "7d", "30d", "month", "all"].includes(range) ? range : "all";
}

function filterHistory(history, range, now) {
  const start = rangeStart(range, now);
  if (start == null) return history;
  return history.filter((record) => new Date(record.at).getTime() >= start);
}

function buildStatsResponse({ range, records, stats, pricing }) {
  const aggregate = emptyAggregate(pricing);
  const models = new Map();

  for (const record of records) {
    addRecord(aggregate, record, pricing);
    const model = record.model || "unknown";
    if (!models.has(model)) models.set(model, { model, ...emptyAggregate(pricing) });
    addRecord(models.get(model), record, pricing);
  }

  const totalCache = aggregate.tokens.cacheHit + aggregate.tokens.cacheMiss;
  const costConfigured = pricing.inputPerMTok > 0 || pricing.cacheHitInputPerMTok > 0 || pricing.outputPerMTok > 0;
  const recent = [...records].slice(-100).reverse().map((record) => {
    const tokens = normalizeRecordTokens(record.tokens);
    const cost = record.cost ?? estimateCost(tokens, pricing);
    const cacheTotal = tokens.cacheHit + tokens.cacheMiss;
    return {
      at: record.at,
      model: record.model || "unknown",
      stream: Boolean(record.stream),
      tokens,
      cache: {
        reported: tokens.cacheReported,
        hitRate: tokens.cacheReported && cacheTotal > 0 ? tokens.cacheHit / cacheTotal : null,
      },
      cost: {
        currency: cost.currency ?? pricing.currency,
        estimated: costConfigured ? cost.estimated : null,
        configured: costConfigured,
      },
    };
  });

  return {
    range,
    requests: aggregate.requests,
    tokens: aggregate.tokens,
    cache: {
      reported: aggregate.cacheReported,
      hitRate: aggregate.cacheReported && totalCache > 0 ? aggregate.tokens.cacheHit / totalCache : null,
    },
    cost: {
      currency: pricing.currency,
      estimated: costConfigured ? aggregate.cost.estimated : null,
      configured: costConfigured,
    },
    models: [...models.values()].map((item) => {
      const modelCache = item.tokens.cacheHit + item.tokens.cacheMiss;
      return {
        model: item.model,
        requests: item.requests,
        tokens: item.tokens,
        cache: {
          reported: item.cacheReported,
          hitRate: item.cacheReported && modelCache > 0 ? item.tokens.cacheHit / modelCache : null,
        },
        cost: {
          currency: pricing.currency,
          estimated: costConfigured ? item.cost.estimated : null,
          configured: costConfigured,
        },
      };
    }).sort((a, b) => b.tokens.total - a.tokens.total),
    recent,
    lastRequest: stats.lastRequest,
    updatedAt: stats.updatedAt,
  };
}

export function normalizeUsage(usage = {}) {
  const cacheHit = number(usage.prompt_cache_hit_tokens ?? usage.input_tokens_details?.cached_tokens);
  const cacheMiss = number(usage.prompt_cache_miss_tokens);
  const input = number(usage.prompt_tokens ?? usage.input_tokens) || cacheHit + cacheMiss;
  const output = number(usage.completion_tokens ?? usage.output_tokens);
  const cacheReported = usage.prompt_cache_hit_tokens != null || usage.prompt_cache_miss_tokens != null || usage.input_tokens_details?.cached_tokens != null;
  const total = dashboardTotal({ input, output, cacheHit, cacheMiss, cacheReported, total: usage.total_tokens });

  return { input, output, total, cacheHit, cacheMiss, cacheReported };
}

export function responseUsage(usage) {
  if (!usage) return null;
  const tokens = normalizeUsage(usage);
  const details = {};
  if (tokens.cacheReported) {
    details.input_tokens_details = { cached_tokens: tokens.cacheHit };
    details.deepseek = {
      prompt_cache_hit_tokens: tokens.cacheHit,
      prompt_cache_miss_tokens: tokens.cacheMiss,
    };
  }
  return {
    input_tokens: tokens.input,
    output_tokens: tokens.output,
    total_tokens: tokens.total,
    ...details,
  };
}

export function normalizePricing(pricing = {}) {
  return {
    currency: String(pricing.currency || "USD").trim() || "USD",
    inputPerMTok: number(pricing.inputPerMTok),
    cacheHitInputPerMTok: number(pricing.cacheHitInputPerMTok),
    outputPerMTok: number(pricing.outputPerMTok),
  };
}

export function estimateCost(tokens, pricing = {}) {
  const p = normalizePricing(pricing);
  const configured = p.inputPerMTok > 0 || p.cacheHitInputPerMTok > 0 || p.outputPerMTok > 0;
  if (!configured) return { estimated: null, currency: p.currency, configured: false };

  const inputCost = tokens.cacheReported
    ? (tokens.cacheHit / 1_000_000) * p.cacheHitInputPerMTok + (tokens.cacheMiss / 1_000_000) * p.inputPerMTok
    : (tokens.input / 1_000_000) * p.inputPerMTok;
  const outputCost = (tokens.output / 1_000_000) * p.outputPerMTok;

  return { estimated: inputCost + outputCost, currency: p.currency, configured: true };
}

export function recordUsage({ model, usage, stream = false, pricing = {}, createdAt = new Date() }) {
  const tokens = normalizeUsage(usage);
  const requestCost = estimateCost(tokens, pricing);
  const stats = readStats();
  const now = new Date(createdAt).toISOString();
  const record = { at: now, model, stream, tokens, cost: requestCost };

  stats.requests = number(stats.requests) + 1;
  stats.tokens = {
    input: number(stats.tokens?.input) + tokens.input,
    output: number(stats.tokens?.output) + tokens.output,
    total: number(stats.tokens?.total) + tokens.total,
    cacheHit: number(stats.tokens?.cacheHit) + tokens.cacheHit,
    cacheMiss: number(stats.tokens?.cacheMiss) + tokens.cacheMiss,
  };
  stats.cost = { estimated: number(stats.cost?.estimated) + (requestCost.estimated ?? 0) };
  stats.lastRequest = record;
  stats.updatedAt = now;
  stats.history = [...(stats.history ?? []), record].slice(-MAX_HISTORY);
  writeStats(stats);
  return stats;
}

export function getStats(config = {}, options = {}) {
  const stats = readStats();
  const pricing = normalizePricing(config.pricing);
  const range = normalizeRange(options.range ?? "all");
  const now = options.now ?? new Date();

  if (stats.history.length > 0) {
    const historyResponse = buildStatsResponse({ range, records: filterHistory(stats.history, range, now), stats, pricing });
    if (range === "all") {
      const historyRequests = stats.history.length;
      const legacyRequests = Math.max(0, number(stats.requests) - historyRequests);
      const historyTokens = historyResponse.tokens;
      const legacyTokens = {
        input: Math.max(0, number(stats.tokens.input) - historyTokens.input),
        output: Math.max(0, number(stats.tokens.output) - historyTokens.output),
        total: Math.max(0, number(stats.tokens.total) - historyTokens.total),
        cacheHit: Math.max(0, number(stats.tokens.cacheHit) - historyTokens.cacheHit),
        cacheMiss: Math.max(0, number(stats.tokens.cacheMiss) - historyTokens.cacheMiss),
      };
      if (legacyRequests > 0 || legacyTokens.total > 0) {
        historyResponse.requests += legacyRequests;
        historyResponse.tokens = {
          input: historyTokens.input + legacyTokens.input,
          output: historyTokens.output + legacyTokens.output,
          total: historyTokens.total + legacyTokens.total,
          cacheHit: historyTokens.cacheHit + legacyTokens.cacheHit,
          cacheMiss: historyTokens.cacheMiss + legacyTokens.cacheMiss,
        };
        const totalCache = historyResponse.tokens.cacheHit + historyResponse.tokens.cacheMiss;
        historyResponse.cache = {
          reported: totalCache > 0 || historyResponse.cache.reported,
          hitRate: totalCache > 0 ? historyResponse.tokens.cacheHit / totalCache : null,
        };
        historyResponse.models.push({
          model: "历史汇总",
          requests: legacyRequests,
          tokens: legacyTokens,
          cache: {
            reported: legacyTokens.cacheHit + legacyTokens.cacheMiss > 0,
            hitRate: legacyTokens.cacheHit + legacyTokens.cacheMiss > 0 ? legacyTokens.cacheHit / (legacyTokens.cacheHit + legacyTokens.cacheMiss) : null,
          },
          cost: { currency: pricing.currency, estimated: null, configured: false },
        });
      }
    }
    return historyResponse;
  }

  if (range !== "all") {
    return buildStatsResponse({ range, records: [], stats, pricing });
  }

  const legacyTokens = normalizeRecordTokens({ ...stats.tokens, cacheReported: stats.tokens.cacheHit > 0 || stats.tokens.cacheMiss > 0 });
  const legacyRecord = stats.requests > 0 ? [{ at: stats.updatedAt ?? new Date(now).toISOString(), model: stats.lastRequest?.model ?? "unknown", stream: stats.lastRequest?.stream ?? false, tokens: legacyTokens, cost: { estimated: stats.cost.estimated, currency: pricing.currency, configured: true } }] : [];
  const response = buildStatsResponse({ range, records: legacyRecord, stats, pricing });
  if (stats.requests > 1 && legacyRecord.length === 1) response.requests = stats.requests;
  return response;
}

export function resetStats() {
  const stats = clone(EMPTY_STATS);
  writeStats(stats);
  return stats;
}

export function setStatsPathForTests(nextPath) {
  statsPath = nextPath;
}
