// OPFS is origin-sandboxed, so the DevTools panel can't read it directly. It
// asks this worker, which runs the reader inside the inspected tab via
// chrome.scripting (which awaits the async injected function) and relays back.

const POOL_LIMIT = 16;
const MAX_INLINE_BYTES = 5_000_000;

async function readOpfsTree(limit) {
  // Bounded task pool: a slot is held only for one task. Listing a dir does not
  // hold a slot across its child getFile() tasks — it schedules them and
  // returns — so listing and getFile share the cap without deadlocking.
  function createPool(max) {
    let active = 0;
    const queue = [];
    let onDrain;
    const drained = new Promise((resolve) => {
      onDrain = resolve;
    });

    const pump = () => {
      while (active < max && queue.length) {
        const task = queue.shift();
        active++;
        task()
          .catch(() => {})
          .finally(() => {
            active--;
            if (active === 0 && queue.length === 0) onDrain();
            else pump();
          });
      }
    };

    return {
      schedule(task) {
        queue.push(task);
        pump();
      },
      drained,
    };
  }

  try {
    const root = await navigator.storage.getDirectory();
    const rootNode = { name: "(root)", kind: "directory", path: "", children: [] };
    const pool = createPool(Math.max(1, limit | 0));

    const listDir = async (dir, node, path) => {
      const children = [];
      try {
        for await (const handle of dir.values()) {
          const name = handle.name;
          const childPath = path ? `${path}/${name}` : name;
          if (handle.kind === "directory") {
            const child = { name, kind: "directory", path: childPath, children: [] };
            children.push(child);
            pool.schedule(() => listDir(handle, child, childPath));
          } else {
            const fileNode = { name, kind: "file", path: childPath };
            children.push(fileNode);
            pool.schedule(async () => {
              try {
                const file = await handle.getFile();
                fileNode.size = file.size;
                fileNode.type = file.type;
                fileNode.lastModified = file.lastModified;
              } catch (e) {
                fileNode.error = String(e); // locked file (open SyncAccessHandle)
              }
            });
          }
        }
      } catch (e) {
        node.error = String(e);
      }
      node.children = children;
    };

    pool.schedule(() => listDir(root, rootNode, ""));
    await pool.drained;

    return { ok: true, tree: rootNode };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

async function readOpfsFile(path, maxBytes) {
  try {
    const root = await navigator.storage.getDirectory();
    const parts = path.split("/");
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      dir = await dir.getDirectoryHandle(parts[i]);
    }
    const fh = await dir.getFileHandle(parts[parts.length - 1]);
    const file = await fh.getFile();

    if (file.size > maxBytes) {
      return { ok: true, tooBig: true, size: file.size, type: file.type };
    }

    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return {
      ok: true,
      base64: btoa(binary),
      size: file.size,
      type: file.type,
      name: parts[parts.length - 1],
    };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const { tabId } = msg || {};
  if (typeof tabId !== "number") {
    sendResponse({ ok: false, error: "Missing tabId" });
    return;
  }

  const run = (func, args = []) =>
    chrome.scripting
      .executeScript({ target: { tabId }, func, args })
      .then((results) => sendResponse(results[0]?.result))
      .catch((e) => sendResponse({ ok: false, error: String(e) }));

  if (msg.type === "readTree") {
    run(readOpfsTree, [POOL_LIMIT]);
  } else if (msg.type === "readFile") {
    run(readOpfsFile, [msg.path, msg.maxBytes ?? MAX_INLINE_BYTES]);
  } else {
    sendResponse({ ok: false, error: `Unknown message type: ${msg.type}` });
    return;
  }

  return true;
});
