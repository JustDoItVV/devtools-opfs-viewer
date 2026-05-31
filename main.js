"use strict";

const SIZE_UNITS = ["KB", "MB", "GB", "TB"];
const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|xhtml\+xml|x-ndjson))/;
const JSON_MIME = /^application\/json\b/;
const JSON_EXT = /\.json$/i;
const JSON_LEADING = /^\s*[{[]/;
const TWISTY = { open: "▾", closed: "▸" };
const ROW_PADDING_BASE = 8;
const INDENT_STEP = 14;

const tabId = chrome.devtools.inspectedWindow.tabId;
const treeEl = document.getElementById("tree");
const viewerEl = document.getElementById("viewer");
const statusEl = document.getElementById("status");
const refreshBtn = document.getElementById("refresh");

function ask(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ ...message, tabId }, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        resolve(res ?? { ok: false, error: "No response from background" });
      }
    });
  });
}

function setStatus(text, isError) {
  statusEl.textContent = text || "";
  statusEl.classList.toggle("error", Boolean(isError));
}

function formatSize(bytes) {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < SIZE_UNITS.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${SIZE_UNITS[i]}`;
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const len = bin.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function decodeIfText(bytes, mime) {
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) return null; // NUL byte ⇒ treat as binary
  }
  const hint = mime && TEXT_TYPES.test(mime);
  try {
    return new TextDecoder("utf-8", { fatal: !hint }).decode(bytes);
  } catch {
    return null;
  }
}

function prettyIfJson(text, name, mime) {
  const looksJson =
    (mime && JSON_MIME.test(mime)) || JSON_EXT.test(name) || JSON_LEADING.test(text);
  if (!looksJson) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function triggerDownload(bytes, name, mime) {
  const blob = new Blob([bytes], { type: mime || "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

const collapsed = new Set();
let selectedPath = null;
let selectedRow = null;

function selectRow(rowEl, path) {
  if (selectedRow) selectedRow.classList.remove("selected");
  selectedRow = rowEl;
  selectedPath = path;
  rowEl.classList.add("selected");
}

function makeRow(node, depth) {
  const rowEl = document.createElement("div");
  rowEl.className = `row ${node.kind}`;
  rowEl.style.paddingLeft = `${ROW_PADDING_BASE + depth * INDENT_STEP}px`;

  const twistyEl = document.createElement("span");
  twistyEl.className = "twisty";
  twistyEl.textContent = node.kind === "directory" ? TWISTY.open : "";
  rowEl.appendChild(twistyEl);

  const nameEl = document.createElement("span");
  nameEl.className = "name";
  nameEl.textContent = node.name;
  nameEl.title = node.path;
  rowEl.appendChild(nameEl);

  if (node.kind === "file" && !node.error) {
    const metaEl = document.createElement("span");
    metaEl.className = "meta";
    metaEl.textContent = formatSize(node.size);
    rowEl.appendChild(metaEl);
  }

  if (node.error) {
    const errEl = document.createElement("span");
    errEl.className = "err";
    errEl.textContent = node.error;
    errEl.title = node.error;
    rowEl.appendChild(errEl);
  }

  return { rowEl, twistyEl };
}

function renderTree(tree) {
  treeEl.replaceChildren();
  selectedRow = null;

  const rootKids = tree.children || [];
  if (rootKids.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "No OPFS entries for this origin.";
    treeEl.appendChild(empty);
    return;
  }

  const stack = [{ children: rootKids, container: treeEl, depth: 0 }];
  while (stack.length) {
    const job = stack.pop();
    const kids = job.children;
    for (let i = 0; i < kids.length; i++) {
      const node = kids[i];
      const built = makeRow(node, job.depth);
      job.container.appendChild(built.rowEl);

      if (node.kind === "directory") {
        const childContainer = document.createElement("div");
        const isCollapsed = collapsed.has(node.path);
        childContainer.style.display = isCollapsed ? "none" : "";
        built.twistyEl.textContent = isCollapsed ? TWISTY.closed : TWISTY.open;
        job.container.appendChild(childContainer);

        built.twistyEl.addEventListener("click", (ev) => {
          ev.stopPropagation();
          const hide = childContainer.style.display !== "none";
          childContainer.style.display = hide ? "none" : "";
          built.twistyEl.textContent = hide ? TWISTY.closed : TWISTY.open;
          if (hide) collapsed.add(node.path);
          else collapsed.delete(node.path);
        });

        stack.push({
          children: node.children || [],
          container: childContainer,
          depth: job.depth + 1,
        });
      } else if (!node.error) {
        if (node.path === selectedPath) selectRow(built.rowEl, node.path);
        built.rowEl.addEventListener("click", () => {
          selectRow(built.rowEl, node.path);
          openFile(node);
        });
      }
    }
  }
}

function viewerNotice(text) {
  viewerEl.replaceChildren();
  const div = document.createElement("div");
  div.className = "notice";
  div.textContent = text;
  viewerEl.appendChild(div);
}

function makeHead(node, res) {
  const head = document.createElement("div");
  head.className = "viewer-head";

  const title = document.createElement("span");
  title.className = "title";
  title.textContent = node.name;
  title.title = node.path;
  head.appendChild(title);

  const sub = document.createElement("span");
  sub.className = "sub";
  sub.textContent = `${formatSize(res.size)}${res.type ? ` · ${res.type}` : ""}`;
  head.appendChild(sub);

  return head;
}

function addDownloadButton(head, onClick) {
  const dl = document.createElement("button");
  dl.type = "button";
  dl.textContent = "Download";
  dl.addEventListener("click", onClick);
  head.appendChild(dl);
}

function renderViewer(node, res) {
  viewerEl.replaceChildren();
  const head = makeHead(node, res);

  if (res.tooBig) {
    addDownloadButton(head, () => downloadFull(node));
    viewerEl.appendChild(head);
    appendNotice(`File is ${formatSize(res.size)} — too large to preview inline.`);
    return;
  }

  const bytes = base64ToBytes(res.base64);
  addDownloadButton(head, () => triggerDownload(bytes, node.name, res.type));
  viewerEl.appendChild(head);

  const text = decodeIfText(bytes, res.type);
  if (text === null) {
    appendNotice("Binary file — use Download to save it.");
  } else {
    const pre = document.createElement("pre");
    pre.textContent = prettyIfJson(text, node.name, res.type);
    viewerEl.appendChild(pre);
  }
}

function appendNotice(text) {
  const div = document.createElement("div");
  div.className = "notice";
  div.textContent = text;
  viewerEl.appendChild(div);
}

async function openFile(node) {
  viewerNotice("Loading…");
  const res = await ask({ type: "readFile", path: node.path });
  if (!res.ok) {
    viewerNotice(`Error: ${res.error}`);
    return;
  }
  renderViewer(node, res);
}

async function downloadFull(node) {
  setStatus("Downloading…");
  const res = await ask({ type: "readFile", path: node.path, maxBytes: Number.MAX_SAFE_INTEGER });
  setStatus("");
  if (!res.ok || res.tooBig || !res.base64) {
    setStatus(res.error || "Download failed", true);
    return;
  }
  triggerDownload(base64ToBytes(res.base64), node.name, res.type);
}

let loading = false;

async function refresh() {
  if (loading) return;
  loading = true;
  refreshBtn.disabled = true;
  setStatus("Reading OPFS…");
  treeEl.replaceChildren();

  const res = await ask({ type: "readTree" });

  loading = false;
  refreshBtn.disabled = false;

  if (!res.ok) {
    setStatus(res.error, true);
    return;
  }
  renderTree(res.tree);
  setStatus("");
}

// OPFS has no change events, so re-read on natural cues instead of polling:
// navigation, panel shown (devtools.js), and focus returning to the panel.
// Expand/collapse and selection survive re-reads, so this stays unobtrusive.
window.refreshOpfs = refresh;
chrome.devtools.network.onNavigated.addListener(refresh);
window.addEventListener("focus", refresh);
refreshBtn.addEventListener("click", refresh);
refresh();
