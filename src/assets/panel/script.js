const defaultHttpsPorts = [443, 8443, 2053, 2083, 2087, 2096];
const defaultHttpPorts = [80, 8080, 8880, 2052, 2082, 2086, 2095];
// The worker injects the backend token tuple into this marker while bundling
// the panel, so autocomplete cannot silently drift from the parser/catalog.
const nameTemplateTokens = JSON.parse('__NAME_TEMPLATE_TOKENS__');
const nameTemplatePresets = {
    compact: '{FLAG} {IP}:{PORT}',
    detailed: '{MARKER}{FLAG}{COUNTRY} - {IP} [[ - {IPNAME} ]]',
    latency: '[[{LATENCY}ms | ]]{FLAG} {IP}',
    protocol: '{PROTO} {MARKER}{IP}:{PORT}'
};
const proxyForm = document.getElementById('configForm');
const [
    selectElements,
    numInputElements,
    inputElements,
    textareaElements,
    checkboxElements
] = [
    'select',
    'input[type=number]',
    'input:not([type=file])',
    'textarea',
    'input[type=checkbox]'
].map(query => proxyForm.querySelectorAll(query));
function initTemplateAutocomplete() {
    const input = document.getElementById('nameTemplate');
    const list = document.getElementById('nameTemplateSuggestions');
    if (!input || !list) return;

    let openIndex = -1;

    const highlight = () => {
        [...list.children].forEach((option, index) => {
            const active = index === openIndex;
            option.classList.toggle('active', active);
            option.setAttribute('aria-selected', active ? 'true' : 'false');
        });
        const active = list.children[openIndex];
        input.setAttribute('aria-activedescendant', active?.id || '');
        if (active) active.scrollIntoView({ block: 'nearest' });
    };

    const hide = () => {
        list.hidden = true;
        list.replaceChildren();
        openIndex = -1;
        input.setAttribute('aria-expanded', 'false');
        input.removeAttribute('aria-activedescendant');
    };

    const tokenContext = () => {
        const caret = input.selectionStart ?? input.value.length;
        const before = input.value.slice(0, caret);
        const lastOpen = before.lastIndexOf('{');
        if (lastOpen === -1) return null;
        const lastClose = before.lastIndexOf('}');
        if (lastClose > lastOpen) return null;
        // Do not offer a completion inside a nested or still-open token such
        // as `{{IP`; the backend will reject that structure as malformed.
        // Slice before the current opener so a leading `{` does not make
        // lastIndexOf('{', -1) wrap back to index zero.
        const previousOpen = before.slice(0, lastOpen).lastIndexOf('{');
        if (previousOpen > lastClose) return null;
        const fragment = before.slice(lastOpen + 1);
        // Tokens are [A-Za-z0-9_] (EGRESS_IP has an underscore), so the partial
        // fragment must allow the same characters or the list closes mid-token.
        if (!/^[A-Za-z0-9_]*$/.test(fragment)) return null;
        return { start: lastOpen, fragment: fragment.toUpperCase() };
    };

    const choose = (token) => {
        const context = tokenContext();
        if (!context) return;
        const caret = input.selectionStart ?? input.value.length;
        const inserted = `{${token}}`;
        input.value = input.value.slice(0, context.start) + inserted + input.value.slice(caret);
        const next = context.start + inserted.length;
        input.setSelectionRange(next, next);
        hide();
        input.dispatchEvent(new Event('input', { bubbles: true }));
    };

    const update = () => {
        const context = tokenContext();
        if (!context) return hide();
        const options = nameTemplateTokens.filter(token => token.startsWith(context.fragment));
        if (!options.length) return hide();
        list.replaceChildren(...options.map((token, index) => {
            const option = document.createElement('li');
            option.id = `name-template-option-${index}`;
            option.dataset.token = token;
            option.setAttribute('role', 'option');
            option.setAttribute('aria-selected', 'false');
            option.textContent = `{${token}}`;
            option.addEventListener('mousedown', (event) => {
                event.preventDefault();
                choose(token);
            });
            return option;
        }));
        openIndex = 0;
        list.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        // Enter/Tab already commit children[0]; highlight it so the row that will
        // be inserted is visible before the first arrow key.
        highlight();
    };

    input.addEventListener('input', update);
    input.addEventListener('click', update);
    input.addEventListener('focus', update);
    input.addEventListener('blur', () => setTimeout(hide, 120));
    input.addEventListener('keyup', (event) => {
        if (!['ArrowDown', 'ArrowUp', 'Enter', 'Tab', 'Escape'].includes(event.key)) update();
    });

    input.addEventListener('keydown', (event) => {
        const isOpen = !list.hidden;
        const count = list.children.length;
        if (event.key === 'ArrowDown' && isOpen) {
            event.preventDefault();
            openIndex = (openIndex + 1) % count;
            highlight();
        } else if (event.key === 'ArrowUp' && isOpen) {
            event.preventDefault();
            openIndex = (openIndex - 1 + count) % count;
            highlight();
        } else if ((event.key === 'Enter' || event.key === 'Tab') && isOpen) {
            const active = list.children[openIndex];
            if (active) {
                event.preventDefault();
                choose(active.dataset.token);
            }
        } else if (event.key === 'Escape' && isOpen) {
            event.preventDefault();
            hide();
        }
    });
}

// Preview rendering is server-authoritative. Keeping parsing, fallback semantics,
// token availability, and uniqueness in the backend prevents this static client
// from drifting from subscription output.

let namePreviewRequest = 0;
let namePreviewTimer;
let namePreviewController;

function renderNamePreviewResult(result) {
    const preview = document.getElementById('nameTemplatePreview');
    const collisions = document.getElementById('nameTemplateCollisions');
    const diagnostics = document.getElementById('nameTemplateDiagnostics');
    const status = document.getElementById('nameTemplatePreviewStatus');
    const tokenHelp = document.getElementById('nameTemplateTokenHelp');
    const input = document.getElementById('nameTemplate');
    if (!preview || !collisions || !diagnostics) return;

    if (tokenHelp && Array.isArray(result.tokenCatalog)) {
        tokenHelp.replaceChildren(...result.tokenCatalog.map(item => {
            const line = document.createElement('div');
            const availability = result.tokenAvailability?.[item.token];
            const count = availability ? `; ${availability.available}/${availability.total} examples` : '';
            line.textContent = `{${item.token}} — ${item.description} (${item.availableFor.join(', ')})${count}`;
            line.title = `Example: ${item.example}; privacy: ${item.privacy}`;
            return line;
        }));
    }

    const hasDiagnostics = Boolean(result.diagnostics?.length);
    const hasTransportError = result.previewError === true;
    status && (status.textContent = hasTransportError ? 'Preview unavailable. Check your session or connection; Apply still validates on the server.' : '');
    input?.classList.toggle('name-template-invalid', hasDiagnostics);
    input?.classList.toggle('name-template-preview-error', hasTransportError);
    if (hasDiagnostics) input?.setAttribute('aria-invalid', 'true');
    else input?.removeAttribute('aria-invalid');
    if (hasDiagnostics) {
        input?.setAttribute('title', result.diagnostics.map(item => item.message).join(' '));
    } else {
        input?.removeAttribute('title');
    }

    diagnostics.replaceChildren(...(result.diagnostics || []).map(item => {
        const line = document.createElement('div');
        const location = item.line ? `line ${item.line}, column ${item.column}` : `characters ${item.start + 1}-${Math.max(item.start + 1, item.end)}`;
        line.textContent = `${item.message} (${location})`;
        return line;
    }));

    if (hasDiagnostics) {
        preview.textContent = 'Fix the highlighted template syntax to see generated names.';
        collisions.textContent = 'Collision analysis paused until the template is valid.';
        return;
    }

    preview.replaceChildren(...(result.rows || []).map(row => {
        const line = document.createElement('div');
        line.className = 'name-preview-line';
        line.textContent = `${row.label}: ${row.finalName || '(empty → classic name)'}`;
        line.title = `Raw: ${row.rawName || '(empty)'}`;
        return line;
    }));

    if (!result.collisions?.length) {
        collisions.textContent = 'No collisions in the representative examples.';
        return;
    }

    const intro = document.createElement('div');
    intro.textContent = 'Raw duplicate names are shown below; only real name collisions receive a stable identity suffix, matching subscriptions.';
    const list = document.createElement('ul');
    result.collisions.forEach(({ name, labels }) => {
        const item = document.createElement('li');
        item.textContent = `${name}: ${labels.join(' + ')}`;
        list.appendChild(item);
    });
    collisions.replaceChildren(intro, list);
}

function updateNameLengthValidity() {
    const input = document.getElementById('nameMaxLength');
    if (!input) return true;
    const value = input.value.trim();
    const number = Number(value);
    const valid = value === ''
        || (Number.isInteger(number) && (number === 0 || (number >= 8 && number <= 200)));
    input.setCustomValidity(valid ? '' : 'Use 0 for unlimited or a whole number between 8 and 200.');
    return valid;
}

function updateNameTemplatePreview() {
    const input = document.getElementById('nameTemplate');
    if (!input) return;
    clearTimeout(namePreviewTimer);
    namePreviewController?.abort();
    // Invalidate an already-running request immediately. Otherwise a request
    // for an older template can finish after the user clears the field and
    // repaint a preview that no longer matches the form.
    const requestId = ++namePreviewRequest;
    namePreviewTimer = setTimeout(async () => {
        // Send the exact editor value so literal whitespace follows the same
        // server parser and snapshot contract as the saved setting.
        const template = input.value;
        const mode = document.getElementById('nameFormat')?.value || 'readable';        const lengthField = document.getElementById('nameMaxLength');
        const requestedLength = Number(lengthField?.value || 0);
        const hasInvalidLength = !updateNameLengthValidity()
            || (Number.isInteger(requestedLength)
                && requestedLength !== 0
                && (requestedLength < 8 || requestedLength > 200));
        const maxLength = hasInvalidLength ? requestedLength : requestedLength;
        if (hasInvalidLength) {
            renderNamePreviewResult({
                diagnostics: [{ message: 'Use 0 for unlimited or a whole number between 8 and 200.', start: 0, end: 0 }],
                rows: [], collisions: [], tokenCatalog: [], tokenAvailability: {}
            });
            return;
        }

        if (!template.trim()) {
            renderNamePreviewResult({ diagnostics: [], rows: [], collisions: [],
                tokenCatalog: [],
                tokenAvailability: {}
            });
            document.getElementById('nameTemplatePreview').textContent = 'Set a template to preview generated names.';
            document.getElementById('nameTemplateCollisions').textContent = 'No collisions analyzed.';
            return;
        }

        try {
            namePreviewController = new AbortController();
            const response = await fetch('./panel/name-preview', {
                method: 'POST',
                credentials: 'include',
                cache: 'no-store',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    template,
                    mode,
                    maxLength,
                    geoMode: document.getElementById('nameGeoMode')?.value || 'auto',
                    latencyAutoTest: document.getElementById('latencyAutoTest')?.checked === true,
                    nameFreezeGeo: document.getElementById('nameFreezeGeo')?.checked === true,
                    addressGroups: document.getElementById('nameAddressGroups')?.value
                        .split('\n').map(value => value.trim()).filter(Boolean) || []
                }),
                signal: namePreviewController.signal
            });
            const payload = await response.json();
            if (requestId !== namePreviewRequest) return;
            if (!payload.success) throw new Error(payload.message || 'Preview failed');
            renderNamePreviewResult(payload.body);
        } catch (error) {
            if (error?.name === 'AbortError' || requestId !== namePreviewRequest) return;
            renderNamePreviewResult({
                diagnostics: [],
                rows: [],
                collisions: [],
                tokenCatalog: [],
                tokenAvailability: {},
                previewError: true
            });
        }
    }, 120);
}

function initNameTemplateTools() {
    const input = document.getElementById('nameTemplate');
    const preset = document.getElementById('nameTemplatePreset');
    const apply = document.getElementById('applyNamePreset');
    if (!input || !preset || !apply) return;

    apply.addEventListener('click', () => {
        const value = nameTemplatePresets[preset.value];
        if (!value) return;
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    ['input', 'change'].forEach(type => input.addEventListener(type, updateNameTemplatePreview));
    ['nameFormat', 'nameMaxLength', 'nameGeoMode', 'nameFreezeGeo', 'nameAddressGroups'].forEach(id => {
        document.getElementById(id)?.addEventListener('input', updateNameTemplatePreview);
        document.getElementById(id)?.addEventListener('change', updateNameTemplatePreview);
    });
    updateNameLengthValidity();
}

initTemplateAutocomplete();
initNameTemplateTools();
initI18n();
getUsage();
initPanel();
fetchIPInfo();

async function initPanel(settings, tgSettings, subscriptions, clients, clientLinks) {
    try {
        if (!settings) {
            const nocache = Date.now();
            const res = await fetch(`./panel/settings?nocache=${nocache}`, { cache: 'no-store' });
            const { success, status, message, body } = await res.json();

            if (status === 401 && !body.isPassSet) {
                const closeBtn = document.querySelector('.modal-close');
                openResetPass();
                closeBtn.style.visibility = 'hidden';
            }

            if (!success) {
                throw new Error(`status ${status} - ${message}`);
            }

            settings = body.proxySettings;
            tgSettings = body.telegramSettings;
            subscriptions = body.subscriptions;
            clients = body.clients;
            clientLinks = body.clientLinks;
            checkVersion(settings.panelVersion);
        }

        renderPanel(settings, tgSettings, subscriptions, clients, clientLinks);
    } catch (error) {
        console.error('Panel initiation error:', error);
    }
}

async function getUsage() {
    try {
        const nocache = Date.now();
        const res = await fetch(`./panel/usage?nocache=${nocache}`, { cache: 'no-store' });
        const { success, status, message, body } = await res.json();

        if (!success) {
            throw new Error(`status ${status} - ${message}`);
        }

        const { total, worker } = body;
        const totalReq = document.getElementById('total-usage');
        totalReq.textContent = total.toLocaleString('en-US');
        totalReq.style.fontSize = 'larger';
        const totalPct = document.getElementById('total-pct');
        const totalPctVal = Math.ceil(Number(total) / 100000 * 100);
        totalPct.textContent = totalPctVal;
        if (totalPctVal > 80) totalPct.style.color = 'var(--color-icon-red)';

        const panelReq = document.getElementById('panel-usage');
        panelReq.textContent = worker.toLocaleString('en-US');
        panelReq.style.fontSize = 'larger';
        const panelPct = document.getElementById('panel-pct');
        const panelPctVal = Math.ceil(Number(worker) / 100000 * 100);
        panelPct.textContent = panelPctVal;
        if (panelPctVal > 80) panelPct.style.color = 'var(--color-icon-red)';
    } catch (error) {
        console.error('Failed to get usage from API:', error);
    }
}

async function checkVersion(panelVersion) {
    try {
        const res = await fetch('https://raw.githubusercontent.com/Nexuspt753/BPB-Worker-Panel/refs/heads/main/package.json', {
            cache: 'no-store'
        });

        if (!res.ok) {
            throw new Error(`status ${res.status}`);
        }

        const pkg = await res.json();
        const latest = pkg.version;
        const updateAvailable = isNewerVersion(latest, panelVersion);
        if (updateAvailable) {
            globalThis.latestVersion = latest;
            const upgradeBtn = document.getElementById('updatePanel');
            upgradeBtn.disabled = false;
        }
    } catch (error) {
        console.error('Get latest version error:', error);
    }
}

function isNewerVersion(latest, current) {
    const lv = latest.split('.').map(Number);
    const cv = current.split('.').map(Number);

    for (let i = 0; i < Math.max(lv.length, cv.length); i++) {
        const l = lv[i] ?? 0;
        const c = cv[i] ?? 0;
        if (l > c) return true;
        if (l < c) return false;
    }

    return false;
}

function renderPanel(proxySettings, tgSettings, subscriptions, clients, clientLinks) {
    if (clientLinks) globalThis.clientLinkMap = clientLinks;
    const {
        securePath,
        ports,
        xrayUdpNoises,
        remoteSettings
    } = proxySettings;

    const path = encodeURIComponent(securePath);
    if (path !== window.location.pathname.split('/')[1]) {
        setTimeout(() => {
            window.location.href = `../${path}/panel`;
        }, 1000);
    }

    const dohUrl = new URL(`./dns-query`, window.location.href);
    document.getElementById('doh').textContent = dohUrl.href;
    document.getElementById('fetchSettingsBtn').disabled = !remoteSettings;

    selectElements.forEach(elm => elm.value = proxySettings[elm.id]);
    checkboxElements.forEach(elm => elm.checked = proxySettings[elm.id]);
    inputElements.forEach(elm => {
        const value = proxySettings[elm.id];
        if (elm.id === 'subscriptionExpiry') {
            // KV stores epoch ms; datetime-local needs a YYYY-MM-DDTHH:MM string.
            const expiry = Number(value) || 0;
            elm.value = expiry > 0 ? new Date(expiry).toISOString().slice(0, 16) : '';
            return;
        }
        elm.value = elm.id === 'nameMaxLength' && (value === 0 || value === '0') ? '0' : (value ?? '');
    });
    textareaElements.forEach(elm => {
        const key = elm.id;
        const element = document.getElementById(key);
        const values = Array.isArray(proxySettings[key]) ? proxySettings[key] : [];
        const value = values.join('\r\n');
        const rowsCount = values.length;
        element.style.height = 'auto';
        if (rowsCount) element.rows = rowsCount;
        element.value = value;
        element.style.height = `${element.scrollHeight}px`;
    });

    if (!globalThis.textareaAutosizeBound) {
        proxyForm.addEventListener('input', event => {
            const target = event.target;
            if (!(target instanceof HTMLTextAreaElement)) return;
            target.style.height = 'auto';
            target.style.height = `${target.scrollHeight}px`;
        });
        globalThis.textareaAutosizeBound = true;
    }

    document.querySelectorAll('#subscriptions > .accordion-item').forEach(item => item.remove());
    document.getElementById('supported-clients').replaceChildren();
    renderPorts(ports.map(Number));
    renderNoises(xrayUdpNoises);
    renderSubscriptions(subscriptions);
    renderClients(clients);

    globalThis.initialFormData = new FormData(proxyForm);
    handleProxyFormChanges();
    if (!globalThis.panelListenersBound) {
        proxyForm.addEventListener('input', handleProxyFormChanges);
        proxyForm.addEventListener('change', handleProxyFormChanges);
        globalThis.panelListenersBound = true;
    }
    handleFragmentMode();
    updateNameTemplatePreview();
    loadDiagnostics();

    if (tgSettings) {
        const tgForm = document.getElementById('telegramForm');
        handleTgFormChanges(tgSettings);
        if (!globalThis.telegramListenerBound) {
            tgForm.addEventListener('input', () => handleTgFormChanges());
            globalThis.telegramListenerBound = true;
        }

        for (const key in tgSettings) {
            tgForm.elements[key].value = tgSettings[key];
        }
    }
}

function hasFormDataChanged() {
    const formDataToObject = (formData) => Object.fromEntries(formData.entries());
    const configForm = document.getElementById('configForm');
    const currentFormData = new FormData(configForm);

    const initialFormDataObj = formDataToObject(globalThis.initialFormData);
    const currentFormDataObj = formDataToObject(currentFormData);

    return JSON.stringify(initialFormDataObj) !== JSON.stringify(currentFormDataObj);
}

function handleProxyFormChanges(force = false) {
    const applyButton = document.getElementById('applyButton');
    const isChanged = hasFormDataChanged();
    applyButton.disabled = force ? false : !isChanged;
}

function handleTgFormChanges(settings) {
    const userId = document.getElementById('telegramUserId');
    const token = document.getElementById('telegramBotToken');
    const setupBtn = document.getElementById('setup-telegram');
    const removeBtn = document.getElementById('remove-telegram');

    if (settings) {
        const { telegramUserId, telegramBotToken } = settings;
        removeBtn.disabled = !telegramUserId && !telegramBotToken;
        setupBtn.disabled = true;

        userId.value = telegramUserId;
        token.value = telegramBotToken;

        return;
    }

    setupBtn.disabled = !userId.value.trim() || !token.value.trim();
}

async function getIpDetails(ip) {
    try {
        const response = await fetch('./panel/my-ip', { method: 'POST', body: ip });
        const { success, status, message, body } = await response.json();

        if (!success) {
            throw new Error(`status ${status} - ${message}`);
        }

        return body;
    } catch (error) {
        console.error('Fetching IP error:', error)
    }
}

async function fetchIPInfo() {
    const icons = startWaiting(null, 'refresh-geo-location', '');

    const updateUI = (ip = '-', country = '-', countryCode = '-', city = '-', isp = '-', cfIP) => {
        const flag = countryCode !== '-' ? String.fromCodePoint(...[...countryCode].map(c => 0x1F1E6 + c.charCodeAt(0) - 65)) : '';
        const updateContent = (id, content) => document.getElementById(id).textContent = content;
        updateContent(cfIP ? 'cf-ip' : 'ip', ip);
        updateContent(cfIP ? 'cf-country' : 'country', `${flag} ${country}`);
        updateContent(cfIP ? 'cf-city' : 'city', city);
        updateContent(cfIP ? 'cf-isp' : 'isp', isp);
    };

    const nocache = Date.now();
    const othersPromise = fetch(`https://ipv4.geojs.io/v1/ip.json?nocache=${nocache}`, { cache: 'no-store' })
        .then(async res => {
            if (!res.ok) throw new Error(`Fetch Other targets IP failed.`);
            const { ip } = await res.json();
            const { country, countryCode, city, isp } = await getIpDetails(ip);
            updateUI(ip, country, countryCode, city, isp);
        });

    const cfPromise = fetch(`https://ipv4.icanhazip.com/?nocache=${nocache}`, { cache: 'no-store' })
        .then(async res => {
            if (!res.ok) throw new Error(`Fetch Cloudflare targets IP failed.`);
            const ip = await res.text();
            const { country, countryCode, city, isp } = await getIpDetails(ip.trim());
            updateUI(ip, country, countryCode, city, isp, true);
        });

    const results = await Promise.allSettled([othersPromise, cfPromise]);
    results.forEach(result => {
        if (result.status === 'rejected') console.error(result.reason);
    });

    stopWaiting(icons);
}

function generateSubUrl(type, core, tag) {
    const url = new URL(`./sub/${type}`, window.location.href);
    url.searchParams.append('app', core);
    url.hash = `💦 BPB ${tag}`;

    if (core === 'sing-box' && type !== 'raw') {
        return `sing-box://import-remote-profile?url=${url.href}`;
    }

    return url.href;
}

// Detect the user's OS so we can build the right one-tap link for this device.
let currentOS = detectOS();

function detectOS() {
    const ua = navigator.userAgent || '';
    if (/android/i.test(ua)) return 'android';
    if (/ipad|iphone|ipod/i.test(ua)) return 'ios';

    // iPadOS 13+ hides the "iPad" token in desktop-class browsing and
    // impersonates a Macintosh; iPads still report multi-touch and no
    // MacBook/iMac does, so a Mac-class UA with touch points means iPad.
    if ((/mac os x|macintosh/i.test(ua)) && navigator.maxTouchPoints > 1) return 'ios';

    if (/mac os x|macintosh/i.test(ua)) return 'macos';
    if (/windows/i.test(ua)) return 'windows';
    if (/linux|cros/i.test(ua)) return 'linux';
    return 'windows'; // safest default keeps the copy fallback available
}

// Human-readable OS names for the "this app isn't available here" message.
const OS_LABELS = {
    android: 'Android',
    ios: 'iOS',
    windows: 'Windows',
    linux: 'Linux',
    macos: 'macOS'
};

// Resolve the strategy for a displayed client name. The map is keyed by the
// canonical app names, but a subscription row can show a combined label —
// `v2rayN(G)` covers two separate apps: v2rayNG on Android and v2rayN on
// desktop. Pick the one that exists on this device, so the row behaves as
// that app would; if neither matches, fall back to the desktop entry so the
// unavailable-here message still names a real app.
function resolveClientLink(client, os) {
    const map = globalThis.clientLinkMap;
    if (!map) return undefined;

    if (client === 'v2rayN(G)' || client === 'v2rayNG(G)') {
        const mobile = map['v2rayNG'];
        const desktop = map['v2rayN'];
        if (mobile && mobile.platforms?.includes(os)) return mobile;
        return desktop || mobile;
    }

    return map[client];
}

// Canonical app name for toasts/UI when the row label is a composite
// (v2rayN(G) → v2rayNG on Android, v2rayN on desktop).
function resolveClientName(client, os) {
    if (client === 'v2rayN(G)' || client === 'v2rayNG(G)') {
        const map = globalThis.clientLinkMap;
        if (map?.['v2rayNG']?.platforms?.includes(os)) return 'v2rayNG';
        return 'v2rayN';
    }
    return client;
}

// btoa requires a Latin1 string. URL.href is normally already percent-encoded
// ASCII, but if any engine leaves raw Unicode in the string we fall back to a
// UTF-8 → binary path so Shadowrocket's sub://{b64} import cannot throw.
function toBase64(str) {
    try {
        return btoa(str);
    } catch {
        return btoa(unescape(encodeURIComponent(str)));
    }
}

// The worker exports shared settings as UTF-8 → base64 (plain btoa would
// throw on Unicode such as flag emojis in cleanIPs). Decode it back to a
// proper JS string; files from older builds that used Latin1 still decode.
function fromBase64(str) {
    const binary = atob(str);
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(
            Uint8Array.from(binary, c => c.charCodeAt(0))
        );
    } catch {
        // Not valid UTF-8 → it is a legacy Latin1-encoded file.
        return binary;
    }
}

// Build the one-click action for a client app on the current device.
//
// Returns one of:
//   { action: 'scheme',      url }  — fire the app's URL scheme; it imports.
//   { action: 'download',    url }  — download the config for the app to open.
//   { action: 'copy',        url }  — app runs here but only accepts a paste.
//   { action: 'unavailable', url, platforms } — app doesn't run on this OS.
function buildClientLink(os, type, core, client, label) {
    const strategy = resolveClientLink(client, os);

    // Plain HTTP(S) subscription URL that the client can fetch directly.
    // Importers that read a name use the {name} template placeholder; the
    // rest title the group from the URL's #fragment.
    // husi only parses URI-list feeds, so even on a JSON-profile row its
    // one-click (and its copy fallback) must point at the raw endpoint.
    const subType = type !== 'raw' && strategy?.uriList && !strategy?.profile ? 'raw' : type;
    const subUrl = new URL(`./sub/${subType}`, window.location.href);
    subUrl.searchParams.append('app', core);
    subUrl.hash = `\u{1F4A6} BPB ${label}`;
    const plainUrl = subUrl.href;

    // Unknown client, or one with no build for this device: there is no app
    // here to hand the subscription to, so copying is the only honest action.
    if (!strategy) return { action: 'copy', url: plainUrl, plain: plainUrl };
    if (!strategy.platforms?.includes(os)) {
        return { action: 'unavailable', url: plainUrl, plain: plainUrl, platforms: strategy.platforms || [] };
    }

    // The app is installed-able here. Prefer its own import mechanism.
    // raw rows serve a base64 URI list; the other rows serve a structured
    // profile (xray JSON, sing-box JSON, Clash YAML). A scheme is only fired
    // for a body the app is known to parse: uriList for raw rows, profile
    // for the structured rows. An empty per-OS scheme entry
    // (schemes[os] = '') means that build registers no working deep link,
    // so the panel copies instead of firing a dead scheme.
    const template = strategy.schemes?.[os] ?? strategy.scheme;
    const canImport = subType === 'raw' ? strategy.uriList : strategy.profile;
    if (template && canImport) {
        // Most clients title the subscription from the URL's #fragment.
        // Those that instead read a name= query param get {name}, without
        // which they fall back to a generated placeholder like a timestamp.
        const url = template
            .replaceAll('{enc}', encodeURIComponent(plainUrl))
            .replaceAll('{b64}', toBase64(plainUrl))
            .replaceAll('{url}', plainUrl)
            .replaceAll('{name}', encodeURIComponent(`\u{1F4A6} BPB ${label}`));

        return { action: 'scheme', url, plain: plainUrl };
    }

    // WireGuard-family endpoints serve a ZIP archive of .conf files, not a
    // single importable config - still the closest thing to one tap.
    if (strategy.fileImport) return { action: 'download', url: plainUrl, plain: plainUrl, archive: true };

    return { action: 'copy', url: plainUrl, plain: plainUrl };
}

// One-click: add the current subscription to the given client app on this device.
function oneClickAdd(client, type, core, label) {
    const { action, url, plain, platforms } = buildClientLink(currentOS, type, core, client, label);
    // Composite row labels (v2rayN(G)) resolve to the real app name for toasts.
    const name = resolveClientName(client, currentOS);

    if (action === 'download') {
        // Notify first: a location-based download can race the toast away
        // before the user sees the "unpack the ZIP" instructions.
        notify('info', 'Add to ' + name, [
            'Downloading the config archive.',
            'Unpack the ZIP and open one of the .conf files with ' + name + ' to import it.'
        ]);
        dlUrl(url);
        return;
    }

    if (action === 'scheme') {
        // Put the plain subscription URL - not the scheme - on the clipboard
        // first: if the app is not installed (or another app with the same
        // scheme claims the tap), the user still has the link to paste.
        copyToClipboard(plain ?? url);

        const a = document.createElement('a');
        a.href = url;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        a.remove();

        notify('info', 'Add to ' + name, [
            name + ' should open and import the subscription.',
            'If another installed app opened instead, it can import the same link; otherwise paste the copied link into ' + name + '.'
        ]);
        return;
    }

    copyToClipboard(url);

    if (action === 'unavailable') {
        // The app has no build for this device, so there is no scheme to fire
        // and nothing useful to open - say so instead of failing silently.
        const where = (platforms || []).map(os => OS_LABELS[os] || os).join(', ');
        notify('info', 'Add to ' + name, [
            'Subscription link copied to your clipboard.',
            where
                ? name + ' runs on ' + where + ' - open this link there.'
                : name + ' is not available on this device.'
        ]);
        return;
    }

    // The app runs here but has no import scheme (v2rayN, for instance):
    // opening the sub endpoint in a browser would only download the config,
    // so we deliberately do not open it - the user pastes the link instead.
    notify('info', 'Add to ' + name, [
        'Subscription link copied to your clipboard.',
        'Paste it into ' + name + ' to import the subscription.'
    ]);
}

async function generateQRCode(data) {
    const url = new URL('./qrcode', window.location.href);
    url.searchParams.set('data', data);
    url.searchParams.set('nocache', Date.now().toString());

    const res = await fetch(url, { method: 'POST' });
    if (!res.ok) {
        throw new Error(`status ${res.status}`);
    }

    const blob = await res.blob();

    return elm('img', {
        id: 'qr',
        className: 'qrcode',
        src: URL.createObjectURL(blob)
    });
}

function showQRCode(subUrl) {
    const url = new URL(subUrl);
    const modal = document.getElementById('qrModal');
    const close = modal.querySelector('.modal-close');
    const container = document.getElementById('qrcode-container');

    let qrcodeTitle = document.getElementById('qrcodeTitle');
    qrcodeTitle.textContent = decodeURIComponent(url.hash).replace('#', '');

    close.onclick = () => {
        modal.hidden = true;
        container.lastElementChild.remove();
        window.onclick = null;
    };

    window.onclick = (event) => {
        if (event.target == modal) {
            modal.hidden = true;
            container.lastElementChild.remove();
        }
    }

    generateQRCode(subUrl).then(qr => {
        container.appendChild(qr);
        modal.hidden = false;
    });
}

function copyToClipboard(text) {
    const done = () => notify('info', 'Copied to clipboard', [text]);
    const fail = (error) => console.error('Failed to copy:', error);

    // Prefer the async Clipboard API; fall back to execCommand for non-secure
    // contexts (or older browsers) where navigator.clipboard is unavailable.
    if (navigator.clipboard?.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(() => {
            if (!fallbackCopy(text)) fail(new Error('clipboard write failed'));
            else done();
        });
        return;
    }

    if (!fallbackCopy(text)) fail(new Error('clipboard unavailable'));
    else done();
}

function fallbackCopy(text) {
    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        const ok = document.execCommand('copy');
        ta.remove();
        return ok;
    } catch {
        return false;
    }
}

function copyDoh() {
    const url = document.getElementById('doh').textContent;
    copyToClipboard(url);
}

// Trigger a same-origin download without navigating the panel away. A hidden
// <a download> keeps the SPA mounted; Content-Disposition on the response
// still supplies the real filename for ZIP/JSON configs.
function dlUrl(subUrl) {
    const url = new URL(subUrl);
    const href = url.protocol === 'sing-box:' ? url.searchParams.get('url') : String(subUrl);
    const a = document.createElement('a');
    a.href = href;
    a.download = '';
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
}

async function exportFileSettings(event) {
    if (hasFormDataChanged()) {
        notify('error', 'Export settings', ['Please apply unsaved changes first.']);
        return;
    }

    const icons = startWaiting(event.target, '', 'refresh');
    const url = new URL('./sub/share-settings', window.location.href);
    window.location.href = url.href;
    stopWaiting(icons);
}

function importFile() {
    const input = document.getElementById('fileInput');
    input.value = '';
    input.click();
}

async function importFileSettings(event) {
    const file = event.target.files[0];
    if (!file) return;

    try {
        const text = await file.text();
        const data = fromBase64(text);
        const newSettings = JSON.parse(data);
        const currentSettings = validateSettings();
        const settings = { ...currentSettings, ...newSettings };

        renderPanel(settings);
        handleProxyFormChanges(true);

        notify('success', 'Import settings', [
            'Settings imported successfully!',
            'Please first REVIEW new settings and then apply, specially ROUTING settings.'
        ]);
    } catch (error) {
        console.error('Import settings error:', error);
        notify('error', 'Import settings', ['Failed to get settings from file.']);
    }
}

async function importRemoteSettings(event) {
    if (hasFormDataChanged()) {
        notify('error', 'Import settings', ['Please apply unsaved changes first.']);
        return;
    }

    const icons = startWaiting(event.target, '', 'refresh');
    const remote = document.getElementById('remoteSettings').value.trim();
    const currentSettings = validateSettings();

    try {
        const newSettings = await fetchSettings(remote);
        const settings = { ...currentSettings, ...newSettings };

        renderPanel(settings);
        handleProxyFormChanges(true);

        notify('success', 'Import settings', [
            'Settings imported successfully!',
            'Please first REVIEW new settings and then apply, specially ROUTING settings.'
        ]);
    } catch (error) {
        console.error('Import settings error:', error);
        notify('error', 'Import settings', ['Failed to get settings from remote.']);
    } finally {
        stopWaiting(icons);
    }
}

function shareSettings() {
    const url = new URL('./sub/share-settings', window.location.href);
    copyToClipboard(url);
}

async function fetchSettings(remoteUrl) {
    const url = new URL(remoteUrl);
    const remote = `${url.origin + url.pathname}?nocache=${Date.now()}`;

    const res = await fetch(remote, { cache: 'no-store' });
    if (!res.ok) {
        throw new Error(`status ${res.status}`);
    }

    const data = await res.text();
    return JSON.parse(fromBase64(data));
}

async function renewWarpAccounts(btn) {
    const confirm = await notify('confirm', 'Renew Warp Accounts', ['Are you sure?'])
    if (!confirm) return;
    const icons = startWaiting(btn, '', '');

    try {
        const response = await fetch('./panel/update-warp', { method: 'POST', credentials: 'include' });
        const { success, status, message } = await response.json();

        if (!success) {
            notify('error', 'Renew Warp Accounts', ['An error occured, Please try again later.']);
            throw new Error(`status ${status} - ${message}`);
        }

        notify('success', 'Renew Warp Accounts', ['Warp accounts updated successfully!']);
    } catch (error) {
        console.error('Updating Warp configs error:', error)
        notify('error', 'Renew Warp Accounts', ['Failed to renew Warp accounts.']);
    } finally {
        stopWaiting(icons);
    }
}

async function handleRiskyRules(event) {
    if (event.target.checked) {
        const proceed = await notify('confirm', 'Geo asset files', [
            "v2ray users should set Geo Assets to Chocolate4U and download assets, otherwise configs won't connect.",
            'Proceed anyway?'
        ]);

        if (!proceed) {
            event.target.checked = false;
            return;
        }
    }
}

function handleFragmentMode() {
    const fragmentMode = document.getElementById('fragmentMode').value;
    const formDataObj = Object.fromEntries(globalThis.initialFormData.entries());
    const inputs = [
        'fragmentLengthMin',
        'fragmentLengthMax',
        'fragmentDelayMin',
        'fragmentDelayMax'
    ];

    const configs = {
        low: [100, 200, 1, 1],
        medium: [50, 100, 1, 5],
        high: [10, 20, 10, 20],
        severe: [1, 5, 1, 5],
        custom: inputs.map(id => formDataObj[id])
    };

    inputs.forEach((id, index) => {
        const elm = document.getElementById(id);
        elm.value = configs[fragmentMode][index];
        fragmentMode !== 'custom'
            ? elm.setAttribute('readonly', 'true')
            : elm.removeAttribute('readonly');
    });
}

async function resetSettings(btn) {
    const confirm = await notify(
        'confirm',
        'Reset panel settings',
        [
            'This will reset all settings except:',
            '+ VLESS UUID',
            '+ Trojan password',
            '+ Panel - Subscriptions path\n',
            'Are you sure?'
        ]
    );

    if (!confirm) return;
    const icons = startWaiting(btn, '', '', false);

    try {
        const res = await fetch('./panel/reset-settings', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' }
        });

        const { success, status, message, body } = await res.json();
        if (!success) {
            throw new Error(`status ${status} - ${message}`);
        }

        notify(
            'success',
            'Reset panel settings',
            ['Please update your subscriptions.']
        );

        renderPanel(body);
    } catch (error) {
        console.error('Reseting settings error:', error);
    } finally {
        stopWaiting(icons);
    }
}

function updateSettings(event, data) {
    event.preventDefault();
    event.stopPropagation();

    const validatedForm = validateSettings();
    if (!validatedForm) return false;
    const form = data ?? validatedForm;

    const icons = startWaiting(null, 'applyButton', 'refresh');

    fetch('./panel/update-settings', {
        method: 'PUT',
        body: JSON.stringify(form),
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
    })
        .then(res => res.json())
        .then(({ success, status, message, body: errors }) => {
            if (status === 401) {
                notify(
                    'error',
                    'Apply settings',
                    ['Session expired! Please login and try again.']
                );
                window.location.href = './login';
                return;
            }

            if (!success) {
                if (Array.isArray(errors) && errors.length) {
                    const details = errors.flatMap(error => [
                        error.field || 'Validation',
                        ...(Array.isArray(error.message) ? error.message : [error.message || 'Validation failed.'])
                    ]);
                    notify('error', 'Apply settings', details);
                } else {
                    notify('error', 'Apply settings', [message || `Request failed (status ${status}).`]);
                }
                return;
            }

            notify(
                'success',
                'Apply settings',
                ['Please update your subscriptions.']
            );

            renderPanel(form);
        })
        .catch(error => {
            console.error('Update settings error:', error);
            if (error instanceof TypeError || error instanceof SyntaxError) {
                notify('error', 'Apply settings', ['Could not reach the panel or read its response. Please try again.']);
            }
        })
        .finally(() => stopWaiting(icons));
}

async function regenerateNameSnapshots(btn) {
    const confirm = await notify('confirm', 'Regenerate frozen names', ['This clears saved geo-derived names. They will be generated again on the next subscription fetch.', 'Continue?']);
    if (!confirm) return;
    const icons = startWaiting(btn, '', 'refresh');
    try {
        const response = await fetch('./panel/regenerate-name-snapshots', { method: 'POST', credentials: 'include' });
        const { success, status, message } = await response.json();
        if (!success) throw new Error(`status ${status} - ${message}`);
        notify('success', 'Regenerate frozen names', [message]);
    } catch (error) {
        console.error('Regenerating frozen names error:', error);
        notify('error', 'Regenerate frozen names', ['Failed to clear saved names.']);
    } finally {
        stopWaiting(icons);
    }
}

function setupTelegramBot() {
    event.preventDefault();
    event.stopPropagation();

    const formData = new FormData(event.target);
    const form = Object.fromEntries(formData.entries());

    const setupBtn = document.getElementById('setup-telegram');
    const icons = startWaiting(setupBtn, '', 'refresh');

    fetch('./telegram/setup', {
        method: 'PUT',
        body: JSON.stringify(form),
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' }
    })
        .then(res => res.json())
        .then(({ success, status, message, body }) => {
            if (status === 401) {
                notify(
                    'error',
                    'Setup Telegram bot',
                    ['Session expired! Please login and try again.']
                );
                window.location.href = './login';
            }

            if (!success) {
                throw new Error(`status ${status} - ${message}`);
            }

            handleTgFormChanges(body);
            notify(
                'success',
                'Setup Telegram bot',
                ['Telegram bot is ready to use.']
            );
        })
        .catch(error => console.error('Setup Telegram bot error:', error))
        .finally(() => {
            stopWaiting(icons);
            setupBtn.disabled = true;
        });
}

function removeTelegramBot(btn) {
    const icons = startWaiting(btn, '', 'refresh');

    fetch('./telegram/remove', { method: 'POST', credentials: 'include' })
        .then(res => res.json())
        .then(({ success, status, message, body }) => {
            if (status === 401) {
                notify(
                    'error',
                    'Remove Telegram bot',
                    ['Session expired! Please login and try again.']
                );
                window.location.href = './login';
            }

            if (!success) {
                throw new Error(`status ${status} - ${message}`);
            }

            handleTgFormChanges(body);
            notify(
                'success',
                'Remove Telegram bot',
                ['Telegram bot removed successfully!']
            );
        })
        .catch(error => console.error('Remove Telegram bot error:', error))
        .finally(() => stopWaiting(icons));
}

function validateSettings() {
    const configForm = document.getElementById('configForm');
    const formData = new FormData(configForm);

    const fields = [
        'udpXrayNoiseMode',
        'udpXrayNoisePacket',
        'udpXrayNoiseDelayMin',
        'udpXrayNoiseDelayMax',
        'udpXrayNoiseCount'
    ].map(field => formData.getAll(field));

    const form = Object.fromEntries(formData.entries());
    const [modes, packets, delaysMin, delaysMax, counts] = fields;

    form.xrayUdpNoises = modes.map((mode, index) => ({
        type: mode,
        packet: packets[index],
        delay: `${delaysMin[index]}-${delaysMax[index]}`,
        count: counts[index]
    }));

    form.ports = [
        ...defaultHttpPorts,
        ...defaultHttpsPorts
    ].filter(port => formData.has(port.toString()));

    checkboxElements.forEach(elm => {
        form[elm.id] = formData.has(elm.id);
    });

    selectElements.forEach(elm => {
        let value = form[elm.id];
        if (value === 'true') value = true;
        if (value === 'false') value = false;
        form[elm.id] = value;
    });

    inputElements.forEach(elm => {
        if (typeof form[elm.id] === 'string') {
            form[elm.id] = form[elm.id].trim();
        }
    });

    // datetime-local → epoch ms for the backend.
    if (typeof form.subscriptionExpiry === 'string' && form.subscriptionExpiry) {
        const parsed = new Date(form.subscriptionExpiry).getTime();
        form.subscriptionExpiry = Number.isFinite(parsed) ? parsed : 0;
    } else {
        form.subscriptionExpiry = 0;
    }

    numInputElements.forEach(elm => {
        form[elm.id] = Number(form[elm.id].trim());
    });

    textareaElements.forEach(elm => {
        const key = elm.id;
        const value = form[key];
        form[key] = value?.split('\n').map(val => val.trim()).filter(Boolean) || [];
    });

    return form;
}

function logout(event) {
    event.preventDefault();
    fetch('./panel/logout', { method: 'GET', credentials: 'same-origin' })
        .then(response => response.json())
        .then(({ success, status, message }) => {
            if (!success) {
                throw new Error(`status ${status} - ${message}`);
            }

            window.location.href = './login';
        })
        .catch(error => console.error('Logout error:', error));
}

function openResetPass(event) {
    const modal = document.getElementById('resetPassModal');
    const close = modal.querySelector('.modal-close');
    const showHides = modal.querySelectorAll('.show-hide');
    const title = modal.querySelector('.modal-title');
    const form = modal.querySelector('.config-form');
    const username = document.getElementById('usernameContainer');
    if (!event) {
        title.textContent = 'Set Password';
        username.style.display = 'flex';
        username.setAttribute('required', 'true');
    }

    close.onclick = () => modal.hidden = true;
    form.onsubmit = resetPassword;
    showHides.forEach(elm => {
        elm.onclick = () => {
            const input = elm.previousElementSibling;
            const isPassword = input.type === 'password';
            input.type = isPassword ? 'text' : 'password';
            elm.textContent = isPassword ? 'visibility' : 'visibility_off';
        }
    });

    modal.hidden = false;
}

function resetPassword(event) {
    event.preventDefault();
    const username = document.getElementById('username').value.trim().toLowerCase();
    const passwordError = document.getElementById('passwordError');
    const password = document.getElementById('newPassword').value.trim();
    const confirmPassword = document.getElementById('confirmPassword').value.trim();

    if (password !== confirmPassword) {
        passwordError.textContent = 'Passwords do not match';
        return false;
    }

    const valid = /^(?=.*[A-Z])(?=.*\d).{8,}$/.test(password);
    if (!valid) {
        passwordError.textContent = 'Must contain at least one capital letter, one number, and be at least 8 characters long.';
        return false;
    }

    fetch('./panel/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        credentials: 'same-origin',
        body: JSON.stringify({
            username,
            password
        })
    })
        .then(response => response.json())
        .then(({ success, status, message }) => {
            if (!success) {
                passwordError.textContent = message;
                throw new Error(`status ${status} - ${message}`);
            }

            notify('success', 'Reset password', ['Password changed successfully!']);
            window.location.href = './login';
        })
        .catch(error => console.error('Reset password error:', error));
}

function genNoisePacket(mode, packet) {
    switch (mode.value) {
        case 'base64':
            packet.value = randBase64(32, 64);
            break;
        case 'rand':
            packet.value = '50-100';
            break;
        case 'hex':
            packet.value = randHex(32, 64);
            break;
        case 'array':
            packet.value = randArray(32, 64);
            break;
        case 'str': {
            const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
            packet.value = randString(charset, 32, 64);
        }
    }

    handleProxyFormChanges();
}

function randUUID() {
    const uuid = document.getElementById('vlUUID');
    uuid.value = crypto.randomUUID();
    handleProxyFormChanges();
}

function randString(charset, minLen, maxLen) {
    return [...randBytes(minLen, maxLen)]
        .map(byte => charset[byte % charset.length])
        .join('');
}

function randArray(minLen, maxLen) {
    const length = Math.floor(Math.random() * (maxLen - minLen + 1)) + minLen;
    const array = Array.from({ length }, () => Math.floor(Math.random() * 256));
    const field = array.map(String).join(',');

    return field;
}

function randBytes(minBytes, maxBytes) {
    const bytes = Math.floor(Math.random() * (maxBytes - minBytes + 1)) + minBytes;
    const array = new Uint8Array(bytes);
    crypto.getRandomValues(array);

    return array;
}

function randHex(minBytes, maxBytes) {
    return [...randBytes(minBytes, maxBytes)]
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

function randBase64(minBytes, maxBytes) {
    return btoa(String.fromCharCode(...randBytes(minBytes, maxBytes)));
}

function randPassword() {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@$&*_-+;:,.';
    const trPass = document.getElementById('trPass');
    trPass.value = randString(charset, 16, 32);
    handleProxyFormChanges();
}

function randPath() {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const securePath = document.getElementById('securePath');
    securePath.value = randString(charset, 16, 32);
    handleProxyFormChanges();
}

function showChainProxyTestResult(resultEl, kind, text) {
    if (!resultEl) return;
    resultEl.hidden = false;
    resultEl.className = 'chain-proxy-test-result' + (kind ? ` ${kind}` : '');
    resultEl.textContent = text;
}

function renderChainProxyTestResult(resultEl, result) {
    const lines = [result.summary];
    lines.push(`${result.protocol} ${result.server}:${result.port}`);
    lines.push(`VPS reachability: ${result.tcpReachable ? `reachable${result.tcpLatencyMs != null ? ` (${result.tcpLatencyMs} ms)` : ''}` : `unreachable${result.tcpError ? ` — ${result.tcpError}` : ''}`}`);

    if (result.tunnelTested) {
        lines.push(`Relay to ${result.target}: ${result.tunnelOk ? `OK${result.tunnelLatencyMs != null ? ` (${result.tunnelLatencyMs} ms)` : ''}` : `failed${result.tunnelError ? ` — ${result.tunnelError}` : ''}`}`);
    }

    const kind = result.status === 'ok' ? 'ok' : result.status === 'warn' ? 'warn' : 'error';
    showChainProxyTestResult(resultEl, kind, lines.join('\n'));
}

async function testChainProxy(event) {
    const input = document.getElementById('chainProxy');
    const resultEl = document.getElementById('chainProxyTestResult');
    const btn = document.getElementById('chainProxyTestButton');
    const chainProxy = input?.value?.trim();

    if (!chainProxy) {
        showChainProxyTestResult(resultEl, 'error', 'Enter a Chain Proxy config to test.');
        return;
    }

    const icons = startWaiting(btn, '', 'refresh');
    showChainProxyTestResult(resultEl, '', `Testing ${chainProxy}…`);

    try {
        const response = await fetch('./panel/test-chain-proxy', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chainProxy })
        });
        const payload = await response.json();
        if (!payload.success) throw new Error(payload.message || `Request failed (status ${payload.status}).`);
        renderChainProxyTestResult(resultEl, payload.body);
    } catch (error) {
        showChainProxyTestResult(resultEl, 'error', `Could not test the chain proxy: ${error.message}`);
    } finally {
        stopWaiting(icons);
    }
}

async function updatePanel(btn) {
    const confirm = await notify('confirm', 'Update BPB Panel', [
        `BPB Panel verseion ${globalThis.latestVersion} is now available!`,
        'Please read the release notes carefully before updating:',
        'https://github.com/Nexuspt753/BPB-Worker-Panel/releases/latest',
        'Are you sure?'
    ]);

    if (!confirm) return;
    const icons = startWaiting(btn, '', 'refresh');

    fetch('./panel/update-panel', { method: 'POST' })
        .then(res => res.json())
        .then(({ success, status, message }) => {
            if (!success) throw new Error(`status ${status} - ${message}`);
            notify('success', 'Update panel', ['Your panel upgraded successfully!']);
            setTimeout(() => {
                location.reload();
            }, 3000);
        })
        .catch(error => {
            notify('error', 'Update panel', ['Failed to update your BPB Panel, please try again.']);
            console.error('Update panel error:', error)
        })
        .finally(() => stopWaiting(icons));
}

async function deletePanel(btn) {
    const confirm = await notify('confirm', 'Delete BPB Panel', [
        'This will permanently delete your panel from your Cloudflare account',
        'Are you sure?'
    ]);

    if (!confirm) return;
    const icons = startWaiting(btn, '', 'refresh');

    fetch('./panel/delete-panel', { method: 'POST' })
        .then(res => res.json())
        .then(({ success, status, message }) => {
            if (!success) throw new Error(`status ${status} - ${message}`);
            notify('success', 'Delete panel', ['Your panel deleted successfully!']);
        })
        .catch(error => {
            notify('error', 'Delete panel', ['Failed to delete your BPB Panel, please try again.']);
            console.error('Delete panel error:', error)
        })
        .finally(() => stopWaiting(icons));
}

function notify(type, title, text) {
    return new Promise(resolve => {
        const fragment = document.getElementById('message-template').content.cloneNode(true);
        const modal = fragment.querySelector('.modal');
        modal.hidden = false;

        modal.querySelector('.message-title').textContent = title;
        modal.querySelector('.message-text').textContent = Array.isArray(text) ? text.join('\n') : String(text ?? '');

        const icon = modal.querySelector('.message-icon');
        const isOk = type === 'success' || type === 'info';
        const isConfirm = type === 'confirm';

        icon.textContent = isOk ? 'check_circle' : isConfirm ? 'help' : 'error';
        icon.style.color = isOk ? 'var(--color-icon-green)' : 'var(--color-icon-red)';

        const okBtn = modal.querySelector('.message-ok-btn');
        const cancelBtn = modal.querySelector('.message-cancel-btn');
        const closeBtn = modal.querySelector('.modal-close');

        const handle = (value) => {
            modal.remove();
            resolve(value);
        };

        if (type === 'confirm') {
            cancelBtn.onclick = () => handle(false);
        } else {
            cancelBtn.style.display = 'none';
        }

        if (type === 'info') {
            okBtn.style.display = 'none';
        } else {
            okBtn.onclick = () => handle(true);
        }

        closeBtn.onclick = () => handle(false)
        document.body.appendChild(fragment);

        if (type === 'info') {
            setTimeout(() => {
                modal.remove();
                resolve(null);
            }, 1000);

            return;
        }
    });
}

function startWaiting(button, id, customIcon, cw = true) {
    document.body.classList.add('is-loading');
    const btn = button ?? document.getElementById(id);
    const icon = btn.querySelector('span');
    const initIcon = icon.textContent;
    if (customIcon) icon.textContent = customIcon;
    icon.classList.add(`${cw ? 'cw' : 'ccw'}-spinning`);
    return { icon, initIcon };
}

function stopWaiting(icons) {
    document.body.classList.remove('is-loading');
    const { icon, initIcon } = icons;
    icon.classList.remove('cw-spinning');
    icon.classList.remove('ccw-spinning');
    if (initIcon !== icon.textContent) icon.textContent = initIcon;
}

function elm(tag, props = {}, children = []) {
    const node = document.createElement(tag);
    Object.assign(node, props);
    node.append(...[].concat(children));
    return node;
}

const createIcon = (text) => elm('span', {
    className: 'material-symbols-rounded',
    textContent: text
});

function createFormControl(labelText, action) {
    const label = elm('span', { textContent: labelText }, action ? createIcon('refresh') : []);
    const control = elm('div', { className: 'form-control' }, [label, elm('div')]);

    return control;
}

async function deleteNoise(event) {
    const confirm = await notify('confirm', 'Delete UDP noise', ['Are you sure?']);
    if (!confirm) return;

    event.target.closest('.inner-container').remove();
    handleProxyFormChanges();
}

function addNoise(isManual, noiseIndex, udpNoise) {
    const index = noiseIndex
        ? noiseIndex
        : document.getElementById('noises').childElementCount;

    const noise = udpNoise || {
        type: 'rand',
        packet: '50-100',
        delay: '1-5',
        count: 5
    };

    const heading = elm('h4', { textContent: `Noise ${index + 1}` });
    const headerDiv = elm('div', { className: 'header-container' }, heading);

    if (index !== 0) {
        const deleteBtn = elm('button', {
            type: 'button',
            className: 'delete-noise',
            onclick: deleteNoise
        }, createIcon('delete'));
        headerDiv.appendChild(deleteBtn);
    }

    const modeOptions = [
        ['base64', 'Base64'],
        ['rand', 'Random'],
        ['str', 'String'],
        ['hex', 'Hex'],
        ['array', 'Array']
    ].map(([value, label]) => elm('option', { value, textContent: label, selected: noise.type === value }));

    const modeSelect = elm('select', { name: 'udpXrayNoiseMode' }, modeOptions);
    const modeControl = createFormControl('Mode');

    const selectWrapper = modeControl.querySelector('div');
    selectWrapper.className = 'select-wrapper';
    selectWrapper.append(modeSelect, createIcon('keyboard_arrow_down'))

    const packetInput = elm('input', { type: 'text', name: 'udpXrayNoisePacket', value: noise.packet });
    const packetControl = createFormControl('Packet', true);
    packetControl.querySelector('div').appendChild(packetInput);
    const generateBtn = packetControl.querySelector('.material-symbols-rounded');

    modeSelect.onchange = generateBtn.onclick = () => genNoisePacket(modeSelect, packetInput);

    const countInput = elm('input', {
        type: 'number', name: 'udpXrayNoiseCount', value: String(noise.count), min: '1', required: true
    });
    const countControl = createFormControl('Count');
    countControl.querySelector('div').appendChild(countInput);

    const [delayMin, delayMax] = noise.delay.split('-');
    const delayMinInput = elm('input', { type: 'number', name: 'udpXrayNoiseDelayMin', value: delayMin, min: '1', required: true });
    const delayMaxInput = elm('input', { type: 'number', name: 'udpXrayNoiseDelayMax', value: delayMax, min: '1', required: true });
    const minMaxDiv = elm('div', { className: 'min-max' }, [delayMinInput, elm('span', { textContent: ' - ' }), delayMaxInput]);
    const delayControl = createFormControl('Delay');
    delayControl.querySelector('div').appendChild(minMaxDiv);

    const section = elm('div', { className: 'section' }, [modeControl, packetControl, countControl, delayControl]);
    const container = elm('div', { className: 'inner-container' }, [headerDiv, section]);

    document.getElementById('noises').append(container);
    if (isManual) handleProxyFormChanges(true);
}

function renderPorts(ports) {
    let noneTlsPortsBlock = document.createDocumentFragment();
    let tlsPortsBlock = document.createDocumentFragment();

    const totalPorts = [
        ...(window.origin.includes('workers.dev') ? defaultHttpPorts : []),
        ...defaultHttpsPorts
    ];

    totalPorts.forEach(port => {
        const isChecked = ports.includes(port);
        const isHttpsPort = defaultHttpsPorts.includes(port);

        const checkbox = elm('input', {
            type: 'checkbox',
            name: String(port),
            value: 'true',
            checked: isChecked
        });

        const label = elm('span', { textContent: String(port) });
        const wrapper = elm('div', { className: 'checkbox-wrapper' }, [checkbox, label]);

        if (isHttpsPort) {
            tlsPortsBlock.appendChild(wrapper);
        } else {
            noneTlsPortsBlock.appendChild(wrapper);
        }
    });

    const tlsContainer = document.getElementById('tls-ports');
    tlsContainer.innerHTML = '';
    tlsContainer.appendChild(tlsPortsBlock);

    const nonTlsContainer = document.getElementById('non-tls-ports');
    if (noneTlsPortsBlock.childElementCount > 0) {
        nonTlsContainer.innerHTML = '';
        nonTlsContainer.appendChild(noneTlsPortsBlock);
        document.getElementById('none-tls').style.display = 'flex';
    }
}

function renderNoises(xrayUdpNoises) {
    document.getElementById('noises').innerHTML = '';
    xrayUdpNoises.forEach((noise, index) => {
        addNoise(false, index, noise);
    });
}

function renderSubscriptions(subscriptions) {
    if (!subscriptions) return;
    for (const [type, { label, categories }] of Object.entries(subscriptions)) {
        const help = elm('a', {
            className: 'help-icon',
            href: `https://nexuspt753.github.io/BPB-Worker-Panel/usage/${type}/`,
            target: '_blank',
            title: 'Help'
        }, createIcon('info'));

        const header = elm('h3', { textContent: label });
        const summary = elm('summary', {}, header);
        const section = elm('details', {}, summary);
        const table = elm('table', {}, categories.map(({ core, clients }) => {
            const clientSection = elm('td', {}, clients.map(client => {
                const icon = createIcon('verified');
                const title = elm('span', { textContent: client });
                const addBtn = elm('button', {
                    type: 'button',
                    title: `Add to ${client}`,
                    ariaLabel: `Add to ${client}`,
                    className: 'client-add',
                    onclick: () => oneClickAdd(client, type, core, label)
                }, createIcon('add_circle'));
                const wrapper = elm('div', {}, [icon, title, addBtn]);

                return wrapper;
            }));

            const url = generateSubUrl(type, core, label);
            const ctaSection = elm('td');

            const wgCore = ['wireguard', 'amnezia'].includes(core);
            if (!wgCore) {
                const qrBtn = elm('button', { title: 'Display QR code', onclick: () => showQRCode(url) }, createIcon('qr_code'));
                const copyBtn = elm('button', { title: 'Copy subscription URL', onclick: () => copyToClipboard(url) }, createIcon('content_copy'));
                ctaSection.append(qrBtn, copyBtn);
            }

            if (type !== 'raw') {
                const dlBtn = elm('button', { title: 'Download config', onclick: () => dlUrl(url) }, createIcon('download'));
                ctaSection.appendChild(dlBtn);
            }

            return elm('tr', {}, [clientSection, ctaSection]);
        }));

        const container = elm('div', { className: 'table-container' }, table);
        section.appendChild(container);
        const item = elm('div', { className: 'accordion-item' }, [section, help]);
        document.getElementById('subscriptions').appendChild(item);
    };
}

function renderClients(clients) {
    if (!clients) return;
    clients.forEach(client => {
        const name = elm('td', { scope: 'col', textContent: client.name });
        const minVer = elm('td', { scope: 'col', textContent: client.minVer });

        const source = elm('span', { textContent: client.source });
        const dlBtn = elm('a', {
            href: atob(client.b64Url),
            target: '_blank',
            rel: 'noopener noreferrer'
        }, createIcon('download'));
        const download = elm('td', {}, [source, dlBtn]);

        const row = elm('tr', {}, [name, minVer, download])

        document.getElementById('supported-clients').appendChild(row);
    });
}

// ---------------------------------------------------------------- Diagnostics
// Each loader is self-contained and best-effort: a failed fetch or missing
// section simply leaves the list empty or shows a short notice — never an error
// that interrupts the panel.

function diagnosticsFetch(path, options) {
    return fetch(path, { credentials: 'include', ...options })
        .then(res => res.json())
        .then(({ success, status, message, body }) => {
            if (!success) throw new Error(`status ${status} - ${message}`);
            return body;
        });
}

function setDiagnosticsList(id, rows) {
    const list = document.getElementById(id);
    if (!list) return;
    list.replaceChildren();
    if (!rows || !rows.length) {
        list.textContent = 'No data yet.';
        return;
    }
    rows.forEach(row => {
        const item = elm('div', { className: 'diagnostics-row', textContent: row });
        list.appendChild(item);
    });
}

async function batchImportConfigs() {
    const textarea = document.getElementById('batchImportTextarea');
    const resultEl = document.getElementById('batchImportResult');
    const btn = document.getElementById('batchImportButton');
    const text = textarea?.value?.trim();
    if (!text) {
        showChainProxyTestResult(resultEl, 'error', 'Paste at least one config to import.');
        return;
    }

    // Split on newlines, and also handle a full base64 subscription body.
    let lines = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length === 1) {
        try {
            const decoded = atob(lines[0]);
            if (decoded && decoded.includes('://')) {
                lines = decoded.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
            }
        } catch { /* not base64 — keep as a single line */ }
    }

    const icons = startWaiting(btn, '', 'refresh');
    showChainProxyTestResult(resultEl, '', `Importing ${lines.length} config(s)…`);
    try {
        const response = await fetch('./panel/import-configs', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ uris: lines })
        });
        const payload = await response.json();
        if (!payload.success) {
            const skipped = Array.isArray(payload.body) ? payload.body : [];
            const details = skipped.map(s => `${s.line} — ${s.reason}`).join('\n');
            showChainProxyTestResult(resultEl, 'error', `${payload.message || 'Import failed.'}${details ? '\n' + details : ''}`);
            return;
        }
        const { added, skipped } = payload.body || {};
        const skipLines = (skipped || []).map(s => `${s.line} — ${s.reason}`).join('\n');
        showChainProxyTestResult(resultEl, 'ok', `Imported ${added} config(s).${skipLines ? '\nSkipped:\n' + skipLines : ''}`);
        textarea.value = '';
        notify('success', 'Batch import', [`Imported ${added} config(s). Please review Single Configs and Apply.`]);
    } catch (error) {
        showChainProxyTestResult(resultEl, 'error', `Could not import configs: ${error.message}`);
    } finally {
        stopWaiting(icons);
    }
}

async function runChainHealthCheck() {
    const btn = document.getElementById('runChainHealth');
    const resultEl = document.getElementById('chainHealthResult');
    const icons = startWaiting(btn, '', 'refresh');
    try {
        const body = await diagnosticsFetch('./panel/run-chain-health', { method: 'POST' });
        const status = body?.status;
        const kind = status === 'ok' ? 'ok' : status === 'warn' ? 'warn' : status === 'fail' ? 'error' : '';
        showChainProxyTestResult(resultEl, kind, body?.summary || 'No chain proxy configured.');
    } catch (error) {
        showChainProxyTestResult(resultEl, 'error', `Could not check chain proxy: ${error.message}`);
    } finally {
        stopWaiting(icons);
    }
}

async function loadChainHealth() {
    try {
        const body = await diagnosticsFetch('./panel/chain-health');
        const resultEl = document.getElementById('chainHealthResult');
        if (!body || body.status === 'unknown') {
            resultEl.textContent = 'Not checked yet.';
            return;
        }
        const kind = body.status === 'ok' ? 'ok' : body.status === 'warn' ? 'warn' : 'error';
        showChainProxyTestResult(resultEl, kind, body.summary || '');
    } catch { /* optional */ }
}

async function loadBackups() {
    const btn = document.getElementById('refreshBackups');
    const icons = startWaiting(btn, '', 'refresh');
    try {
        const rows = await diagnosticsFetch('./panel/backups');
        const list = document.getElementById('backupList');
        list.replaceChildren();
        if (!rows || !rows.length) {
            list.textContent = 'No backups yet. A backup is saved before every Apply.';
            return;
        }
        rows.forEach(backup => {
            const date = new Date(backup.ts).toLocaleString();
            const label = elm('span', { textContent: `${date}` });
            const restoreBtn = elm('button', {
                className: 'button',
                textContent: 'Restore',
                onclick: () => restoreBackup(backup.ts)
            });
            const row = elm('div', { className: 'diagnostics-row' }, [label, restoreBtn]);
            list.appendChild(row);
        });
    } catch (error) {
        setDiagnosticsList('backupList', [`Failed to load backups: ${error.message}`]);
    } finally {
        stopWaiting(icons);
    }
}

async function restoreBackup(ts) {
    const confirm = await notify('confirm', 'Restore backup', ['Restore settings from this backup? A backup of the current settings will be saved first.', 'Continue?']);
    if (!confirm) return;
    try {
        const res = await fetch('./panel/restore-backup', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ts })
        });
        const { success, status, message, body } = await res.json();
        if (!success) {
            notify('error', 'Restore backup', [message || `status ${status}`]);
            return;
        }
        notify('success', 'Restore backup', [message || 'Settings restored.']);
        setTimeout(() => window.location.reload(), 800);
    } catch (error) {
        notify('error', 'Restore backup', [`Failed to restore: ${error.message}`]);
    }
}

async function loadUsageStats() {
    const btn = document.getElementById('refreshUsageStats');
    const icons = startWaiting(btn, '', 'refresh');
    try {
        const rows = await diagnosticsFetch('./panel/usage-stats');
        const list = document.getElementById('usageStatsList');
        list.replaceChildren();
        if (!rows || !rows.length) {
            list.textContent = 'No usage recorded yet. Enable Usage statistics and fetch a subscription.';
            return;
        }
        rows.forEach(row => {
            const text = `${row.name} — today ${row.today}, 7 days ${row.week}, last ${new Date(row.lastAt).toLocaleString()}`;
            list.appendChild(elm('div', { className: 'diagnostics-row', textContent: text }));
        });
    } catch (error) {
        setDiagnosticsList('usageStatsList', [`Failed to load usage: ${error.message}`]);
    } finally {
        stopWaiting(icons);
    }
}

async function loadAccessLog() {
    const btn = document.getElementById('refreshAccessLog');
    const icons = startWaiting(btn, '', 'refresh');
    try {
        const rows = await diagnosticsFetch('./panel/access-log');
        const list = document.getElementById('accessLogList');
        list.replaceChildren();
        if (!rows || !rows.length) {
            list.textContent = 'No fetches recorded. Enable the Subscription access log setting.';
            return;
        }
        rows.forEach(row => {
            const text = `${new Date(row.ts).toLocaleString()} — ${row.type}/${row.client} — ${row.ipHash.slice(0, 12)}…`;
            list.appendChild(elm('div', { className: 'diagnostics-row', textContent: text }));
        });
    } catch (error) {
        setDiagnosticsList('accessLogList', [`Failed to load access log: ${error.message}`]);
    } finally {
        stopWaiting(icons);
    }
}

async function loadEndpoints() {
    const btn = document.getElementById('refreshEndpoints');
    const icons = startWaiting(btn, '', 'refresh');
    try {
        const rows = await diagnosticsFetch('./panel/endpoints');
        const list = document.getElementById('endpointList');
        list.replaceChildren();
        if (!rows || !rows.length) {
            list.textContent = 'No endpoint latency cached. Enable Auto-test endpoint latency and fetch a subscription.';
            return;
        }
        rows.forEach(row => {
            const text = `${row.address}:${row.port} — ${row.ms} ms — ${new Date(row.measuredAt).toLocaleString()}`;
            list.appendChild(elm('div', { className: 'diagnostics-row', textContent: text }));
        });
    } catch (error) {
        setDiagnosticsList('endpointList', [`Failed to load endpoints: ${error.message}`]);
    } finally {
        stopWaiting(icons);
    }
}

async function loadErrorLog() {
    const btn = document.getElementById('refreshErrors');
    const icons = startWaiting(btn, '', 'refresh');
    try {
        const rows = await diagnosticsFetch('./panel/error-log');
        const list = document.getElementById('errorLogList');
        list.replaceChildren();
        if (!rows || !rows.length) {
            list.textContent = 'No errors recorded.';
            return;
        }
        rows.forEach(row => {
            const text = `${new Date(row.ts).toLocaleString()} — ${row.source}: ${row.message}`;
            list.appendChild(elm('div', { className: 'diagnostics-row', textContent: text }));
        });
    } catch (error) {
        setDiagnosticsList('errorLogList', [`Failed to load error log: ${error.message}`]);
    } finally {
        stopWaiting(icons);
    }
}

async function clearErrorLog() {
    const btn = document.getElementById('clearErrors');
    const icons = startWaiting(btn, '', 'delete');
    try {
        await diagnosticsFetch('./panel/clear-error-log', { method: 'POST' });
        await loadErrorLog();
        notify('success', 'Error log', ['Error log cleared.']);
    } catch (error) {
        notify('error', 'Error log', [`Failed to clear: ${error.message}`]);
    } finally {
        stopWaiting(icons);
    }
}

async function loadDiagnostics() {
    loadChainHealth();
    loadBackups();
    loadUsageStats();
    loadAccessLog();
    loadEndpoints();
    loadErrorLog();
}

// ------------------------------------------------------------------ i18n
// Minimal, additive internationalization. The panel's English text is the
// source of truth; a Farsi dictionary translates the most visible static
// strings. No `dir` flip is applied (the stylesheet still uses hardcoded
// left/right in places), so layout never changes — only text. Untranslated
// keys fall back to English. The preference lives in localStorage.

const I18N = {
    fa: {
        'Admin': 'مدیریت',
        'Last 24h Requests': 'درخواست‌های ۲۴ ساعت گذشته',
        'Settings': 'تنظیمات',
        'Telegram Bot': 'بات تلگرام',
        'Telegram Bot Token': 'توکن بات تلگرام',
        'Telegram User ID': 'شناسه کاربری تلگرام',
        'Proxy Settings': 'تنظیمات پروکسی',
        'Common': 'تنظیمات مشترک',
        'Local DNS': 'DNS محلی',
        'Anti Sanction DNS': 'DNS ضد تحریم',
        'Fake DNS': 'DNS جعلی',
        'IPv6': 'IPv6',
        'Allow connections from LAN': 'اجازه اتصال از LAN',
        'Log Level': 'سطح لاگ',
        'Custom Domain': 'دامنه سفارشی',
        'Underlying DoH': 'DoH زیرین',
        'Fallback Domain': 'دامنه جایگزین',
        'VLESS - Trojan': 'VLESS - Trojan',
        'Protocols': 'پروتکل‌ها',
        'Remote DNS': 'DNS راه دور',
        'Upstream TCP Proxy': 'پروکسی TCP بالادست',
        'Chain Proxy': 'پروکسی زنجیره‌ای',
        'Fingerprint': 'اثر انگشت',
        'Best Ping Interval': 'فاصله بهترین پینگ',
        'TCP Fast Open': 'TCP Fast Open',
        'Mode': 'حالت',
        'Addresses': 'آدرس‌ها',
        'Host': 'میزبان',
        'SNI': 'SNI',
        'Xray Fragment': 'Fragment ایکس‌ری',
        'Packets': 'بسته‌ها',
        'Length': 'طول',
        'Delay': 'تاخیر',
        'Max Split': 'حداکثر تقسیم',
        'External Raw Configs': 'کانفیگ‌های خام خارجی',
        'Subscriptions': 'اشتراک‌ها',
        'Single Configs': 'کانفیگ‌های تکی',
        'Config Names': 'نام کانفیگ‌ها',
        'Config Name Template': 'قالب نام کانفیگ',
        'Template preset': 'قالب از پیش تعیین‌شده',
        'Name formatting': 'قالب‌بندی نام',
        'Maximum name length': 'حداکثر طول نام',
        'Geo privacy': 'حریم خصوصی جغرافیایی',
        'Freeze geo-derived names': 'ثابت کردن نام‌های جغرافیایی',
        'Address groups': 'گروه‌های آدرس',
        'Auto-test endpoint latency': 'تست خودکار تاخیر',
        'Latency interval (minutes)': 'فاصله تاخیر (دقیقه)',
        'Warp General': 'Warp عمومی',
        'Warp PRO': 'Warp حرفه‌ای',
        'Count': 'تعداد',
        'Size': 'اندازه',
        'Routing Rules': 'قوانین مسیریابی',
        'Usage statistics': 'آمار مصرف',
        'Chain proxy health alerts': 'هشدار سلامت پروکسی زنجیره‌ای',
        'Subscription access log': 'گزارش دسترسی اشتراک',
        'Rate limit subscriptions': 'محدودیت نرخ اشتراک',
        'Rate limit per hour': 'محدودیت در ساعت',
        'Rate limit per day': 'محدودیت در روز',
        'Subscription expiry': 'انقضای اشتراک',
        'Diagnostics': 'عیب‌یابی',
        'Chain proxy health': 'سلامت پروکسی زنجیره‌ای',
        'Check now': 'بررسی',
        'Backups': 'پشتیبان‌گیری',
        'Refresh': 'به‌روزرسانی',
        'Usage statistics': 'آمار مصرف',
        'Subscription access log': 'گزارش دسترسی اشتراک',
        'Endpoint health': 'سلامت نقطه پایانی',
        'Worker error log': 'گزارش خطای Worker',
        'Clear': 'پاک کردن',
        'Supported Clients': 'کلاینت‌های پشتیبانی‌شده',
        'Client': 'کلاینت',
        'Minimum Requirement': 'حداقل نیاز',
        'Get Latest': 'آخرین نسخه',
        'My IP': 'IP من',
        'Information': 'اطلاعات',
        'Cloudflare targets': 'اهداف Cloudflare',
        'Other targets': 'سایر اهداف',
        'Country': 'کشور',
        'City': 'شهر',
        'ISP': 'ارائه‌دهنده اینترنت',
        'Import - Export settings': 'ورود و خروج تنظیمات',
        'Usage': 'مصرف',
        'Total': 'مجموع',
        'Log out': 'خروج'
    }
};

const i18nOriginal = new WeakMap();
let currentLang = 'en';

function applyI18n(lang) {
    currentLang = lang === 'fa' ? 'fa' : 'en';
    const dict = I18N[currentLang] || {};

    const translateTextNodes = (root) => {
        if (!root) return;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        const nodes = [];
        while (walker.nextNode()) {
            const node = walker.currentNode;
            const text = node.nodeValue.trim();
            if (text) nodes.push(node);
        }
        nodes.forEach(node => {
            const text = node.nodeValue.trim();
            const translated = dict[text];
            if (!translated) return;
            if (!i18nOriginal.has(node)) {
                i18nOriginal.set(node, node.nodeValue);
            }
            node.nodeValue = node.nodeValue.replace(text, translated);
        });
    };

    const restoreTextNodes = (root) => {
        if (!root) return;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
            const node = walker.currentNode;
            const original = i18nOriginal.get(node);
            if (original !== undefined) {
                node.nodeValue = original;
                i18nOriginal.delete(node);
            }
        }
    };

    const root = document.body;
    if (currentLang === 'en') {
        restoreTextNodes(root);
    } else {
        translateTextNodes(root);
    }
}

function initI18n() {
    let lang = 'en';
    try {
        lang = localStorage.getItem('panelLang') || 'en';
        if (lang !== 'fa') lang = 'en';
    } catch { /* localStorage unavailable */ }

    const select = document.getElementById('panelLang');
    if (select) {
        select.value = lang;
        select.addEventListener('change', () => {
            const next = select.value === 'fa' ? 'fa' : 'en';
            try { localStorage.setItem('panelLang', next); } catch { /* ignore */ }
            applyI18n(next);
        });
    }

    applyI18n(lang);
}