const defaultHttpsPorts = [443, 8443, 2053, 2083, 2087, 2096];
const defaultHttpPorts = [80, 8080, 8880, 2052, 2082, 2086, 2095];
const nameTemplateTokens = [
    'FLAG', 'COUNTRY', 'COUNTRY_CODE', 'CITY', 'REGION', 'ISP', 'ASN', 'TYPE', 'GEO_AGE',
    'LATENCY', 'LATENCY_AGE', 'IP', 'IPNAME', 'GROUP', 'INDEX', 'PORT', 'MARKER', 'PROTO', 'CHAIN',
    'EGRESS_IP', 'B', 'F', 'D', 'C', 'SECURITY', 'TRANSPORT', 'SNI', 'HOST', 'FAMILY',
    'DOMAIN', 'CORE', 'KIND'
];
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
            option.classList.toggle('active', index === openIndex);
        });
        const active = list.children[openIndex];
        if (active) active.scrollIntoView({ block: 'nearest' });
    };

    const hide = () => {
        list.hidden = true;
        list.replaceChildren();
        openIndex = -1;
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
        const previousOpen = before.lastIndexOf('{', lastOpen - 1);
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
        list.replaceChildren(...options.map((token) => {
            const option = document.createElement('li');
            option.dataset.token = token;
            option.textContent = `{${token}}`;
            option.addEventListener('mousedown', (event) => {
                event.preventDefault();
                choose(token);
            });
            return option;
        }));
        openIndex = 0;
        list.hidden = false;
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

function previewTokenValue(token, context) {
    const values = {
        FLAG: context.flag,
        COUNTRY: context.country,
        COUNTRY_CODE: context.countryCode,
        CITY: context.city,
        REGION: context.region,
        ISP: context.isp,
        ASN: context.asn,
        TYPE: context.type,
        GEO_AGE: context.geoAge,
        LATENCY: context.latency,
        LATENCY_AGE: context.latencyAge,
        IP: context.address,
        IPNAME: context.customName,
        GROUP: context.group,
        INDEX: String(context.index),
        PORT: String(context.port),
        MARKER: context.marker,
        PROTO: context.proto,
        CHAIN: context.chain ? '🔗' : '',
        EGRESS_IP: context.egressIp,
        B: 'BPB',
        F: context.flag,
        D: context.address,
        C: context.country,
        SECURITY: context.security,
        TRANSPORT: context.transport,
        SNI: context.sni,
        HOST: context.host,
        FAMILY: context.family,
        DOMAIN: context.domain,
        CORE: context.core,
        KIND: context.kind
    };
    return Object.prototype.hasOwnProperty.call(values, token) ? values[token] : undefined;
}

function previewTemplateValueIsPresent(token, context) {
    const value = previewTokenValue(token, context);
    return value !== undefined && value !== null && String(value) !== '';
}

function renderPreviewTemplate(template, context) {
    if (typeof template !== 'string' || template.includes('[[[') || template.includes(']]]') || /\[\[\s*\]\]/.test(template)) return null;
    if (template.includes('[[') && !template.includes(']]')) return null;
    if (template.includes(']]') && !template.includes('[[')) return null;

    let source = template.replace(/\[\[([^\[\]]*)\]\]/g, (_match, body) => {
        const tokens = [...body.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(match => match[1].toUpperCase());
        return tokens.some(token => previewTemplateValueIsPresent(token, context)) ? body : '';
    });

    source = source.replace(/\{([A-Za-z0-9_]+)\}/g, (_match, token) => {
        const value = previewTokenValue(token.toUpperCase(), context);
        if (value === undefined || value === null || value === '') {
            return ['MARKER', 'CHAIN', 'GROUP'].includes(token.toUpperCase()) ? '' : '--';
        }
        return String(value);
    });

    return /[{}[\]]/.test(source) ? null : source;
}

function previewGraphemes(value) {
    if (Intl.Segmenter) {
        return [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].map(item => item.segment);
    }

    const result = [];
    for (const char of Array.from(value)) {
        const previous = result[result.length - 1];
        const isJoiner = char === '\u200d';
        const isExtend = /[\u0300-\u036f\uFE00-\uFE0F\u{1F3FB}-\u{1F3FF}]/u.test(char);
        if (previous && (previous.endsWith('\u200d') || isJoiner || isExtend)) {
            result[result.length - 1] += char;
        } else if (previous && /^[\u{1F1E6}-\u{1F1FF}]$/u.test(previous) && /^[\u{1F1E6}-\u{1F1FF}]$/u.test(char)) {
            result[result.length - 1] += char;
        } else {
            result.push(char);
        }
    }
    return result;
}

function truncatePreviewName(value, maxLength) {
    if (!Number.isInteger(maxLength) || maxLength < 1) return value;
    return previewGraphemes(value).slice(0, maxLength).join('').trimEnd();
}

function formatPreviewName(value, mode, maxLength) {
    let result = String(value || '')
        .replace(/[\u0000-\u001f\u007f]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    if (mode === 'compact') {
        result = result.replace(/\s*([|·])\s*/g, '$1').replace(/([|·])(?:\1)+/g, '$1').replace(/\s+-\s+/g, '-');
    } else if (mode === 'ascii') {
        result = result.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e]/g, '').trim();
    }
    const limit = Number(maxLength);
    return truncatePreviewName(result, Number.isInteger(limit) && limit > 0 ? limit : undefined);
}

function previewNormalizeAddress(address) {
    const value = String(address || '').trim();
    const bare = value.startsWith('[') && value.endsWith(']') ? value.slice(1, -1) : value;
    return bare.toLowerCase();
}

function previewStableNameKey(context) {
    return context.identity || [
        context.kind,
        context.core,
        context.proto,
        previewNormalizeAddress(context.address),
        context.port,
        context.domain,
        context.marker,
        context.chain ? 'chain' : 'direct',
        context.transport,
        context.security,
        context.customName,
        context.group
    ].map(value => String(value ?? '')).join('|');
}

function previewHash(source) {
    let hash = 0x811c9dc5;
    for (const char of source) {
        hash ^= char.codePointAt(0) || 0;
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, '0');
}

function stablePreviewSuffix(context) {
    return `~${previewHash(previewStableNameKey(context))}`;
}

function previewShortIdentityName(context, maxLength, collision = 0) {
    const seed = collision > 0
        ? `${previewStableNameKey(context)}|collision:${collision}`
        : previewStableNameKey(context);
    const hash = previewHash(seed);
    const value = maxLength === 1 ? hash : `~${hash}`;
    return truncatePreviewName(value, maxLength);
}

function previewUniqueName(rendered, template, context, mode, maxLength, registry = new Set()) {
    const tokens = new Set([...template.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(match => match[1].toUpperCase()));
    const missing = [];
    if (context.address && !tokens.has('IP') && !tokens.has('D')) missing.push('address');
    if (context.domain && context.domain !== context.address && !tokens.has('DOMAIN')) missing.push('domain');
    if (context.port != null && !tokens.has('PORT')) missing.push('port');
    if (context.proto && !tokens.has('PROTO')) missing.push('protocol');
    if (context.chain && !tokens.has('CHAIN')) missing.push('chain');
    if (context.marker && !tokens.has('MARKER')) missing.push('marker');
    if (context.kind && !tokens.has('KIND')) missing.push('kind');
    if (context.core && !tokens.has('CORE')) missing.push('core');
    if (context.transport && !tokens.has('TRANSPORT')) missing.push('transport');
    if (context.security && !tokens.has('SECURITY')) missing.push('security');
    if (context.customName && !tokens.has('IPNAME')) missing.push('custom-name');
    if (context.group && !tokens.has('GROUP')) missing.push('group');
    if (context.identity) missing.push('identity');

    const suffix = [];
    if (missing.includes('chain')) suffix.push(mode === 'ascii' ? 'CHAIN' : '🔗');
    if (missing.includes('marker') && context.marker) suffix.push(context.marker.trim());
    if (missing.includes('protocol') && context.proto) suffix.push(context.proto);
    if (missing.includes('port') && context.port != null) suffix.push(String(context.port));
    if (missing.length) suffix.push(stablePreviewSuffix(context));

    const base = formatPreviewName(rendered, mode, 0);
    const limit = Number(maxLength);
    const validLimit = Number.isInteger(limit) && limit > 0 ? limit : undefined;
    const compose = (suffixValue, collision = 0) => {
        const suffixText = formatPreviewName(suffixValue, mode, 0);
        if (validLimit && suffixText) {
            const suffixLength = previewGraphemes(suffixText).length;
            if (suffixLength >= validLimit) {
                return formatPreviewName(previewShortIdentityName(context, validLimit, collision), mode, validLimit);
            }
            const separator = base ? ' ' : '';
            const available = validLimit - suffixLength - (separator ? 1 : 0);
            const prefix = available > 0 ? truncatePreviewName(base, available) : '';
            return formatPreviewName(`${prefix}${separator}${suffixText}`, mode, validLimit);
        }
        const composed = suffixText ? `${base}${base ? ' ' : ''}${suffixText}` : base;
        return formatPreviewName(composed, mode, validLimit);
    };

    let candidate = compose(suffix.join(' '));
    let collision = 1;
    while (registry.has(candidate) && collision < 4096) {
        collision++;
        candidate = compose(`${stablePreviewSuffix(context)}-${collision}`, collision);
    }
    registry.add(candidate);
    return candidate;
}

const templatePreviewContexts = [
    {
        label: 'Frankfurt / VLESS', index: 1, address: '1.1.1.1', port: 443, flag: '🇩🇪', country: 'Germany', countryCode: 'DE',
        city: 'Frankfurt', region: 'Hesse', isp: 'Cloudflare', asn: 'AS13335', type: 'Hosting', geoAge: '2h', latency: '42', latencyAge: '4m',
        customName: '', group: 'Cloudflare Fast', marker: '', proto: 'VLESS', chain: false, egressIp: '203.0.113.10', security: 'TLS', transport: 'WS', sni: 'example.com', host: 'example.com', family: 'IPv4', domain: 'example.com', core: 'xray', kind: 'Normal', identity: 'normal|xray|vless|1.1.1.1|443|example.com'
    },
    {
        label: 'Frankfurt / Trojan', index: 1, address: '1.1.1.1', port: 443, flag: '🇩🇪', country: 'Germany', countryCode: 'DE',
        city: 'Frankfurt', region: 'Hesse', isp: 'Cloudflare', asn: 'AS13335', type: 'Hosting', geoAge: '2h', latency: '38', latencyAge: '4m',
        customName: '', group: 'Cloudflare Fast', marker: '', proto: 'Trojan', chain: false, egressIp: '203.0.113.10', security: 'TLS', transport: 'WS', sni: 'example.com', host: 'example.com', family: 'IPv4', domain: 'example.com', core: 'sing-box', kind: 'Normal', identity: 'normal|sing-box|trojan|1.1.1.1|443|example.com'
    },
    {
        label: 'Named clean IP', index: 2, address: '2.2.2.2', port: 8443, flag: '🇩🇪', country: 'Germany', countryCode: 'DE',
        city: 'Frankfurt', region: 'Hesse', isp: 'Example CDN', asn: 'AS64500', type: 'Hosting', geoAge: '1d', latency: '61', latencyAge: '18m',
        customName: 'Fast edge', group: 'Cloudflare Fast', marker: 'C', proto: 'VLESS', chain: false, egressIp: '203.0.113.10', security: 'TLS', transport: 'WS', sni: 'example.com', host: 'cdn.example.com', family: 'IPv4', domain: 'example.com', core: 'clash', kind: 'Normal', identity: 'normal|clash|vless|2.2.2.2|8443|example.com'
    },
    {
        label: 'Fragment chain', index: 3, address: 'example.com', port: 443, flag: '🇺🇸', country: 'United States', countryCode: 'US',
        city: 'Ashburn', region: 'Virginia', isp: 'Cloudflare', asn: 'AS13335', type: 'Hosting', geoAge: '3h', latency: '', latencyAge: '',
        customName: '', marker: 'F', proto: 'VLESS', chain: true, egressIp: '203.0.113.10', security: 'TLS', transport: 'WS', sni: 'example.com', host: 'example.com', family: 'Domain', domain: 'example.com', core: 'xray', kind: 'Chain', identity: 'chain|xray|vless|example.com|443|example.com'
    },
    {
        label: 'Warp endpoint', index: 4, address: '162.159.192.1', port: 2408, flag: '🇺🇸', country: 'United States', countryCode: 'US',
        city: 'Seattle', region: 'Washington', isp: 'Cloudflare', asn: 'AS13335', type: 'Hosting', geoAge: '5h', latency: '77', latencyAge: '1h',
        customName: '', marker: 'Warp', proto: 'Warp', chain: false, egressIp: '162.159.192.1', security: 'None', transport: 'WireGuard', sni: '', host: '', family: 'IPv4', domain: '162.159.192.1', core: 'wireguard', kind: 'Warp', identity: 'warp|wireguard|162.159.192.1|2408'
    }
];

let namePreviewRequest = 0;
let namePreviewTimer;

function renderNamePreviewResult(result) {
    const preview = document.getElementById('nameTemplatePreview');
    const collisions = document.getElementById('nameTemplateCollisions');
    const diagnostics = document.getElementById('nameTemplateDiagnostics');
    const input = document.getElementById('nameTemplate');
    if (!preview || !collisions || !diagnostics) return;

    const hasDiagnostics = Boolean(result.diagnostics?.length);
    input?.classList.toggle('name-template-invalid', hasDiagnostics);
    input?.setAttribute('aria-invalid', hasDiagnostics ? 'true' : 'false');
    if (hasDiagnostics) {
        input?.setAttribute('title', result.diagnostics.map(item => item.message).join(' '));
    } else {
        input?.removeAttribute('title');
    }

    diagnostics.replaceChildren(...(result.diagnostics || []).map(item => {
        const line = document.createElement('div');
        line.textContent = `${item.message} (characters ${item.start + 1}-${Math.max(item.start + 1, item.end)})`;
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
    intro.textContent = 'Raw duplicate names are shown below; final names use the same stable identity suffix logic as subscriptions.';
    const list = document.createElement('ul');
    result.collisions.forEach(({ name, labels }) => {
        const item = document.createElement('li');
        item.textContent = `${name}: ${labels.join(' + ')}`;
        list.appendChild(item);
    });
    collisions.replaceChildren(intro, list);
}

function renderLocalNamePreviewFallback(template, mode, maxLength) {
    const rawNames = templatePreviewContexts.map(context => renderPreviewTemplate(template, context));
    if (rawNames.some(name => name === null)) {
        renderNamePreviewResult({ diagnostics: [{ message: 'Invalid template syntax.', start: 0, end: template.length }], rows: [], collisions: [] });
        return;
    }
    const registry = new Set([
        '✅ Selector', 'direct', 'dns-remote', 'dns-direct', 'dns-anti-sanction', 'dns-fake', 'hosts', 'tun-in', 'mixed-in',
        '💦 Best Ping 🚀', '💦 🔗 Best Ping 🚀', '💦 Best Ping D 🚀', '💦 🔗 Best Ping D 🚀',
        '💦 Warp - Best Ping 🚀', '💦 WoW - Best Ping 🚀',
        '💦 Warp Pro - Best Ping 🚀', '💦 WoW Pro - Best Ping 🚀'
    ]);
    const rows = templatePreviewContexts.map((context, index) => ({
        label: context.label,
        rawName: formatPreviewName(rawNames[index], mode, maxLength),
        finalName: previewUniqueName(rawNames[index], template, context, mode, maxLength, registry)
    }));
    renderNamePreviewResult({ diagnostics: [], rows, collisions: [] });
}

function updateNameTemplatePreview() {
    const input = document.getElementById('nameTemplate');
    if (!input) return;
    clearTimeout(namePreviewTimer);
    // Invalidate an already-running request immediately. Otherwise a request
    // for an older template can finish after the user clears the field and
    // repaint a preview that no longer matches the form.
    const requestId = ++namePreviewRequest;
    namePreviewTimer = setTimeout(async () => {
        const template = input.value.trim();
        const mode = document.getElementById('nameFormat')?.value || 'readable';
        const requestedLength = Number(document.getElementById('nameMaxLength')?.value || 0);
        // Keep the local fallback aligned with backend validation: a non-zero
        // limit shorter than the fingerprint cannot preserve uniqueness.
        const maxLength = Number.isInteger(requestedLength)
            && (requestedLength === 0 || requestedLength >= 8)
            ? requestedLength
            : 0;
        if (!template) {
            renderNamePreviewResult({ diagnostics: [], rows: [], collisions: [] });
            document.getElementById('nameTemplatePreview').textContent = 'Set a template to preview generated names.';
            document.getElementById('nameTemplateCollisions').textContent = 'No collisions analyzed.';
            return;
        }

        try {
            const response = await fetch('./panel/name-preview', {
                method: 'POST',
                credentials: 'include',
                cache: 'no-store',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ template, mode, maxLength })
            });
            const payload = await response.json();
            if (requestId !== namePreviewRequest) return;
            if (!payload.success) throw new Error(payload.message || 'Preview failed');
            renderNamePreviewResult(payload.body);
        } catch {
            if (requestId === namePreviewRequest) renderLocalNamePreviewFallback(template, mode, maxLength);
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
}

initTemplateAutocomplete();
initNameTemplateTools();
getUsage();
initPanel();
fetchIPInfo();

async function initPanel(settings, tgSettings, subscriptions, clients) {
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
            checkVersion(settings.panelVersion);
        }

        renderPanel(settings, tgSettings, subscriptions, clients);
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
        const res = await fetch('https://raw.githubusercontent.com/bia-pain-bache/BPB-Worker-Panel/refs/heads/main/package.json', {
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

function renderPanel(proxySettings, tgSettings, subscriptions, clients) {
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
    inputElements.forEach(elm => elm.value = proxySettings[elm.id] || '');
    textareaElements.forEach(elm => {
        const key = elm.id;
        const element = document.getElementById(key);
        const value = proxySettings[key]?.join('\r\n');
        const rowsCount = proxySettings[key].length;
        element.style.height = 'auto';
        if (rowsCount) element.rows = rowsCount;
        element.value = value;
        elm.addEventListener('input', () => {
            elm.style.height = 'auto';
            elm.style.height = `${elm.scrollHeight}px`;
        });
    });

    renderPorts(ports.map(Number));
    renderNoises(xrayUdpNoises);
    renderSubscriptions(subscriptions);
    renderClients(clients);

    globalThis.initialFormData = new FormData(proxyForm);
    handleProxyFormChanges();
    proxyForm.addEventListener('input', handleProxyFormChanges);
    proxyForm.addEventListener('change', handleProxyFormChanges);
    handleFragmentMode();
    updateNameTemplatePreview();

    if (tgSettings) {
        const tgForm = document.getElementById('telegramForm');
        handleTgFormChanges(tgSettings);
        tgForm.addEventListener('input', () => handleTgFormChanges());

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

function copyToClipboard(url) {
    navigator.clipboard.writeText(url)
        .then(() => notify('info', 'Copied to clipboard', [url]))
        .catch(error => console.error('Failed to copy:', error));
}

function copyDoh() {
    const url = document.getElementById('doh').textContent;
    copyToClipboard(url);
}

async function dlUrl(subUrl) {
    const url = new URL(subUrl);
    window.location.href = url.protocol === 'sing-box:' ? url.searchParams.get('url') : subUrl;
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
        const data = atob(text);
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
    return JSON.parse(atob(data));
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
            }

            if (!success) {
                errors.forEach(error => {
                    notify('error', error.field, error.message);
                });
                throw new Error(`status ${status} - ${message}`);
            }

            notify(
                'success',
                'Apply settings',
                ['Please update your subscriptions.']
            );

            renderPanel(form);
        })
        .catch(error => console.error('Update settings error:', error))
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

async function updatePanel(btn) {
    const confirm = await notify('confirm', 'Update BPB Panel', [
        `BPB Panel verseion ${globalThis.latestVersion} is now available!`,
        `Please read <a href='https://github.com/bia-pain-bache/BPB-Worker-Panel/releases/latest' target='_blank' rel='noopener noreferrer'>Release notes</a> carefully before updating.`,
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
        modal.querySelector('.message-text').innerHTML = text.join('\n');

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
            href: `https://bia-pain-bache.github.io/BPB-Worker-Panel/usage/${type}/`,
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
                const wrapper = elm('div', {}, [icon, title]);
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