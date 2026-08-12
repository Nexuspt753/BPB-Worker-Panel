# :material-tag-multiple:{ .md .middle } Config Names

By default each generated config is named from its address type and port. If you prefer more descriptive names, this section lets you build a custom **name template** that is auto-filled for every config from a geo lookup (country, city, region, ISP, provider and connection type) plus any custom names you define yourself.

The template is empty by default, so names stay exactly as before (address type and port) until you fill it in. For example:

```
{MARKER}{FLAG}{COUNTRY}{CITY} - {IP} - {IPNAME}
```

You can build the template from any combination of the placeholders below.

The template box shows an autocomplete dropdown as you type: press `{` to see every placeholder, keep typing to filter the list, and use the arrow keys with Enter/Tab to insert one. The dropdown only appears while the caret is inside an open `{...}` token, so it never suggests mid-name.

Use `[[...]]` for an optional section. For example, `'{IP}[[ - {IPNAME}]]'` omits the separator and custom-name portion when `{IPNAME}` is unavailable. Optional sections cannot be nested, and malformed braces are rejected before settings are saved.

The preset menu provides Compact, Detailed, Latency ranking and Protocol-aware starting points. The live examples show representative normal, fragment, chain and Warp names; the collision preview compares the raw results before the server adds deterministic uniqueness suffixes.

!!! info
    Any placeholder with no known value renders as `--`, so the template shape stays stable even when geo data is missing. `{MARKER}` and `{CHAIN}` are the exceptions: they render empty when they do not apply.

## Available placeholders

- `{MARKER}` — the config-type prefix (`F` for fragment, `D` for custom domain, `C` for custom CDN); empty when none apply.
- `{FLAG}` — country flag emoji.
- `{COUNTRY}` — country name.
- `{COUNTRY_CODE}` — two-letter ISO country code.
- `{CITY}` — city name.
- `{REGION}` — region / province name.
- `{ISP}` — internet service provider.
- `{ASN}` — AS number.
- `{TYPE}` — connection type: `Hosting`, `Mobile` or `Residential`.
- `{GEO_AGE}` — age of the cached geo result (`2h`, `1d`, etc.).
- `{LATENCY}` — latency in ms, kept fresh by the optional auto-test below; `--` when no measured value exists.
- `{LATENCY_AGE}` — age of the cached latency result.
- `{IP}` — the config address.
- `{EGRESS_IP}` — the IP your traffic actually exits from (see below).
- `{IPNAME}` — your custom name for the address, if you set one below.
- `{PROTO}` — the config protocol.
- `{CHAIN}` — 🔗 for the chain-proxy variant of a config; empty otherwise.
- `{INDEX}` — the config index number.
- `{PORT}` — the config port number.
- `{B}` — the panel brand name.
- `{F}` — same as flag (legacy).
- `{D}` — the address/domain (legacy).
- `{C}` — the country name (legacy).
- `{SECURITY}` — `TLS` or `None` for the generated connection.
- `{TRANSPORT}` — transport such as `WS` or `WireGuard`.
- `{SNI}` / `{HOST}` — TLS SNI and host values.
- `{FAMILY}` — `IPv4`, `IPv6` or `Domain`.
- `{DOMAIN}` — the panel/custom domain used by the config.
- `{CORE}` — `xray`, `sing-box`, `clash`, `wireguard` or another generating core.
- `{KIND}` — `Normal`, `Fragment`, `Chain`, `Warp`, `Best Ping`, etc.

Placeholder names are case-insensitive, so `{flag}` and `{FLAG}` behave the same. The legacy aliases remain supported and are recorded with a template format version so future migrations can be applied safely.

!!! tip
    The `{FLAG}` emoji is derived from the two-letter country code returned by the geo lookup. Non-geo placeholders such as `{INDEX}` and `{PORT}` always resolve without needing a lookup.

!!! note
    Every config needs a unique name — clients key their proxies by it. If your template leaves out the facts that separate one config from another (port, protocol, chain variant, address), the panel appends the missing ones automatically. So a bare `{FLAG}{COUNTRY}` still produces distinct names such as `🇩🇪Germany VL 443 #1`.

## Geo data describes the egress, not the address

The geo placeholders (`{FLAG}`, `{COUNTRY}`, `{CITY}`, `{REGION}`, `{ISP}`, `{ASN}`, `{TYPE}`) describe the IP your traffic **exits** from, which is what a website you visit sees — not the address the client dials. Cloudflare edge IPs mostly geolocate to Cloudflare's own registered country, so labelling them would be misleading.

In Proxy IP mode the egress is your first configured proxy IP; otherwise it is Cloudflare's own egress, probed once and cached. `{EGRESS_IP}` prints that address. If the egress cannot be determined, the placeholders fall back to the geo of the dialled address.

## Custom names per IP

To give a specific IP a fixed name, add one entry on its own line in the **Clean IPs** box. Each line is either a bare host or `host # Name` — the part after the first `#` is the config remark shown as `{IPNAME}`. For example:

```
1.2.3.4 # My Server
1.1.1.1 # Cloudflare
1.0.0.1
```

Any config whose address matches a line uses that name in place of `{IPNAME}`. Addresses are matched as written (IPv6 brackets are stripped). A line like `1.2.3.4 #` with an empty name simply contributes the bare host with no name. When a template is enabled, supported imported URI configs are also given the same template with `KIND=Imported`; unrecognized external formats are left untouched.

## Auto-test latency

`{LATENCY}` stays fresh through an optional **auto-test** — a checkbox in the Config Names section, turned off by default. When enabled, the panel periodically re-measures the addresses your configs dial at the interval you choose (10–1440 minutes), so `{LATENCY}` reflects recent results. When disabled, `{LATENCY}` renders `--`. Note that this uses a small amount of Worker requests.

Latency is measured from the Worker's network — how quickly the Cloudflare edge serving your panel reaches that address — not your local ping. The measurement is a plain HTTP round-trip, so treat it as a relative ranking between addresses rather than an exact figure for your own connection.

The manual test on the Proxy IP page is separate: it health-checks the public proxy IPs listed there and does not feed `{LATENCY}`.

## Formatting and privacy

Choose **Readable**, **Compact** or **ASCII-safe** formatting and optionally cap names at 200 characters. The panel trims control characters, collapses whitespace and preserves the distinguishing suffix when a limit is set.

Geo privacy has three modes: **Automatic** may query the configured provider and cache results, **Cached data only** never makes a new geo request, and **Disable geo lookups** leaves geo tokens unavailable. `{GEO_AGE}` and `{LATENCY_AGE}` let you show how old cached values are; missing or disabled values are omitted inside optional sections.
