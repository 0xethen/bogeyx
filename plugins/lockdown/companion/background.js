// Remembers which tabs have a lockdown page open and tells them when a new tab or window appears.
// It asks for no permission, so it can't see addresses or titles, only that something opened.
const KEY = "watching";

async function watching() {
  const stored = await chrome.storage.session.get(KEY);
  return new Set(stored[KEY] ?? []);
}

async function remember(tabs) {
  await chrome.storage.session.set({ [KEY]: [...tabs] });
}

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message && message.type === "watch" && sender.tab && sender.tab.id !== undefined) {
    const id = sender.tab.id;
    void watching().then((tabs) => remember(tabs.add(id)));
  }
});

async function opened(created) {
  const tabs = await watching();
  for (const id of tabs) {
    if (id === created) continue;
    chrome.tabs.sendMessage(id, { type: "new_window" }).catch(() => undefined);
  }
}

chrome.tabs.onCreated.addListener((tab) => void opened(tab.id));
chrome.windows.onCreated.addListener(() => void opened(undefined));
chrome.tabs.onRemoved.addListener((id) => {
  void watching().then((tabs) => {
    if (tabs.delete(id)) return remember(tabs);
    return undefined;
  });
});
