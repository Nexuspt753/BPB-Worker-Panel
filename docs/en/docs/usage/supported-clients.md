# :material-fingerprint:{ .md .middle } Supported Clients

Here you can find minimum requirements for proper connection using BPB Panel and also download latest version of clients. This feature is added to Telegram bot too.

There are some other clients which perform very well and listed in some subscriptions, however they are not listed here due to lack of continuous development or incompatibility with standard cores' configuration formats.

## One-click subscription import

The subscription pages offer a **one-click add** button for each client. The panel detects your device's operating system and, when the client exists on it, hands the subscription to the app in a single tap — either with a deep link or (for the WireGuard family) a config file download.

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
| Karing | ✅ deep link | ✅ deep link | ✅ deep link | ✅ deep link | ✅ deep link |
| Clash Meta | ✅ deep link | — | — | — | — |
| Clash Verge / rev | — | — | ✅ deep link | ✅ deep link | ✅ deep link |
| FlClash | ✅ deep link | — | ✅ deep link | ✅ deep link | ✅ deep link |
| Stash | — | ✅ deep link | — | — | ✅ deep link |
| Wireguard / WG Tunnel / Amnezia | file | file | file | file | file |

Legend:

- **deep link** — one tap opens the app and imports the subscription.
- **copy** — the app runs here but has no link scheme, so the subscription link is copied for you to paste into the app.
- **file** — no deep link exists, so the config file is downloaded and you open it with the app (WireGuard family).
- **—** — no app build for this operating system; the button copies the link and notes where the app is available.
