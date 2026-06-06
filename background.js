"use strict";

importScripts("zip.js");

const EXPORT_MESSAGE = "DEEPSEEK_EXPORT_CONVERSATIONS";
const CANCEL_EXPORT_MESSAGE = "DEEPSEEK_CANCEL_EXPORT";
const CLEAR_EXPORT_CACHE_MESSAGE = "DEEPSEEK_CLEAR_EXPORT_CACHE";
const CONTENT_EXPORT_MESSAGE = "DEEPSEEK_EXPORT_CURRENT_CONVERSATION";
const CONTENT_CANCEL_EXPORT_MESSAGE = "DEEPSEEK_CANCEL_CURRENT_EXPORT";
const EXPORT_CANCELLED_ERROR = "导出已终止。";

let activeExportContext = null;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }

  if (message.type === EXPORT_MESSAGE) {
    exportConversations(message)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({
        ok: false,
        cancelled: isExportCancelledError(error),
        error: error.message || "导出失败。"
      }));

    return true;
  }

  if (message.type === CANCEL_EXPORT_MESSAGE || message.type === CLEAR_EXPORT_CACHE_MESSAGE) {
    cancelActiveExport()
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({
        ok: false,
        error: error.message || "清理导出缓存失败。"
      }));

    return true;
  }

  return false;
});

async function exportConversations(payload) {
  const conversations = Array.isArray(payload.conversations) ? payload.conversations : [];
  const includeThinking = payload.includeThinking !== false;

  if (!conversations.length) {
    throw new Error("没有选择要导出的会话。");
  }

  if (activeExportContext) {
    throw new Error("已有导出任务正在运行。");
  }

  const exportedAt = new Date().toISOString();
  const context = createExportContext();
  const results = context.results;
  const errors = context.errors;
  activeExportContext = context;

  try {
    for (const conversation of conversations) {
      throwIfExportCancelled(context);

      try {
        const exported = await exportOneConversation(conversation, includeThinking, context);
        throwIfExportCancelled(context);
        results.push({
          ...exported,
          requestedTitle: conversation.title || "",
          exportedAt
        });
      } catch (error) {
        if (isExportCancelledError(error) || context.cancelled) {
          throw createExportCancelledError();
        }

        errors.push({
          title: conversation.title || "",
          url: conversation.url || "",
          error: error.message || "未知错误"
        });
      }
    }

    throwIfExportCancelled(context);

    if (!results.length) {
      throw new Error(errors[0] ? errors[0].error : "所有会话导出失败。");
    }

    const succeeded = results.length;
    const failed = errors.length;
    const responseErrors = errors.map((error) => ({ ...error }));

    throwIfExportCancelled(context);
    const zipBytes = DeepSeekZip.createZipBytes(buildZipEntries(results, errors, exportedAt));
    throwIfExportCancelled(context);

    const filename = `DeepSeek Export ${formatTimestampForFilename(new Date())}.zip`;
    await downloadBytes(zipBytes, filename);
    throwIfExportCancelled(context);

    return {
      succeeded,
      failed,
      errors: responseErrors,
      filename
    };
  } finally {
    clearExportContext(context);
  }
}

async function exportOneConversation(conversation, includeThinking, context) {
  if (!conversation || !isDeepSeekConversationUrl(conversation.url)) {
    throw new Error("会话 URL 无效。");
  }

  throwIfExportCancelled(context);

  const tab = await tabsCreate({
    url: conversation.url,
    active: false
  });
  const tabId = tab && typeof tab.id === "number" ? tab.id : null;
  if (typeof tabId !== "number") {
    throw new Error("无法创建导出标签页。");
  }
  context.currentTabId = tabId;
  context.tabIds.add(tabId);

  try {
    throwIfExportCancelled(context);
    await waitForTabComplete(tabId, 30000, context);
    throwIfExportCancelled(context);

    const response = await sendMessageToTabWithRetry(tabId, {
      type: CONTENT_EXPORT_MESSAGE,
      exportId: context.id,
      includeThinking
    }, 20, 600, context);

    if (!response || response.ok === false || !response.conversation) {
      throw new Error(response && response.error ? response.error : "页面没有返回会话内容。");
    }

    throwIfExportCancelled(context);
    return response.conversation;
  } finally {
    if (context.currentTabId === tabId) {
      context.currentTabId = null;
    }
    if (typeof tabId === "number") {
      await tabsRemove(tabId).catch(() => {});
      context.tabIds.delete(tabId);
    }
  }
}

function createExportContext() {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    cancelled: false,
    cancelHandlers: new Set(),
    currentTabId: null,
    errors: [],
    results: [],
    tabIds: new Set()
  };
}

async function cancelActiveExport() {
  const context = activeExportContext;
  if (!context) {
    return {
      cancelled: false,
      cleared: true
    };
  }

  cancelExportContext(context);
  await closeExportTabs(context);

  return {
    cancelled: true,
    cleared: true
  };
}

function cancelExportContext(context) {
  context.cancelled = true;
  clearExportCache(context);

  for (const cancelHandler of Array.from(context.cancelHandlers)) {
    try {
      cancelHandler();
    } catch (_error) {
      // Cancellation should continue even if one waiter has already settled.
    }
  }
  context.cancelHandlers.clear();
}

function clearExportContext(context) {
  clearExportCache(context);
  context.currentTabId = null;
  context.cancelHandlers.clear();
  context.tabIds.clear();

  if (activeExportContext === context) {
    activeExportContext = null;
  }
}

function clearExportCache(context) {
  context.results.length = 0;
  context.errors.length = 0;
}

async function closeExportTabs(context) {
  const tabIds = new Set(context.tabIds);
  if (typeof context.currentTabId === "number") {
    tabIds.add(context.currentTabId);
  }

  context.currentTabId = null;
  context.tabIds.clear();

  await Promise.all(Array.from(tabIds).map(async (tabId) => {
    tabsSendMessage(tabId, {
      type: CONTENT_CANCEL_EXPORT_MESSAGE,
      exportId: context.id
    }).catch(() => {});
    await tabsRemove(tabId).catch(() => {});
  }));
}

function throwIfExportCancelled(context) {
  if (context && context.cancelled) {
    throw createExportCancelledError();
  }
}

function createExportCancelledError() {
  const error = new Error(EXPORT_CANCELLED_ERROR);
  error.cancelled = true;
  return error;
}

function isExportCancelledError(error) {
  return Boolean(error && (error.cancelled || error.message === EXPORT_CANCELLED_ERROR));
}

function buildZipEntries(conversations, errors, exportedAt) {
  const entries = [];
  const usedDirectories = new Map();

  for (const conversation of conversations) {
    const directory = uniqueDirectoryName(conversation, usedDirectories);
    const normalized = normalizeConversation(conversation, exportedAt);

    entries.push({
      path: `${directory}/conversation.md`,
      data: conversationToMarkdown(normalized)
    });
    entries.push({
      path: `${directory}/conversation.json`,
      data: JSON.stringify(normalized, null, 2)
    });
  }

  if (errors.length) {
    entries.push({
      path: "_export_errors.json",
      data: JSON.stringify({
        schemaVersion: 1,
        exportedAt,
        errors
      }, null, 2)
    });
  }

  return entries;
}

function normalizeConversation(conversation, exportedAt) {
  return {
    schemaVersion: 1,
    title: cleanTitle(conversation.title || conversation.requestedTitle || "DeepSeek 会话"),
    url: conversation.url || "",
    exportedAt,
    messages: Array.isArray(conversation.messages) ? conversation.messages.map((message, index) => ({
      index,
      role: message.role || "unknown",
      content: String(message.content || ""),
      text: String(message.text || "")
    })) : []
  };
}

function conversationToMarkdown(conversation) {
  const lines = [
    `# ${conversation.title}`,
    "",
    `Source: ${conversation.url}`,
    `Exported: ${conversation.exportedAt}`,
    "",
    "---",
    ""
  ];

  for (const message of conversation.messages) {
    lines.push(`## ${roleLabel(message.role)}`);
    lines.push("");
    lines.push(message.content || message.text || "");
    lines.push("");
  }

  return lines.join("\n").replace(/\n{4,}/g, "\n\n\n").trimEnd() + "\n";
}

function roleLabel(role) {
  if (role === "user") {
    return "User";
  }
  if (role === "assistant") {
    return "Assistant";
  }
  if (role === "thinking") {
    return "Thinking";
  }
  return "Unknown";
}

function uniqueDirectoryName(conversation, usedDirectories) {
  const title = conversation.title || conversation.requestedTitle || "DeepSeek Conversation";
  const id = shortConversationId(conversation.url);
  const base = `${sanitizePathSegment(title)}${id ? `-${id}` : ""}`.slice(0, 120) || "DeepSeek Conversation";
  const count = usedDirectories.get(base) || 0;
  usedDirectories.set(base, count + 1);
  return count === 0 ? base : `${base}-${count + 1}`;
}

async function downloadBytes(bytes, filename) {
  const base64 = bytesToBase64(bytes);
  const url = `data:application/zip;base64,${base64}`;
  const downloadId = await downloadsDownload({
    url,
    filename,
    saveAs: true
  });
  return downloadId;
}

function bytesToBase64(bytes) {
  const chunkSize = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize));
  }
  return btoa(binary);
}

function sendMessageToTabWithRetry(tabId, message, attempts, delayMs, context) {
  return retry(async () => {
    throwIfExportCancelled(context);
    return raceWithCancellation(tabsSendMessage(tabId, message), context);
  }, attempts, delayMs, context);
}

function raceWithCancellation(promise, context) {
  if (!context) {
    return promise;
  }

  return new Promise((resolve, reject) => {
    throwIfExportCancelled(context);

    let settled = false;
    const cancelHandler = () => finish(createExportCancelledError());

    const finish = (error = null, value = null) => {
      if (settled) {
        return;
      }

      settled = true;
      context.cancelHandlers.delete(cancelHandler);

      if (error) {
        reject(error);
      } else {
        resolve(value);
      }
    };

    context.cancelHandlers.add(cancelHandler);
    promise.then(
      (value) => finish(null, value),
      (error) => finish(error)
    );
  });
}

async function retry(operation, attempts, delayMs, context) {
  let lastError = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    throwIfExportCancelled(context);
    try {
      return await operation();
    } catch (error) {
      throwIfExportCancelled(context);
      lastError = error;
      await delay(delayMs, context);
    }
  }
  throw lastError || new Error("重试失败。");
}

function waitForTabComplete(tabId, timeoutMs, context) {
  return new Promise((resolve, reject) => {
    throwIfExportCancelled(context);

    let settled = false;
    const timeoutId = setTimeout(() => {
      finish(new Error("等待标签页加载超时。"));
    }, timeoutMs);

    const cancelHandler = () => finish(createExportCancelledError());

    const finish = (error = null) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutId);
      chrome.tabs.onUpdated.removeListener(listener);
      chrome.tabs.onRemoved.removeListener(removedListener);
      if (context) {
        context.cancelHandlers.delete(cancelHandler);
      }

      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        finish();
      }
    };

    const removedListener = (removedTabId) => {
      if (removedTabId === tabId) {
        finish(context && context.cancelled ? createExportCancelledError() : new Error("导出标签页已关闭。"));
      }
    };

    if (context) {
      context.cancelHandlers.add(cancelHandler);
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.onRemoved.addListener(removedListener);
    chrome.tabs.get(tabId, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) {
        finish(new Error(error.message));
        return;
      }
      if (tab && tab.status === "complete") {
        finish();
      }
    });
  });
}

function tabsCreate(createProperties) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create(createProperties, (tab) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(tab);
    });
  });
}

function tabsRemove(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.remove(tabId, () => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function tabsSendMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(response);
    });
  });
}

function downloadsDownload(options) {
  return new Promise((resolve, reject) => {
    chrome.downloads.download(options, (downloadId) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(downloadId);
    });
  });
}

function isDeepSeekConversationUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:"
      && parsed.host === "chat.deepseek.com"
      && /\/chat\/s\/[^/?#]+/.test(parsed.pathname);
  } catch (_error) {
    return false;
  }
}

function cleanTitle(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizePathSegment(value) {
  const sanitized = cleanTitle(value)
    .replace(/[\\/:*?"<>|#%{}^~[\]`]/g, "-")
    .replace(/[\u0000-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+|\.+$/g, "");
  return sanitized || "DeepSeek Conversation";
}

function shortConversationId(url) {
  const match = String(url || "").match(/\/chat\/s\/([^/?#]+)/);
  return match ? match[1].slice(0, 8) : "";
}

function formatTimestampForFilename(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate())
  ].join("-") + " " + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("-");
}

function delay(ms, context) {
  if (!context) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  return new Promise((resolve, reject) => {
    throwIfExportCancelled(context);

    let settled = false;
    const timeoutId = setTimeout(() => finish(), ms);
    const cancelHandler = () => finish(createExportCancelledError());

    const finish = (error = null) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeoutId);
      context.cancelHandlers.delete(cancelHandler);

      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };

    context.cancelHandlers.add(cancelHandler);
  });
}
