// Runs on the instance's pages. It answers the lockdown page's hello with the page's own nonce
// and reports what it sees by postMessage. It reads nothing from the page and sends nothing anywhere else.
(() => {
  const PAGE = "bogey-lockdown";
  const COMPANION = "bogey-lockdown-companion";
  const VERSION = chrome.runtime.getManifest().version;
  const NONCE = /^[0-9a-f]{32}$/;

  let nonce = null;
  let beat = null;
  const last = new Map();

  function send(body) {
    if (nonce) window.postMessage({ source: COMPANION, nonce, ...body }, window.location.origin);
  }

  // one report per kind every two seconds, so a held key can't flood the page
  function signal(kind) {
    const now = Date.now();
    if (now - (last.get(kind) ?? 0) < 2000) return;
    last.set(kind, now);
    send({ type: "signal", kind });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || data.source !== PAGE || data.type !== "hello" || !NONCE.test(String(data.nonce))) {
      return;
    }
    if (nonce !== data.nonce) {
      nonce = data.nonce;
      if (beat) clearInterval(beat);
      beat = setInterval(() => send({ type: "alive", version: VERSION }), 15_000);
      chrome.runtime.sendMessage({ type: "watch" }).catch(() => undefined);
    }
    send({ type: "attest", version: VERSION });
  });

  window.addEventListener("blur", () => signal("window_blur"));
  for (const name of ["copy", "cut", "paste"]) {
    document.addEventListener(name, () => signal("clipboard"), true);
  }

  // Docked developer tools shrink the page inside the window. A guess: undocked ones don't show.
  let devtools = false;
  setInterval(() => {
    const open =
      window.outerWidth - window.innerWidth > 200 || window.outerHeight - window.innerHeight > 260;
    if (open && !devtools) signal("devtools");
    devtools = open;
  }, 2000);

  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === "new_window") signal("new_window");
  });
})();
