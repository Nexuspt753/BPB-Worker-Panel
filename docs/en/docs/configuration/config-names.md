# :material-tag-multiple:{ .md .middle } Config Names

The **Config Names** section controls the names generated for BPB configs. The template is empty by default, so existing address-and-port names remain unchanged until you enable this feature.

For example:

```text
{MARKER}{FLAG}{COUNTRY} - {IP} [[ - {IPNAME}]]
```

The panel provides autocomplete while you type. Enter `{` to open the token list, type to filter it, then use the arrow keys with Enter or Tab to insert a token.

## Template syntax

Tokens use one pair of braces, for example `{IP}` or `{COUNTRY_CODE}`. Token names are case-insensitive. A token can have a local fallback, such as `{CITY|Unknown}`. Optional sections use a non-nested double-bracket pair:

```text
{IP}[[ - {IPNAME}]][[ ({LATENCY}ms)]]
```

An optional section is omitted when every token inside it is empty or unavailable. It must contain at least one token; literal-only `[[text]]` sections are rejected because they have no condition. This keeps separators and punctuation from being left behind.

Malformed templates are rejected before saving. Examples include:

- `{{IP}COUNTRY}` — nested token
- `{IP` or `IP}` — unmatched brace
- `{}` — empty token
- `[[{IP}` — unmatched optional section
- `[[[[{IP}]]]]` — nested optional section
- `{NOT_A_TOKEN}` — unknown token
- `{CITY|}` — empty token fallback
- `[[literal only]]` — optional section without a token

The panel reports the invalid range, line/column, and reason. Adjacent valid tokens such as `{IP}{PORT}` are supported.

## Presets and live preview

The preset menu provides starting points:

- **Compact:** `{FLAG} {IP}:{PORT}`
- **Detailed:** `{MARKER}{FLAG}{COUNTRY} - {IP} [[ - {IPNAME} ]]`
- **Latency ranking:** `[[{LATENCY}ms | ]]{FLAG} {IP}`
- **Protocol-aware:** `{PROTO} {MARKER}{IP}:{PORT}`

**Live examples** show representative VLESS, Trojan, clean-IP, Fragment/Chain, and Warp results. The selected geo privacy, latency, and address-group controls are applied to these examples. **Collision preview** displays the raw duplicate names and the final names after the same backend uniqueness logic used by subscriptions. It is an example matrix, not a promise that every deployment contains those exact addresses. If the preview request is unavailable, the panel shows a neutral connection warning rather than marking the template syntax invalid.

## Available tokens

| Token | Meaning |
| --- | --- |
| `{MARKER}` | Config marker: `F` for Fragment, `D` for custom domain, or `C` for custom CDN. Empty when none applies. |
| `{FLAG}` / `{F}` | Country flag emoji. `{F}` is the legacy alias. |
| `{COUNTRY}` / `{C}` | Country name. `{C}` is the legacy alias. |
| `{COUNTRY_CODE}` | Two-letter ISO country code. |
| `{CITY}` | City. |
| `{REGION}` | Region or province. |
| `{ISP}` | Internet service provider. |
| `{ASN}` | Autonomous system number. |
| `{TYPE}` | `Hosting`, `Mobile`, or `Residential`, when supplied by geo data. |
| `{GEO_AGE}` | Age of cached geo data, such as `2h` or `1d`. |
| `{GEO_SOURCE}` | `egress`, `dial`, `cached`, or `unavailable`, describing the source of geo data. |
| `{LATENCY}` | Latest opt-in Worker-to-endpoint latency in milliseconds. |
| `{LATENCY_AGE}` | Age of the cached latency measurement. |
| `{IP}` / `{D}` | Dial address. `{D}` is the legacy alias. |
| `{IPNAME}` | Name after `#` in a Clean IP entry. |
| `{GROUP}` | Label from the Address groups field. |
| `{EGRESS_IP}` | Known address from which traffic exits; empty when it cannot be determined. `{IP}` is always the dial address. |
| `{INDEX}` | Config index. |
| `{PORT}` | Config port. |
| `{PROTO}` | Protocol, such as `VLESS`, `Trojan`, or `Warp`. |
| `{CHAIN}` | `🔗` for a chain variant, otherwise empty. |
| `{B}` | BPB brand name. |
| `{SECURITY}` | Connection security, such as `TLS` or `None`. |
| `{TRANSPORT}` | Transport, such as `WS` or `WireGuard`. |
| `{SNI}` / `{HOST}` | TLS SNI and host values. |
| `{FAMILY}` | `IPv4`, `IPv6`, or `Domain`. |
| `{DOMAIN}` | Domain used to build the config. |
| `{CORE}` | Generating core, such as `xray`, `sing-box`, `clash`, or `wireguard`. |
| `{KIND}` | Config kind, such as `Normal`, `Fragment`, `Chain`, `Best Ping`, `Warp`, or `Imported`. |

A token with no value renders as `--`. `{MARKER}`, `{CHAIN}`, and `{GROUP}` render empty when they do not apply, which makes them useful inside optional sections.

## Where names are applied

| Config/output | Naming support |
| --- | --- |
| Normal VLESS/Trojan | Xray, sing-box, and Clash names/tags |
| Fragment and Chain variants | Xray, sing-box, and Clash names/tags where supported |
| Best Ping and Smart Fragment | Xray config remarks |
| Raw subscriptions | Generated VLESS/Trojan names, chain name, and supported imported URI names |
| Warp and Warp Pro | Xray, sing-box, and Clash names/tags |
| WireGuard and Amnezia | ZIP filenames, with filesystem-safe characters |
| External configs | Supported VLESS, Trojan, VMess, Shadowsocks, SOCKS, and HTTP URI schemes; unknown formats are left unchanged |

The empty template preserves the original output names. After changing a template, update subscriptions so clients receive the new names.

## Stable uniqueness and collisions

Client cores use names as identifiers: Clash uses proxy names, sing-box uses outbound tags, Xray uses remarks, and WireGuard uses filenames. The panel therefore keeps generated names unique.

A valid template is followed exactly: omitted identity dimensions are not automatically appended to the result. For example, `{COUNTRY}` produces `Germany`, not `Germany VLESS 443 ~a1b2c3d4`.

Client cores still require unique identifiers. If the rendered result collides with another generated name or a reserved selector/DNS/inbound/URL-test identifier, only the colliding result receives a deterministic identity suffix such as `~a1b2c3d4-2`. The fingerprint is derived from canonical config identity rather than list order; hosts, domains, ports, IPv6 brackets, and trailing root dots are normalized before hashing. Reordering addresses does not rename a non-colliding config.

Maximum length is applied to the template result. When a real collision needs a suffix, the implementation preserves the configured maximum length while making the best possible deterministic disambiguation.

## Address groups

Address groups let one label apply to several addresses. They are separate from the per-address `IPNAME` comment in **Clean IPs**.

Use either a header followed by addresses:

```text
Cloudflare Fast:
1.1.1.1
1.0.0.1
[2606:4700::1111]

Backup: 8.8.8.8, example.com
```

Then use `{GROUP}` in a template:

```text
{GROUP} - {IP}
```

IPv6 brackets are normalized for matching, and an optional port is ignored when matching a host. Bare IPv6 literals and `[IPv6]:port` entries are both accepted. Address groups match individual hosts only; IPv4/IPv6 CIDR ranges are rejected because subnet matching is not supported. Invalid hosts, empty groups, and malformed entries are reported by backend validation. Later definitions replace an earlier label for the same address.

## Geo and egress behavior

`{IP}` and `{D}` describe the address the client dials. Geo tokens prefer the address traffic exits from, not necessarily the Cloudflare address the client dials. In Proxy IP mode the first configured Proxy IP is used as the egress candidate. Otherwise the Worker probes and caches its public egress address. If that cannot be determined, geo may fall back to dial-address data and `{GEO_SOURCE}` reports `dial`; `{EGRESS_IP}` remains empty instead of pretending the dial address is the egress.

A template containing only `{IP}`, `{PORT}`, `{INDEX}`, `{PROTO}`, or other non-geo tokens does not trigger geo-provider requests. Geo lookups use a five-second timeout, an in-isolate memo, a KV cache, stale data when available, and a provider request budget so one failing or rate-limited provider cannot break a subscription.

### Frozen names

Enable **Freeze geo-derived names** when a country, city, provider, or known egress-address change must not rename an existing config. This applies to geo tokens and `{EGRESS_IP}`. Frozen names are stored by stable config identity and reused on later subscription requests. The feature also uses cached geo/egress data only while generating a new snapshot.

Use **Regenerate frozen names** to clear snapshots and let the next subscription fetch create them again. The button is intentionally explicit because it can change names in clients.

## Latency ranking

Enable **Auto-test endpoint latency** to populate `{LATENCY}` and `{LATENCY_AGE}`. The interval is 10–1440 minutes. Measurements are made from the Worker, not from the user's device, and are intended for relative ranking.

The sweep is bounded to a small concurrency, deduplicates address-and-port endpoints, includes configured upstream targets, probes the same port the config uses, times out probes, and stores only healthy Cloudflare-edge responses. It runs after a subscription response and never makes a failed probe or KV write fail the subscription. When auto-testing is disabled, cached latency is not rendered as a current `{LATENCY}` value.

The Proxy IP page's manual health test is separate and does not populate this token.

## Formatting and privacy

- **Readable** collapses repeated whitespace and preserves Unicode.
- **Compact** removes unnecessary spacing around `|` and `·` and tightens separator spacing.
- **ASCII-safe** removes accents and non-ASCII symbols for clients with strict name handling.
- **Maximum name length** accepts `0` for unlimited or a whole number from 8 to 200. The template itself is limited to 200 characters. Limits below 8 cannot preserve the uniqueness fingerprint and are rejected. Truncation is Unicode/grapheme-safe.

Geo privacy has three modes:

- **Automatic lookup with cache** may query the geo provider when a geo token is used.
- **Cached data only** never makes a fresh geo request.
- **Disable geo lookups** does not query geo providers; geo tokens remain unavailable and are best placed in optional sections.

`{GEO_AGE}` and `{LATENCY_AGE}` expose cache age so a template can make data freshness visible.

## Migration and fallback behavior

The saved `nameTemplateVersion` is migrated when older settings are loaded. Current migrations normalize Unicode and canonicalize older token spelling without rewriting surrounding user text. Per-token fallbacks use `{TOKEN|value}`. Invalid imported settings are rejected by the same parser used by the panel.

If a template is empty, malformed, or renders no meaningful value for a config, BPB falls back to that config type's classic name instead of emitting an empty client entry. When multiple logical configs share that fallback, a stable identity suffix may be added to keep client identifiers unique. Unknown external config formats are never rewritten.
