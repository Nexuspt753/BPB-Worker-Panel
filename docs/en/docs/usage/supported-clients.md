# :material-fingerprint:{ .md .middle } Supported Clients

Here you can find minimum requirements for proper connection using BPB Panel and also download latest version of clients. This feature is added to Telegram bot too.

There are some other clients which perform very well and listed in some subscriptions, however they are not listed here due to lack of continuous development or incompatibility with standard cores' configuration formats.

## One-click subscription import

The subscription pages offer a **one-click add** button for each client. The panel detects your device's operating system and, when the client exists on it, hands the subscription to the app in a single tap — either with a deep link or (for the WireGuard family) a config archive download (unpack it, then open a .conf file in the app).

On an operating system a client does not ship on, the button copies the subscription link instead and shows you where the app is available, so it never opens a link your device cannot use.

| Client | Android | iOS | Windows | Linux | macOS |
|---|---|---|---|---|---|
| v2rayNG | ✅ deep link | — | — | — | — |
| MahsaNG | ✅ deep link | — | — | — | — |
| v2rayN | — | — | copy | copy | copy |
| v2rayN-PRO | — | — | copy | copy | copy |
| Streisand | — | ✅ deep link | — | — | — |
| Shadowrocket | — | ✅ deep link | — | — | ✅ deep link |
| PassWall | — | — | — | — | — |
| Hiddify | ✅ deep link | ✅ deep link | ✅ deep link | ✅ deep link | ✅ deep link |
| sing-box | ✅ deep link | ✅ deep link | — | — | ✅ deep link |
| husi | ✅ deep link | — | — | — | — |
| NekoBox | ✅ deep link | — | — | — | — |
| Karing | ✅ deep link | ✅ deep link | copy | copy | ✅ deep link |
| Clash Meta | ✅ deep link | — | — | — | — |
| Clash Verge / rev | — | — | ✅ deep link | ✅ deep link | ✅ deep link |
| FlClash | ✅ deep link | — | ✅ deep link | copy | ✅ deep link |
| Stash | — | ✅ deep link | — | — | ✅ deep link |
| Wireguard / WG Tunnel / Amnezia | file | file | file | file | file |


Some clients register the same URL scheme as others (`clashmeta`, `v2rayng` and `sing-box` are also claimed by Hiddify, for example). When several such apps are installed, the operating system may open another one — that app can still import the same subscription, and the plain link is copied to your clipboard first.

The device OS is detected from the user agent; iPadOS in desktop-class browsing mode is still treated as iPadOS, not macOS.

Legend:

- **deep link** — one tap opens the app and imports the subscription.
- **copy** — the app runs here but has no link scheme, so the subscription link is copied for you to paste into the app.
- **file** — no deep link exists; the sub endpoint serves a ZIP archive of config files, so the button downloads it and you open one `.conf` with the app (WireGuard family).
- **—** — no app build for this operating system; the button copies the link and notes where the app is available.
