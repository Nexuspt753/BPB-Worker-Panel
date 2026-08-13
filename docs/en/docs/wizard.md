# :material-new-box:{ .md .middle } BPB Wizard

To simplify the setup process and prevent user mistakes during installation, the [BPB Wizard](https://github.com/bia-pain-bache/BPB-Wizard) project was launched which provides online and CLI installations. It supports both Workers and Pages methods and just takes a few seconds to install panel!

<p align="center" class="img-wrapper">
  <img src="/BPB-Worker-Panel/images/wizard-web.jpg" width="400" alt="wizard-web" />
  <img src="/BPB-Worker-Panel/images/wizard-cli.jpg" width="400" alt="wizard-cli" />
</p>

## 1. Cloudflare account

To use this method, all you need is a Cloudflare account. You can [sign up here](https://dash.cloudflare.com/sign-up/), and don’t forget to check your email afterward to verify your account.

## 2. Install BPB Panel

### Web edition

This is a ready to use edition and provides a `Private Link` after first installation which enables `ONE-CLICK` installation on your account.

To easily install the latest stable version of BPB Panel online:

```url title="Web installation"
https://wizard.bpb-panel.workers.dev
```

### CLI edition

```bash title="Windows PowerShell"
irm https://raw.githubusercontent.com/bia-pain-bache/BPB-Wizard/main/install.ps1 | iex
```

```bash title="Android (Termux) - Linux - macOS"
bash <(curl -fsSL https://raw.githubusercontent.com/bia-pain-bache/BPB-Wizard/main/install.sh)
```

!!! warning "Termux usage attention"
    Be sure to download and install Termux only from its [official source](https://github.com/termux/termux-app/releases/latest). Installing via Google Play might cause issues. Also if you're connected to a VPN, disconnect it first.

## 3. Switch to this fork's build

The wizard installs the **original** BPB Panel. To run this fork's build (config-name templates, online chain-proxy test, one-click import), replace the deployed `worker.js` with ours — your settings stay untouched:

1. Download our `worker.js` from the latest release:

   ```url title="Latest fork build"
   https://github.com/Nexuspt753/BPB-Worker-Panel/releases/latest/download/worker.js
   ```

2. Open the **Cloudflare Dashboard** → **Workers & Pages** → your worker → **Edit code**.

3. At the top of the editor you'll see `const EMBEDED_SETTINGS = {...};` — **copy that whole statement** (from `const` to the closing `};`). It holds your Cloudflare account, UUID and panel password; don't lose it.

4. Select and delete everything else, then paste your `const EMBEDED_SETTINGS = {...};` line followed by the entire content of the `worker.js` you downloaded.

5. Click **Deploy** and open your panel URL again.

Your panel now runs this fork — the wizard-created Worker, KV namespace and secure path are all reused as-is.
