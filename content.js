"use strict";

(() => {
  const MESSAGE_TYPES = {
    collectSidebar: "DEEPSEEK_COLLECT_SIDEBAR",
    exportCurrent: "DEEPSEEK_EXPORT_CURRENT_CONVERSATION",
    cancelCurrentExport: "DEEPSEEK_CANCEL_CURRENT_EXPORT"
  };
  const EXPORT_CANCELLED_ERROR = "导出已终止。";

  let activeExportContext = null;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || !message.type) {
      return false;
    }

    if (message.type === MESSAGE_TYPES.collectSidebar) {
      try {
        sendResponse({
          ok: true,
          conversations: collectSidebarConversations()
        });
      } catch (error) {
        sendResponse({
          ok: false,
          error: error.message || "读取侧边栏失败。"
        });
      }
      return false;
    }

    if (message.type === MESSAGE_TYPES.exportCurrent) {
      exportCurrentConversation({
        exportId: message.exportId,
        includeThinking: message.includeThinking !== false
      })
        .then((conversation) => sendResponse({ ok: true, conversation }))
        .catch((error) => sendResponse({
          ok: false,
          cancelled: Boolean(error && error.cancelled),
          error: error.message || "导出当前会话失败。"
        }));
      return true;
    }

    if (message.type === MESSAGE_TYPES.cancelCurrentExport) {
      sendResponse({
        ok: true,
        cancelled: cancelActiveExport(message.exportId)
      });
      return false;
    }

    return false;
  });

  function collectSidebarConversations() {
    const seen = new Set();
    const conversations = [];
    const links = Array.from(document.querySelectorAll('a[href*="/chat/s/"]'));

    links.forEach((link, index) => {
      const url = normalizeConversationUrl(link.href);
      if (!url || seen.has(url)) {
        return;
      }

      seen.add(url);
      conversations.push({
        id: conversationIdFromUrl(url),
        shortId: shortConversationId(url),
        title: cleanText(link.textContent),
        url,
        path: pathFromUrl(url),
        index,
        detectedAt: new Date().toISOString()
      });
    });

    const currentUrl = normalizeConversationUrl(location.href);
    if (currentUrl && !seen.has(currentUrl)) {
      conversations.unshift({
        id: conversationIdFromUrl(currentUrl),
        shortId: shortConversationId(currentUrl),
        title: titleFromDocument(),
        url: currentUrl,
        path: pathFromUrl(currentUrl),
        index: -1,
        detectedAt: new Date().toISOString()
      });
    }

    return conversations;
  }

  function createExportContext(exportId) {
    return {
      id: exportId || `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      cancelHandlers: new Set(),
      cancelled: false
    };
  }

  function cancelActiveExport(exportId) {
    const context = activeExportContext;
    if (!context || (exportId && context.id !== exportId)) {
      return false;
    }

    context.cancelled = true;
    for (const cancelHandler of Array.from(context.cancelHandlers)) {
      try {
        cancelHandler();
      } catch (_error) {
        // Keep cancellation best-effort if a waiter has already settled.
      }
    }
    context.cancelHandlers.clear();
    return true;
  }

  function clearExportContext(context) {
    context.cancelHandlers.clear();
    if (activeExportContext === context) {
      activeExportContext = null;
    }
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

  async function exportCurrentConversation(options) {
    const includeThinking = options && options.includeThinking !== false;
    const context = createExportContext(options && options.exportId);
    activeExportContext = context;

    try {
      await waitForConversationReady(20000, context);

      const collector = createMessageCollector(includeThinking, context);
      const scroller = findConversationScroller();

      if (scroller) {
        await scrollAndCollect(scroller, collector, context);
      } else {
        throwIfExportCancelled(context);
        collector.collect();
      }

      throwIfExportCancelled(context);
      const messages = collector.messages();
      if (!messages.length) {
        throw new Error("当前会话没有识别到可导出的消息。");
      }

      return {
        schemaVersion: 1,
        title: titleFromDocument(),
        url: normalizeConversationUrl(location.href) || location.href,
        exportedAt: new Date().toISOString(),
        messages,
        stats: {
          messageCount: messages.length,
          includeThinking,
          source: "dom"
        }
      };
    } finally {
      clearExportContext(context);
    }
  }

  async function waitForConversationReady(timeoutMs, context) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      throwIfExportCancelled(context);
      if (document.querySelector(".ds-message, .ds-assistant-message-main-content")) {
        await delay(300, context);
        return;
      }
      await delay(250, context);
    }

    throw new Error("等待 DeepSeek 会话内容加载超时。");
  }

  async function scrollAndCollect(scroller, collector, context) {
    await setScrollTop(scroller, 0, context);
    throwIfExportCancelled(context);
    collector.collect();

    let previousTop = -1;
    let stableSteps = 0;
    const maxSteps = 220;

    for (let step = 0; step < maxSteps; step += 1) {
      throwIfExportCancelled(context);
      const metrics = scrollMetrics(scroller);
      if (metrics.scrollTop + metrics.clientHeight >= metrics.scrollHeight - 8) {
        break;
      }

      const increment = Math.max(320, Math.floor(metrics.clientHeight * 0.75));
      const nextTop = Math.min(metrics.scrollTop + increment, metrics.scrollHeight - metrics.clientHeight);
      await setScrollTop(scroller, nextTop, context);
      throwIfExportCancelled(context);
      collector.collect();

      const nextMetrics = scrollMetrics(scroller);
      if (Math.abs(nextMetrics.scrollTop - previousTop) < 2) {
        stableSteps += 1;
      } else {
        stableSteps = 0;
      }

      previousTop = nextMetrics.scrollTop;
      if (stableSteps >= 4) {
        break;
      }
    }

    await setScrollTop(scroller, scrollMetrics(scroller).scrollHeight, context);
    throwIfExportCancelled(context);
    collector.collect();
  }

  function createMessageCollector(includeThinking, context) {
    const seen = new Set();
    const collected = [];

    return {
      collect() {
        for (const node of topLevelMessageNodes()) {
          throwIfExportCancelled(context);
          for (const part of extractMessageParts(node, includeThinking)) {
            throwIfExportCancelled(context);
            const content = normalizeMarkdown(part.content);
            if (!content) {
              continue;
            }

            const key = `${part.role}:${hashString(content)}`;
            if (seen.has(key)) {
              continue;
            }

            seen.add(key);
            collected.push({
              role: part.role,
              content,
              text: cleanText(part.node ? part.node.textContent : content)
            });
          }
        }
      },
      messages() {
        return collected.map((message, index) => ({
          index,
          role: message.role,
          content: message.content,
          text: message.text
        }));
      }
    };
  }

  function topLevelMessageNodes() {
    return Array.from(document.querySelectorAll(".ds-message"))
      .filter((node) => !node.parentElement || !node.parentElement.closest(".ds-message"))
      .filter((node) => cleanText(node.textContent).length > 0);
  }

  function extractMessageParts(node, includeThinking) {
    const assistantContent = node.querySelector(".ds-assistant-message-main-content");
    if (assistantContent) {
      const parts = [];
      const thinkingContent = node.querySelector(".ds-think-content .ds-markdown");
      if (includeThinking && thinkingContent && cleanText(thinkingContent.textContent)) {
        parts.push({
          role: "thinking",
          node: thinkingContent,
          content: htmlToMarkdown(thinkingContent)
        });
      }

      parts.push({
        role: "assistant",
        node: assistantContent,
        content: htmlToMarkdown(assistantContent)
      });
      return parts;
    }

    const userContent = findUserContentNode(node);
    if (userContent) {
      return [{
        role: "user",
        node: userContent,
        content: htmlToMarkdown(userContent)
      }];
    }

    return [{
      role: "unknown",
      node,
      content: htmlToMarkdown(node)
    }];
  }

  function findUserContentNode(messageNode) {
    const knownBubble = messageNode.querySelector(".fbb737a4");
    if (knownBubble && cleanText(knownBubble.textContent)) {
      return knownBubble;
    }

    const candidates = Array.from(messageNode.children)
      .filter((child) => !child.matches("button, [role='button']"))
      .filter((child) => !child.querySelector(".ds-assistant-message-main-content, .ds-think-content"))
      .map((child) => ({
        node: child,
        textLength: cleanText(child.textContent).length,
        buttonCount: child.querySelectorAll("button, [role='button']").length
      }))
      .filter((candidate) => candidate.textLength > 0)
      .sort((a, b) => (b.textLength - b.buttonCount * 80) - (a.textLength - a.buttonCount * 80));

    return candidates.length ? candidates[0].node : null;
  }

  function findConversationScroller() {
    const candidates = Array.from(document.querySelectorAll(".ds-virtual-list, [class*='ds-scroll-area'], main, [role='main'], div"))
      .filter((element) => {
        const metrics = scrollMetrics(element);
        return metrics.scrollHeight > metrics.clientHeight + 120
          && metrics.clientHeight > 180
          && (element.querySelector(".ds-message") || className(element).includes("ds-virtual-list"));
      })
      .map((element) => ({
        element,
        metrics: scrollMetrics(element),
        messageCount: element.querySelectorAll(".ds-message").length,
        classScore: className(element).includes("ds-virtual-list") ? 2 : 0
      }))
      .sort((a, b) => {
        const messageDelta = b.messageCount - a.messageCount;
        if (messageDelta !== 0) {
          return messageDelta;
        }
        const classDelta = b.classScore - a.classScore;
        if (classDelta !== 0) {
          return classDelta;
        }
        return b.metrics.clientHeight - a.metrics.clientHeight;
      });

    if (candidates.length) {
      return candidates[0].element;
    }

    const documentScroller = document.scrollingElement || document.documentElement;
    const metrics = scrollMetrics(documentScroller);
    return metrics.scrollHeight > metrics.clientHeight + 120 ? documentScroller : null;
  }

  async function setScrollTop(element, top, context) {
    element.scrollTop = top;
    element.dispatchEvent(new Event("scroll", { bubbles: true }));
    await delay(320, context);
  }

  function scrollMetrics(element) {
    return {
      scrollTop: element.scrollTop || 0,
      scrollHeight: element.scrollHeight || 0,
      clientHeight: element.clientHeight || 0
    };
  }

  function htmlToMarkdown(root) {
    return normalizeMarkdown(markdownChildren(root, {
      orderedDepth: 0,
      unorderedDepth: 0
    }));
  }

  function markdownChildren(node, context) {
    return Array.from(node.childNodes)
      .map((child) => markdownNode(child, context))
      .join("");
  }

  function markdownNode(node, context) {
    if (node.nodeType === Node.TEXT_NODE) {
      return node.textContent || "";
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return "";
    }

    const element = node;
    const tag = element.tagName.toLowerCase();

    if (element.matches("button, [role='button'], svg")) {
      return "";
    }

    if (tag === "br") {
      return "\n";
    }

    if (tag === "hr") {
      return "\n\n---\n\n";
    }

    if (tag === "pre") {
      const code = element.querySelector("code");
      const language = code ? languageFromClass(code.className) : "";
      const content = (code || element).textContent || "";
      return `\n\n\`\`\`${language}\n${content.replace(/\n+$/, "")}\n\`\`\`\n\n`;
    }

    if (tag === "code") {
      if (element.closest("pre")) {
        return element.textContent || "";
      }
      return inlineCode(element.textContent || "");
    }

    if (/^h[1-6]$/.test(tag)) {
      const level = Number(tag.slice(1));
      return `\n\n${"#".repeat(level)} ${normalizeInline(markdownChildren(element, context))}\n\n`;
    }

    if (tag === "p") {
      return `\n\n${normalizeInline(markdownChildren(element, context))}\n\n`;
    }

    if (tag === "strong" || tag === "b") {
      return `**${normalizeInline(markdownChildren(element, context))}**`;
    }

    if (tag === "em" || tag === "i") {
      return `*${normalizeInline(markdownChildren(element, context))}*`;
    }

    if (tag === "blockquote") {
      const content = normalizeMarkdown(markdownChildren(element, context));
      return `\n\n${content.split("\n").map((line) => `> ${line}`).join("\n")}\n\n`;
    }

    if (tag === "a") {
      const text = normalizeInline(markdownChildren(element, context)) || cleanText(element.textContent);
      const href = element.getAttribute("href");
      if (!href) {
        return text;
      }
      return `[${text}](${new URL(href, location.href).href})`;
    }

    if (tag === "ul") {
      return markdownList(element, false, context);
    }

    if (tag === "ol") {
      return markdownList(element, true, context);
    }

    if (tag === "table") {
      return `\n\n${cleanText(element.textContent)}\n\n`;
    }

    if (isBlockElement(tag)) {
      return `\n${markdownChildren(element, context)}\n`;
    }

    return markdownChildren(element, context);
  }

  function markdownList(element, ordered, context) {
    const items = Array.from(element.children).filter((child) => child.tagName.toLowerCase() === "li");
    const indentLevel = ordered ? context.orderedDepth : context.unorderedDepth;
    const indent = "  ".repeat(indentLevel);
    const childContext = {
      orderedDepth: ordered ? context.orderedDepth + 1 : context.orderedDepth,
      unorderedDepth: ordered ? context.unorderedDepth : context.unorderedDepth + 1
    };

    const content = items.map((item, index) => {
      const marker = ordered ? `${index + 1}.` : "-";
      const itemContent = normalizeMarkdown(markdownChildren(item, childContext))
        .split("\n")
        .map((line, lineIndex) => lineIndex === 0 ? line : `${indent}  ${line}`)
        .join("\n");
      return `${indent}${marker} ${itemContent}`;
    }).join("\n");

    return `\n\n${content}\n\n`;
  }

  function normalizeMarkdown(value) {
    return (value || "")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function normalizeInline(value) {
    return (value || "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function inlineCode(value) {
    const content = value.replace(/\s+/g, " ").trim();
    if (!content) {
      return "";
    }
    const fence = content.includes("`") ? "``" : "`";
    return `${fence}${content}${fence}`;
  }

  function isBlockElement(tag) {
    return new Set([
      "address",
      "article",
      "aside",
      "div",
      "footer",
      "header",
      "li",
      "main",
      "nav",
      "section"
    ]).has(tag);
  }

  function languageFromClass(value) {
    const match = String(value || "").match(/language-([A-Za-z0-9_+-]+)/);
    return match ? match[1] : "";
  }

  function normalizeConversationUrl(href) {
    try {
      const url = new URL(href, location.href);
      if (url.host !== "chat.deepseek.com") {
        return null;
      }
      if (!/\/chat\/s\/[^/?#]+/.test(url.pathname)) {
        return null;
      }
      url.search = "";
      url.hash = "";
      return url.href;
    } catch (_error) {
      return null;
    }
  }

  function conversationIdFromUrl(url) {
    const match = String(url || "").match(/\/chat\/s\/([^/?#]+)/);
    return match ? match[1] : "";
  }

  function shortConversationId(url) {
    return conversationIdFromUrl(url).slice(0, 8);
  }

  function pathFromUrl(url) {
    try {
      return new URL(url).pathname;
    } catch (_error) {
      return url;
    }
  }

  function titleFromDocument() {
    const activeUrl = normalizeConversationUrl(location.href);
    if (activeUrl) {
      const activeLink = Array.from(document.querySelectorAll('a[href*="/chat/s/"]'))
        .find((link) => normalizeConversationUrl(link.href) === activeUrl);
      const linkTitle = activeLink ? cleanText(activeLink.textContent) : "";
      if (linkTitle) {
        return linkTitle;
      }
    }

    const title = cleanText(document.title.replace(/\s*-\s*DeepSeek\s*$/i, ""));
    return title || "DeepSeek 会话";
  }

  function cleanText(value) {
    return String(value || "")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function className(element) {
    return String(element && element.className ? element.className : "");
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16);
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
})();
