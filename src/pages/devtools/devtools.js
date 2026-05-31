chrome.devtools.panels.create("OPFS", "icons/48.png", "src/pages/panel/panel.html", (panel) => {
  panel.onShown.addListener((win) => {
    win.refreshOpfs?.();
  });
});
