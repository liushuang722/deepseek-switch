const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const form = $("#configForm");
const fields = {
  apiKey: $("#apiKey"),
  model: $("#model"),
  port: $("#port"),
  currency: $("#currency"),
  inputPrice: $("#inputPrice"),
  cacheInputPrice: $("#cacheInputPrice"),
  outputPrice: $("#outputPrice"),
};
const modelCards = $$("#modelCards button");

let currentConfig = null;
let apiKeyVisible = false;
let currentRange = "today";
let currentSection = "overview";
let selectedUsageModel = "__all";
let lastStats = null;

function setMessage(text, type = "info") {
  const message = $("#message");
  message.textContent = text || "";
  message.dataset.type = type;
}

function setButtonBusy(button, busyText) {
  button.disabled = true;
  button.dataset.previousText = button.textContent;
  button.textContent = busyText;
}

function resetButton(button) {
  button.disabled = false;
  if (button.dataset.previousText) {
    button.textContent = button.dataset.previousText;
    delete button.dataset.previousText;
  }
}

function showSuccessDialog(text) {
  $("#successDialogText").textContent = text;
  $("#successDialog").hidden = false;
  $("#successDialogOk").focus();
}

function hideSuccessDialog() {
  $("#successDialog").hidden = true;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  }[char]));
}

function fmtInt(value) { return Number(value || 0).toLocaleString("zh-CN"); }
function fmtTime(value) { return value ? new Date(value).toLocaleString("zh-CN") : "—"; }
function fmtPercent(value) { return value == null ? "—" : `${(value * 100).toFixed(1)}%`; }
function fmtCost(cost) {
  if (!cost || !cost.configured || cost.estimated == null) return "—";
  return `${cost.currency || "USD"} ${Number(cost.estimated).toFixed(6)}`;
}
function streamLabel(value) { return value ? "流式" : "非流式"; }

function pricingFromFields() {
  return {
    currency: fields.currency.value.trim() || "USD",
    inputPerMTok: Number(fields.inputPrice.value) || 0,
    cacheHitInputPerMTok: Number(fields.cacheInputPrice.value) || 0,
    outputPerMTok: Number(fields.outputPrice.value) || 0,
  };
}

function showSection(section) {
  currentSection = section;
  $$(".dashboard-section").forEach((item) => item.classList.toggle("active", item.dataset.section === section));
  syncNavigation();
}

function syncNavigation() {
  $$('[data-nav]').forEach((button) => button.classList.toggle("active", button.dataset.nav === currentSection));
}

function syncEndpoints() {
  const port = fields.port.value || 11435;
  const baseUrl = `http://127.0.0.1:${port}/v1`;
  $("#baseUrl").textContent = baseUrl;
  $("#endpoint").textContent = `${baseUrl}/responses`;
  const sidebarBaseUrl = $("#sidebarBaseUrl");
  if (sidebarBaseUrl) sidebarBaseUrl.textContent = `127.0.0.1:${port}`;
}

function syncModelCards() {
  const model = fields.model.value.trim();
  let matchedPreset = false;
  modelCards.forEach((button) => {
    const active = button.dataset.model && button.dataset.model === model;
    if (active) matchedPreset = true;
    button.classList.toggle("active", active);
  });
  const customButton = $("#customModelButton");
  if (customButton) customButton.classList.toggle("active", Boolean(model) && !matchedPreset);
  $("#overviewCurrentModel").textContent = model || "—";
}

function syncApiKeyVisibility() {
  const toggle = $("#toggleApiKey");
  fields.apiKey.type = apiKeyVisible ? "text" : "password";
  toggle.textContent = apiKeyVisible ? "隐藏" : "显示";
  toggle.setAttribute("aria-label", apiKeyVisible ? "隐藏 API Key" : "显示 API Key");
  toggle.setAttribute("aria-pressed", String(apiKeyVisible));
}

function applyConfig(config) {
  currentConfig = config;
  fields.model.value = config.model || "deepseek-v4-pro";
  fields.port.value = config.port || 11435;
  fields.currency.value = config.pricing?.currency || "USD";
  fields.inputPrice.value = config.pricing?.inputPerMTok || "";
  fields.cacheInputPrice.value = config.pricing?.cacheHitInputPerMTok || "";
  fields.outputPrice.value = config.pricing?.outputPerMTok || "";

  const configured = Boolean(config.hasApiKey);
  $("#statusBadge").textContent = configured ? "运行中" : "缺少 API Key";
  $("#statusText").textContent = configured ? `模型：${fields.model.value}` : "请先保存 DeepSeek API Key";
  $("#statusDot").classList.toggle("ok", configured);
  $("#keyHint").textContent = configured ? `已保存：${config.apiKeyPreview}` : "尚未保存 API Key。";
  fields.apiKey.value = "";
  apiKeyVisible = false;
  syncApiKeyVisibility();
  syncEndpoints();
  syncModelCards();
}

function renderModels(models = []) {
  const body = $("#modelsBody");
  if (!models.length) {
    body.innerHTML = '<tr><td colspan="8" class="empty-cell">暂无模型用量。开始使用 Codex 后会显示统计。</td></tr>';
    return;
  }
  body.innerHTML = models.map((item) => `
    <tr data-model="${escapeHtml(item.model)}">
      <td>${escapeHtml(item.model)}</td>
      <td>${fmtInt(item.requests)}</td>
      <td>${fmtInt(item.tokens?.cacheHit)}</td>
      <td>${fmtInt(item.tokens?.cacheMiss)}</td>
      <td>${fmtInt(item.tokens?.input)}</td>
      <td>${fmtInt(item.tokens?.output)}</td>
      <td>${fmtInt(item.tokens?.total)}</td>
      <td>${fmtCost(item.cost)}</td>
    </tr>
  `).join("");
}

function renderUsageModelOptions(models = []) {
  const select = $("#usageModelSelect");
  select.innerHTML = '<option value="__all">全部模型</option>' + models.map((item) => `<option value="${escapeHtml(item.model)}">${escapeHtml(item.model)}</option>`).join("");
  select.value = models.some((item) => item.model === selectedUsageModel) ? selectedUsageModel : "__all";
  if (select.value === "__all") selectedUsageModel = "__all";
}

function aggregateForSelectedModel() {
  if (!lastStats || selectedUsageModel === "__all") return lastStats;
  return lastStats.models?.find((item) => item.model === selectedUsageModel) || null;
}

function renderUsageForSelectedModel() {
  const item = aggregateForSelectedModel();
  const isAll = selectedUsageModel === "__all";
  $("#usageFilterTitle").textContent = isAll ? "全部模型明细" : "模型明细";
  $("#usageDetailModel").textContent = isAll ? "全部" : selectedUsageModel;
  $("#usageDetailRequests").textContent = fmtInt(item?.requests);
  $("#usageDetailTotal").textContent = fmtInt(item?.tokens?.total);
  $("#usageDetailCacheRate").textContent = fmtPercent(item?.cache?.hitRate);
  $("#usageDetailCost").textContent = fmtCost(item?.cost);
}

function renderUsageLog(records = []) {
  const body = $("#usageLogBody");
  if (!records.length) {
    body.innerHTML = '<tr><td colspan="7" class="empty-cell">暂无请求记录</td></tr>';
    $("#usageLogHint").textContent = "展示最新本地记录。";
    return;
  }
  $("#usageLogHint").textContent = `展示最近 ${records.length} 条本地记录。`;
  body.innerHTML = records.map((item) => `
    <tr>
      <td>${fmtTime(item.at)}</td>
      <td>${escapeHtml(item.model)}</td>
      <td>${streamLabel(item.stream)}</td>
      <td>${fmtInt(item.tokens?.input)}</td>
      <td>${fmtInt(item.tokens?.output)}</td>
      <td>${fmtInt(item.tokens?.total)}</td>
      <td>${fmtCost(item.cost)}</td>
    </tr>
  `).join("");
}

function applyStats(stats) {
  lastStats = stats || {};
  const tokens = lastStats.tokens || {};
  const cache = lastStats.cache || {};
  const last = lastStats.recent?.[0] || lastStats.lastRequest || null;

  $("#requestCount").textContent = fmtInt(lastStats.requests);
  $("#totalTokens").textContent = fmtInt(tokens.total);
  $("#outputTokens").textContent = fmtInt(tokens.output);
  $("#cacheRate").textContent = fmtPercent(cache.hitRate);
  $("#updatedAt").textContent = lastStats.updatedAt ? `更新于 ${fmtTime(lastStats.updatedAt)}` : "暂无更新";
  $("#overviewTotalTokens").textContent = fmtInt(tokens.total);
  $("#overviewRequests").textContent = `${fmtInt(lastStats.requests)} 次请求`;
  $("#overviewCacheRate").textContent = fmtPercent(cache.hitRate);
  const overviewCost = $("#overviewCost");
  if (overviewCost) overviewCost.textContent = fmtCost(lastStats.cost);
  $("#cacheHitInputTokens").textContent = fmtInt(tokens.cacheHit);
  $("#cacheMissInputTokens").textContent = fmtInt(tokens.cacheMiss);
  $("#cacheHitTokens").textContent = fmtInt(tokens.cacheHit);
  $("#cacheMissTokens").textContent = fmtInt(tokens.cacheMiss);
  $("#cacheBar").style.width = cache.hitRate == null ? "0%" : `${Math.max(0, Math.min(100, cache.hitRate * 100))}%`;

  $("#lastAt").textContent = fmtTime(last?.at);
  $("#lastModel").textContent = last?.model || "—";
  $("#lastMode").textContent = last ? streamLabel(last.stream) : "—";
  $("#lastTokens").textContent = last?.tokens ? fmtInt(last.tokens.total) : "—";
  $("#lastCost").textContent = fmtCost(last?.cost);

  renderModels(lastStats.models || []);
  renderUsageModelOptions(lastStats.models || []);
  renderUsageForSelectedModel();
  renderUsageLog(lastStats.recent || []);
}

function syncRangeTabs() {
  $$("#rangeTabs button").forEach((button) => button.classList.toggle("active", button.dataset.range === currentRange));
}

async function loadConfig() {
  const res = await fetch("/api/config");
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || "读取配置失败");
  applyConfig(data);
}

async function loadStats() {
  const res = await fetch(`/api/stats?range=${encodeURIComponent(currentRange)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || "读取用量失败");
  applyStats(data);
}

async function saveConfig(extra = {}, options = {}) {
  const payload = {
    model: fields.model.value.trim(),
    port: Number(fields.port.value) || 11435,
    pricing: pricingFromFields(),
    ...extra,
  };
  if (fields.apiKey.value.trim()) payload.apiKey = fields.apiKey.value.trim();

  const res = await fetch("/api/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || "保存失败");
  applyConfig(data);
  await loadStats();
  if (!options.silent) {
    setMessage(data.restartRequired ? "保存成功。端口变化需要重启 start.bat 和 Codex。" : "保存成功。", "success");
  }
  return data;
}

function canWriteCodexConfig() {
  if (!fields.model.value.trim()) {
    setMessage("请先选择或填写模型，然后再写入 Codex 配置。", "error");
    showSection("config");
    fields.model.focus();
    return false;
  }
  if (!currentConfig?.hasApiKey && !fields.apiKey.value.trim()) {
    setMessage("请先填写并保存 DeepSeek API Key，然后再写入 Codex 配置。", "error");
    showSection("config");
    fields.apiKey.focus();
    return false;
  }
  return true;
}

modelCards.forEach((button) => {
  button.addEventListener("click", () => {
    if (!button.dataset.model) {
      fields.model.focus();
      syncModelCards();
      return;
    }
    fields.model.value = button.dataset.model;
    syncModelCards();
  });
});

$$('[data-nav]').forEach((button) => button.addEventListener("click", (event) => {
  event.preventDefault();
  showSection(button.dataset.nav);
}));
fields.model.addEventListener("input", syncModelCards);
fields.port.addEventListener("input", syncEndpoints);

$("#usageModelSelect").addEventListener("change", (event) => {
  selectedUsageModel = event.target.value;
  renderUsageForSelectedModel();
});

$("#modelsBody").addEventListener("click", (event) => {
  const row = event.target.closest("tr[data-model]");
  if (!row) return;
  selectedUsageModel = row.dataset.model;
  renderUsageModelOptions(lastStats?.models || []);
  renderUsageForSelectedModel();
  showSection("usage");
});

$("#toggleApiKey").addEventListener("click", () => {
  apiKeyVisible = !apiKeyVisible;
  syncApiKeyVisibility();
});
$("#successDialogOk").addEventListener("click", hideSuccessDialog);
$("#openDocs").addEventListener("click", () => showSection("docs"));

const saveSettingsButton = $("#saveSettings");
if (saveSettingsButton) {
  saveSettingsButton.addEventListener("click", async () => {
    setButtonBusy(saveSettingsButton, "保存中...");
    setMessage("正在保存设置...", "loading");
    try { await saveConfig(); }
    catch (error) { setMessage(error.message, "error"); }
    finally { resetButton(saveSettingsButton); }
  });
}

const refreshOverviewButton = $("#refreshOverview");
if (refreshOverviewButton) {
  refreshOverviewButton.addEventListener("click", async () => {
    setButtonBusy(refreshOverviewButton, "刷新中...");
    try {
      await Promise.all([loadConfig(), loadStats()]);
      setMessage("状态已刷新。", "success");
    } catch (error) {
      setMessage(error.message, "error");
    } finally {
      resetButton(refreshOverviewButton);
    }
  });
}

const healthCheckButton = $("#healthCheck");
if (healthCheckButton) {
  healthCheckButton.addEventListener("click", async () => {
    setButtonBusy(healthCheckButton, "检查中...");
    try {
      const res = await fetch("/health");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error?.message || "服务异常");
      setMessage(`服务正常：${data.model || "unknown"}`, "success");
    } catch (error) {
      setMessage(error.message, "error");
    } finally {
      resetButton(healthCheckButton);
    }
  });
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setMessage("正在自动配置 Codex...", "loading");
  try {
    await saveConfig({}, { silent: true });
    if (!canWriteCodexConfig()) return;
    const res = await fetch("/api/codex-config", { method: "POST" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || "写入失败");
    setMessage("Codex 自动配置成功！", "success");
    showSuccessDialog("Codex 自动配置成功！请重新打开 Codex CLI。 ");
  } catch (error) {
    setMessage(error.message, "error");
  }
});

$("#clearKey").addEventListener("click", async () => {
  if (!confirm("确定清除已保存的 API Key？")) return;
  try { await saveConfig({ clearApiKey: true }); }
  catch (error) { setMessage(error.message, "error"); }
});

$("#refreshStats").addEventListener("click", async () => {
  const button = $("#refreshStats");
  setButtonBusy(button, "刷新中...");
  setMessage("正在刷新用量数据...", "loading");
  try {
    await loadStats();
    setMessage(`用量数据已刷新：${fmtTime(new Date().toISOString())}`, "success");
  } catch (error) {
    setMessage(error.message, "error");
  } finally {
    resetButton(button);
  }
});

$$("#rangeTabs button").forEach((button) => {
  button.addEventListener("click", () => {
    currentRange = button.dataset.range;
    syncRangeTabs();
    loadStats().catch((error) => setMessage(error.message, "error"));
  });
});

$("#resetStats").addEventListener("click", async () => {
  if (!confirm("确定清空本地使用统计？")) return;
  selectedUsageModel = "__all";
  const res = await fetch("/api/stats/reset", { method: "POST" });
  if (!res.ok) return setMessage("清空统计失败", "error");
  applyStats(await res.json());
  setMessage("统计已清空。", "success");
});

async function copyTextFromElement(elementSelector, buttonSelector, successText) {
  const text = $(elementSelector).textContent;
  try {
    await navigator.clipboard.writeText(text);
    setMessage(successText, "success");
    const button = $(buttonSelector);
    const previous = button.textContent;
    button.textContent = "已复制";
    setTimeout(() => { button.textContent = previous; }, 1500);
  } catch {
    setMessage(text, "info");
  }
}

$("#copyEndpoint").addEventListener("click", () => copyTextFromElement("#endpoint", "#copyEndpoint", "Responses Endpoint 已复制。"));
const copyBaseUrlButton = $("#copyBaseUrl");
if (copyBaseUrlButton) copyBaseUrlButton.addEventListener("click", () => copyTextFromElement("#baseUrl", "#copyBaseUrl", "Base URL 已复制。"));

showSection(currentSection);
Promise.all([loadConfig(), loadStats()]).catch((error) => {
  $("#statusBadge").textContent = "异常";
  $("#statusText").textContent = "读取失败";
  $("#statusDot").classList.add("error");
  setMessage(error.message, "error");
});

setInterval(() => {
  if (document.visibilityState === "visible") loadStats().catch(() => {});
}, 7000);

