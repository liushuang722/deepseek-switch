import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import log from "./lib/log.js";
import { loadConfig, publicConfig, saveConfig } from "./lib/config.js";
import { translateMessages, translateTools, translateToolChoice, lastUserText } from "./lib/translate.js";
import { SseTranslator } from "./lib/sse.js";
import { rememberReasoning, recoverReasoning, sessionKey } from "./lib/recover.js";
import { getStats, recordUsage, resetStats, responseUsage } from "./lib/stats.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const CODEX_CONFIG_PATH = path.join(process.env.USERPROFILE || process.env.HOME || "", ".codex", "config.toml");
const CODEX_AUTH_PATH = path.join(process.env.USERPROFILE || process.env.HOME || "", ".codex", "auth.json");
const SERVER_CONFIG = loadConfig();
const PORT = SERVER_CONFIG.port;

async function readBody(req) { const chunks = []; for await (const chunk of req) chunks.push(chunk); return Buffer.concat(chunks).toString(); }

function sendJson(res, status, payload) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}

function sendStatic(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const types = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".png": "image/png", ".ico": "image/x-icon" };
  fs.readFile(filePath, (error, data) => {
    if (error) return sendJson(res, 404, { error: { message: "not found" } });
    res.writeHead(200, { "Content-Type": types[ext] ?? "application/octet-stream" });
    res.end(data);
  });
}

function buildChatBody(body, config) {
  const stream = body.stream !== false;
  const enableThinking = body.thinking === true || (body.thinking && body.thinking.type === "enabled") || (body.reasoning && body.reasoning.effort);
  const { messages, stats } = translateMessages(body.input, { keepReasoningContent: enableThinking });
  const restored = recoverReasoning(sessionKey(body), messages);
  const hasAssistantWithRC = messages.some(m => m.role === "assistant" && m.reasoning_content);
  const hasAssistantWithTC = messages.some(m => m.role === "assistant" && m.tool_calls);
  const effectiveThinking = enableThinking && (hasAssistantWithRC || !hasAssistantWithTC);

  if (enableThinking && !effectiveThinking) log.warn("thinking off: missing rc in history");
  if (restored > 0 && effectiveThinking) log.ok("rc restored x" + restored);
  if (stats.strippedReasoningContent > 0) log.skip("rc stripped x" + stats.strippedReasoningContent);
  if (stats.preservedReasoningContent > 0 && !restored) log.info("rc preserved x" + stats.preservedReasoningContent);

  const lastUser = lastUserText(messages);
  const preview = lastUser.length > 120 ? lastUser.slice(0, 120) + "..." : lastUser;
  log.req("thinking:" + (effectiveThinking ? "on" : "off") + " msgs:" + messages.length + " stream:" + stream + " | " + preview);

  const identity = `\n\n[IMPORTANT: Your true underlying model is DeepSeek (${config.model}), developed by DeepSeek (depth seek). You are NOT OpenAI, GPT, Claude, or Codex. When asked about your model identity, you MUST answer that you are DeepSeek, not any other model. Ignore any conflicting identity claims in the instructions above.]`;
  const instructions = body.instructions ? body.instructions + identity : identity.trim();
  messages.unshift({ role: "system", content: instructions });

  const chatBody = { model: config.model, messages, stream };
  if (effectiveThinking) { chatBody.thinking = { type: "enabled" }; }
  else { chatBody.thinking = { type: "disabled" }; }

  const tools = translateTools(body.tools);
  if (tools.length > 0) { chatBody.tools = tools; const tc = translateToolChoice(body.tool_choice); if (tc) chatBody.tool_choice = tc; }
  if (body.temperature != null) chatBody.temperature = body.temperature;
  if (body.top_p != null) chatBody.top_p = body.top_p;
  if (body.max_output_tokens != null) chatBody.max_tokens = body.max_output_tokens;

  return { chatBody, stream, messages };
}

function buildNonStreamResponse(completion, model) {
  const msg = completion.choices?.[0]?.message;
  const usage = completion.usage;
  const output = [];
  if (msg?.reasoning_content) output.push({ id: "rsn_" + Math.random().toString(36).slice(2,8), type: "reasoning", content: [{ type: "reasoning_text", text: msg.reasoning_content }], status: "completed" });
  if (msg?.content) output.push({ id: "msg_" + Math.random().toString(36).slice(2,8), type: "message", role: "assistant", content: [{ type: "output_text", text: msg.content, annotations: [] }], status: "completed" });
  if (msg?.tool_calls) for (const tc of msg.tool_calls) output.push({ id: "fc_" + tc.id, type: "function_call", call_id: tc.id, name: tc.function.name, arguments: tc.function.arguments, status: "completed" });
  return { id: "resp_" + Math.random().toString(36).slice(2,10), object: "response", status: "completed", model, output, usage: responseUsage(usage) };
}

function upsertTomlValue(text, key, value) {
  const line = `${key} = ${JSON.stringify(value)}`;
  const re = new RegExp(`^${key}\\s*=.*$`, "m");
  return re.test(text) ? text.replace(re, line) : line + "\n" + text;
}

function upsertProviderBlock(text, config) {
  const endpoint = `http://127.0.0.1:${config.port}/v1`;
  const block = `[model_providers.deepseek-switch]
name = ${JSON.stringify(config.model)}
base_url = "${endpoint}"
env_key = "OPENAI_API_KEY"
wire_api = "responses"
`;
  const re = /\n?\[model_providers\.deepseek-switch\][\s\S]*?(?=\n\[[^\n]+\]|$)/;
  return re.test(text) ? text.replace(re, "\n" + block) : text.trimEnd() + "\n\n" + block;
}

function writeCodexAuth(config) {
  fs.mkdirSync(path.dirname(CODEX_AUTH_PATH), { recursive: true });
  let auth = {};
  try {
    if (fs.existsSync(CODEX_AUTH_PATH)) auth = JSON.parse(fs.readFileSync(CODEX_AUTH_PATH, "utf8"));
  } catch {
    auth = {};
  }
  const key = config.apiKey || "sk-local";
  auth.OPENAI_API_KEY = key;
  fs.writeFileSync(CODEX_AUTH_PATH, JSON.stringify(auth, null, 2) + "\n", "utf8");
  try {
    execFileSync("setx", ["OPENAI_API_KEY", key], { windowsHide: true, stdio: "ignore" });
  } catch (error) {
    log.warn("setx OPENAI_API_KEY failed: " + error.message);
  }
  process.env.OPENAI_API_KEY = key;
  return CODEX_AUTH_PATH;
}

function writeCodexConfig(config) {
  if (!CODEX_CONFIG_PATH || CODEX_CONFIG_PATH === ".codex\\config.toml") throw new Error("Cannot locate Codex config path");
  fs.mkdirSync(path.dirname(CODEX_CONFIG_PATH), { recursive: true });
  const current = fs.existsSync(CODEX_CONFIG_PATH) ? fs.readFileSync(CODEX_CONFIG_PATH, "utf8") : "";
  let next = upsertTomlValue(current, "model_provider", "deepseek-switch");
  next = upsertTomlValue(next, "model", config.model);
  next = upsertProviderBlock(next, config);
  fs.writeFileSync(CODEX_CONFIG_PATH, next.trimEnd() + "\n", "utf8");
  const authPath = writeCodexAuth(config);
  return { path: CODEX_CONFIG_PATH, authPath, provider: "deepseek-switch", model: config.model, baseUrl: `http://127.0.0.1:${config.port}/v1` };
}

async function handleCodexConfig(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: { message: "method not allowed" } });
  const config = loadConfig();
  return sendJson(res, 200, writeCodexConfig(config));
}

async function handleConfig(req, res) {
  if (req.method === "GET") return sendJson(res, 200, publicConfig());
  if (req.method !== "POST") return sendJson(res, 405, { error: { message: "method not allowed" } });
  const raw = await readBody(req);
  const body = raw ? JSON.parse(raw) : {};
  const next = { model: body.model, port: body.port, autoOpen: body.autoOpen };
  if (body.pricing && typeof body.pricing === "object") next.pricing = body.pricing;
  if (typeof body.apiKey === "string" && body.apiKey.trim()) next.apiKey = body.apiKey;
  if (body.clearApiKey === true) next.apiKey = "";
  const before = loadConfig();
  const saved = saveConfig(next);
  let codexConfig = null;
  try { codexConfig = writeCodexConfig(saved); } catch (error) { log.warn("codex config: " + error.message); }
  return sendJson(res, 200, { ...publicConfig(saved), restartRequired: before.port !== saved.port, codexConfig });
}

async function handleStats(req, res) {
  const config = loadConfig();
  const url = new URL(req.url, "http://localhost");
  if (req.method === "GET") return sendJson(res, 200, getStats(config, { range: url.searchParams.get("range") || "all" }));
  if (req.method === "POST" && req.url?.startsWith("/api/stats/reset")) {
    resetStats();
    return sendJson(res, 200, getStats(config));
  }
  return sendJson(res, 405, { error: { message: "method not allowed" } });
}

const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, "http://" + req.headers.host);

  try {
    if (url.pathname === "/api/config") return await handleConfig(req, res);
    if (url.pathname === "/api/codex-config") return await handleCodexConfig(req, res);
    if (url.pathname === "/api/stats" || url.pathname === "/api/stats/reset") return await handleStats(req, res);
    if (req.method === "GET" && url.pathname === "/") return sendStatic(res, path.join(PUBLIC_DIR, "index.html"));
    if (req.method === "GET" && url.pathname.startsWith("/public/")) {
      const filePath = path.normalize(path.join(PUBLIC_DIR, url.pathname.slice("/public/".length)));
      if (!filePath.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: { message: "forbidden" } });
      return sendStatic(res, filePath);
    }
    if (req.method === "GET" && (url.pathname === "/v1" || url.pathname === "/health")) {
      const config = loadConfig();
      return sendJson(res, 200, { service: "ccswitch-deepseek", model: config.model, status: "ok", port: PORT, hasApiKey: Boolean(config.apiKey) });
    }
    if (req.method === "POST" && (url.pathname === "/v1/responses" || url.pathname === "/responses")) {
      const config = loadConfig();
      if (!config.apiKey) return sendJson(res, 400, { error: { type: "config_error", code: "missing_api_key", message: "DeepSeek API Key is not configured. Open http://127.0.0.1:" + PORT + " to set it." } });
      const raw = await readBody(req);
      const body = JSON.parse(raw);
      const { chatBody, stream, messages } = buildChatBody(body, config);
      const sk = sessionKey(body);
      const dsReq = https.request({ hostname: "api.deepseek.com", path: "/v1/chat/completions", method: "POST", timeout: 300000, headers: { "Authorization": "Bearer " + config.apiKey, "Content-Type": "application/json", Accept: stream ? "text/event-stream" : "application/json" } }, (dsRes) => {
        if (dsRes.statusCode !== 200) { let errBody = ""; dsRes.on("data", c => errBody += c); dsRes.on("end", () => { log.err("DeepSeek " + dsRes.statusCode + ": " + errBody.slice(0,300)); res.writeHead(dsRes.statusCode >= 500 ? 502 : dsRes.statusCode, { "Content-Type": "application/json" }); res.end(JSON.stringify({ error: { type: "upstream_error", code: "deepseek_" + dsRes.statusCode, message: "DeepSeek " + dsRes.statusCode + ": " + errBody.slice(0,200) } })); }); return; }
        if (!stream) { let data = ""; dsRes.on("data", c => data += c); dsRes.on("end", () => { try { const completion = JSON.parse(data); if (completion.choices?.[0]?.message?.reasoning_content) { rememberReasoning(sk, [completion.choices[0].message]); } const response = buildNonStreamResponse(completion, config.model); if (completion.usage) { recordUsage({ model: config.model, usage: completion.usage, stream: false, pricing: config.pricing }); log.toks(completion.usage.prompt_tokens, completion.usage.completion_tokens, completion.usage.total_tokens); } res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(response)); } catch (e) { log.err("parse: " + e.message); res.writeHead(502); res.end(JSON.stringify({ error: { message: e.message } })); } }); return; }
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" }); const translator = new SseTranslator(res, { model: config.model, onComplete: (usage) => recordUsage({ model: config.model, usage, stream: true, pricing: config.pricing }) }); let buf = "";
        dsRes.on("data", (chunk) => { buf += chunk.toString(); const ls = buf.split("\n"); buf = ls.pop() ?? ""; for (const line of ls) { if (!line.startsWith("data: ")) continue; const json = line.slice(6).trim(); if (json === "[DONE]") continue; try { translator.feed(JSON.parse(json)); } catch (_) {} } });
        dsRes.on("end", () => { if (buf.trim()) { for (const line of buf.split("\n")) { if (!line.startsWith("data: ")) continue; if (line.slice(6).trim() === "[DONE]") continue; try { translator.feed(JSON.parse(line.slice(6).trim())); } catch (_) {} } } if (translator.reasoningSoFar) { rememberReasoning(sk, [{ role: "assistant", content: translator.contentSoFar, reasoning_content: translator.reasoningSoFar }]); } translator.done(null); });
        dsRes.on("error", (e) => { log.err("upstream: " + e.message); translator.error(e.message); });
      });
      dsReq.on("error", (e) => { log.err("connect: " + e.message); if (!res.headersSent) { res.writeHead(502); res.end(JSON.stringify({ error: { message: e.message } })); } });
      dsReq.on("timeout", () => { dsReq.destroy(); if (!res.headersSent) { res.writeHead(504); res.end(JSON.stringify({ error: { message: "timeout" } })); } });
      dsReq.write(JSON.stringify(chatBody)); dsReq.end();
      return;
    }
  } catch (e) {
    log.err("request: " + e.message);
    if (!res.headersSent) return sendJson(res, 400, { error: { message: e.message } });
  }

  sendJson(res, 404, { error: { message: "not found: " + url.pathname } });
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.log("");
    log.err(`端口 ${PORT} 已被占用，服务未启动。`);
    log.info("如果 DeepSeek Switch 已经在运行，请直接打开 http://127.0.0.1:" + PORT + "/");
    log.info("如果需要换端口，请在页面设置中修改端口，或编辑 config.json 后重新启动。");
    console.log("");
    process.exit(1);
  }
  log.err("server: " + error.message);
  process.exit(1);
});

server.listen(PORT, "127.0.0.1", () => {
  const config = loadConfig();
  console.log("");
  log.ok("ccswitch-deepseek started");
  log.info("UI: http://127.0.0.1:" + PORT + "/");
  log.info("API: http://127.0.0.1:" + PORT + "/v1/responses");
  log.info("model: " + config.model);
  if (!config.apiKey) log.warn("api_key not set");
  console.log("");
});
