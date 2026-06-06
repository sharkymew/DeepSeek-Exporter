"use strict";

const CHAT_HOST = "chat.deepseek.com";

const state = {
  conversations: new Map(),
  busy: false,
  cancelling: false,
  exporting: false
};

const elements = {
  statusText: document.getElementById("statusText"),
  refreshButton: document.getElementById("refreshButton"),
  selectAllButton: document.getElementById("selectAllButton"),
  clearButton: document.getElementById("clearButton"),
  clearCacheButton: document.getElementById("clearCacheButton"),
  exportButton: document.getElementById("exportButton"),
  cancelExportButton: document.getElementById("cancelExportButton"),
  conversationList: document.getElementById("conversationList"),
  includeThinkingInput: document.getElementById("includeThinkingInput")
};

document.addEventListener("DOMContentLoaded", () => {
  elements.refreshButton.addEventListener("click", refreshConversations);
  elements.selectAllButton.addEventListener("click", selectAllConversations);
  elements.clearButton.addEventListener("click", clearSelectedConversations);
  elements.clearCacheButton.addEventListener("click", clearExportCache);
  elements.exportButton.addEventListener("click", exportSelectedConversations);
  elements.cancelExportButton.addEventListener("click", cancelExport);
  elements.conversationList.addEventListener("change", handleListChange);
  refreshConversations();
});

async function refreshConversations() {
  setBusy(true);
  setStatus("正在读取 DeepSeek 侧边栏...");

  try {
    const tab = await findDeepSeekTab();
    if (!tab || typeof tab.id !== "number") {
      throw new Error("请先打开 chat.deepseek.com，再点击扩展。");
    }

    const response = await sendTabMessage(tab.id, {
      type: "DEEPSEEK_COLLECT_SIDEBAR"
    });

    const conversations = Array.isArray(response && response.conversations)
      ? response.conversations
      : [];

    mergeConversations(conversations);
    renderConversations();
    setStatus(`已识别 ${state.conversations.size} 个已加载会话。向下滚动侧边栏后可再次刷新。`);
  } catch (error) {
    setStatus(error.message || "读取会话失败。", true);
    renderConversations();
  } finally {
    setBusy(false);
  }
}

async function exportSelectedConversations() {
  const selected = getSelectedConversations();
  if (!selected.length || state.exporting) {
    return;
  }

  state.exporting = true;
  state.cancelling = false;
  setBusy(true);
  elements.exportButton.disabled = true;
  setStatus(`正在导出 ${selected.length} 个会话...`);

  try {
    const response = await sendRuntimeMessage({
      type: "DEEPSEEK_EXPORT_CONVERSATIONS",
      conversations: selected,
      includeThinking: elements.includeThinkingInput.checked
    });

    const failed = response && Array.isArray(response.errors) ? response.errors.length : 0;
    const succeeded = response && typeof response.succeeded === "number" ? response.succeeded : selected.length - failed;
    if (failed > 0) {
      setStatus(`导出完成：成功 ${succeeded} 个，失败 ${failed} 个。ZIP 内包含错误记录。`, true);
    } else {
      setStatus(`导出完成：成功 ${succeeded} 个会话。`);
    }
  } catch (error) {
    if (isCancelledExportError(error)) {
      setStatus("已终止导出，并释放本次缓存。");
    } else {
      setStatus(error.message || "导出失败。", true);
    }
  } finally {
    state.exporting = false;
    state.cancelling = false;
    setBusy(false);
    updateExportButton();
  }
}

async function cancelExport() {
  if (!state.exporting || state.cancelling) {
    return;
  }

  state.cancelling = true;
  setStatus("正在终止导出...");
  updateExportButton();

  try {
    await sendRuntimeMessage({
      type: "DEEPSEEK_CANCEL_EXPORT"
    });
  } catch (error) {
    if (!isCancelledExportError(error)) {
      state.cancelling = false;
      updateExportButton();
      setStatus(error.message || "终止导出失败。", true);
    }
  }
}

async function clearExportCache() {
  if (state.busy) {
    return;
  }

  setBusy(true);
  setStatus("正在清理缓存...");

  try {
    await sendRuntimeMessage({
      type: "DEEPSEEK_CLEAR_EXPORT_CACHE"
    });
    state.conversations.clear();
    renderConversations();
    setStatus("已清理缓存。");
  } catch (error) {
    setStatus(error.message || "清理缓存失败。", true);
  } finally {
    setBusy(false);
  }
}

function mergeConversations(conversations) {
  for (const conversation of conversations) {
    if (!conversation || !conversation.url) {
      continue;
    }

    const previous = state.conversations.get(conversation.url) || {};
    state.conversations.set(conversation.url, {
      ...previous,
      ...conversation,
      title: normalizeTitle(conversation.title, conversation.url),
      selected: previous.selected || false
    });
  }
}

function renderConversations() {
  const conversations = Array.from(state.conversations.values()).sort((a, b) => {
    const aIndex = typeof a.index === "number" ? a.index : Number.MAX_SAFE_INTEGER;
    const bIndex = typeof b.index === "number" ? b.index : Number.MAX_SAFE_INTEGER;
    return aIndex - bIndex || a.title.localeCompare(b.title);
  });

  elements.conversationList.innerHTML = "";

  if (!conversations.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "未识别到侧边栏会话。";
    elements.conversationList.appendChild(empty);
    updateExportButton();
    return;
  }

  for (const conversation of conversations) {
    const label = document.createElement("label");
    label.className = "conversation-item";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = Boolean(conversation.selected);
    checkbox.dataset.url = conversation.url;

    const content = document.createElement("span");
    const title = document.createElement("span");
    title.className = "conversation-title";
    title.textContent = conversation.title;

    const url = document.createElement("span");
    url.className = "conversation-url";
    url.textContent = conversation.path || conversation.url;

    content.appendChild(title);
    content.appendChild(url);
    label.appendChild(checkbox);
    label.appendChild(content);
    elements.conversationList.appendChild(label);
  }

  updateExportButton();
}

function handleListChange(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.type !== "checkbox" || !target.dataset.url) {
    return;
  }

  const conversation = state.conversations.get(target.dataset.url);
  if (conversation) {
    conversation.selected = target.checked;
  }
  updateExportButton();
}

function selectAllConversations() {
  for (const conversation of state.conversations.values()) {
    conversation.selected = true;
  }
  renderConversations();
}

function clearSelectedConversations() {
  for (const conversation of state.conversations.values()) {
    conversation.selected = false;
  }
  renderConversations();
}

function getSelectedConversations() {
  return Array.from(state.conversations.values())
    .filter((conversation) => conversation.selected)
    .map(({ selected, ...conversation }) => conversation);
}

function updateExportButton() {
  const selectedCount = getSelectedConversations().length;
  elements.exportButton.disabled = state.busy || state.exporting || selectedCount === 0;
  elements.exportButton.textContent = selectedCount > 0 ? `导出 ${selectedCount} 个会话` : "导出 ZIP";
  elements.cancelExportButton.disabled = !state.exporting || state.cancelling;
}

function setBusy(isBusy) {
  state.busy = isBusy;
  elements.refreshButton.disabled = isBusy;
  elements.selectAllButton.disabled = isBusy || state.conversations.size === 0;
  elements.clearButton.disabled = isBusy || state.conversations.size === 0;
  elements.clearCacheButton.disabled = isBusy;
  elements.includeThinkingInput.disabled = isBusy;
  updateExportButton();
}

function setStatus(text, isError = false) {
  elements.statusText.textContent = text;
  elements.statusText.classList.toggle("error", isError);
}

function normalizeTitle(title, url) {
  const cleaned = (title || "").replace(/\s+/g, " ").trim();
  if (cleaned) {
    return cleaned;
  }
  const shortId = shortConversationId(url);
  return shortId ? `DeepSeek 会话 ${shortId}` : "DeepSeek 会话";
}

function shortConversationId(url) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\/chat\/s\/([^/?#]+)/);
    return match ? match[1].slice(0, 8) : "";
  } catch (_error) {
    return "";
  }
}

async function findDeepSeekTab() {
  const activeTabs = await queryTabs({ active: true, currentWindow: true });
  const active = activeTabs[0];
  if (active && isDeepSeekUrl(active.url)) {
    return active;
  }

  const deepSeekTabs = await queryTabs({ url: "https://chat.deepseek.com/*" });
  return deepSeekTabs[0] || null;
}

function isDeepSeekUrl(url) {
  try {
    return new URL(url || "").host === CHAT_HOST;
  } catch (_error) {
    return false;
  }
}

function queryTabs(queryInfo) {
  return new Promise((resolve, reject) => {
    chrome.tabs.query(queryInfo, (tabs) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(tabs || []);
    });
  });
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(normalizeChromeMessageError(error.message)));
        return;
      }
      if (response && response.ok === false) {
        reject(new Error(response.error || "页面脚本返回错误。"));
        return;
      }
      resolve(response || {});
    });
  });
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      if (response && response.ok === false) {
        const responseError = new Error(response.error || "后台导出失败。");
        responseError.cancelled = Boolean(response.cancelled);
        reject(responseError);
        return;
      }
      resolve(response || {});
    });
  });
}

function isCancelledExportError(error) {
  return Boolean(error && (error.cancelled || error.message === "导出已终止。"));
}

function normalizeChromeMessageError(message) {
  if (/Receiving end does not exist/i.test(message || "")) {
    return "页面脚本尚未连接。请刷新 DeepSeek 页面后再试。";
  }
  return message || "扩展消息发送失败。";
}
