# :material-cog-outline:{ .md .middle } Common settings

This section provides shared settings between all panel, subscriptions, DNS over HTTPS and protocols.

## Local DNS

The local DNS is mainly used for routing bypass rules. By default the local DNS server is set to Google DNS.

Many DNS servers are available to use as Local DNS in shape of IP, however you can use **localhost** which uses your ISP DNS server which is fine for routing purposes.

## Anti Sanction DNS

This DNS server is used for **Sanction Rules** [explained here](./routing-rules.md). The default DNS server is [Shecan](https://shecan.ir/) (for iranian users). You should check whether it supports your desired domains before setting routing rules.

!!! info
    DNS server can be in shape of an IP (UDP DNS), TCP DNS, DOT or DoH.

## Fake DNS

You may enable Fake DNS to reduce DNS query latency, but use caution, it may be incompatible with some applications or interfere with system DNS. If you're unsure about its functionality, avoid enabling it.

## Enabling IPv6

The panel provides IPv6 VLESS/Trojan configs by default. If your ISP doesn’t support IPv6, disable it to reduce the number of configs and also optimize DNS and routing settings for VLESS, Trojan and Warp configs.

## Allow connections from LAN

If you enable this feature, others in you network (for example WiFi network) can use your proxy by knowing your device local IP. They can set a socks proxy on their device, set your local IP as address and these ports based on which client you are using:

- v2ray: 10808
- sing-box: 2080
- Clash: 7890

Please note that this can be risky to use in office or public networks.

## Log Level

Specifies the level of client logs. Normally it's "warning" which is enough to debug issues, however you may need to change it to submit issues in Github or check your proxy activity.

## Custom Domain

If you already registered a domain on your Cloudflare account, you can simply assign a subdomain to your panel from here, No further steps are required from dashboard.

Please note that the related configs will be added to the existing subscriptions with `D` flag.

## Underlying DoH

The panel provides a `DNS over HTTPS` which is using Cloudflare official DoH under the hood by default. 

You can change this by setting `underlying DoH` to another DoH servers, like for example setting Adguard to block Ads. or others to block Adult content, spams, malwares etc.

## Panel - Subscriptions Path

This is your secure path for accessing panel or getting subscriptions, if you change it, the panel automatically redirects to new URL and you need to get your subscriptions from panel again.

## Fallback Domain

BPB Panel provides camouflage feature. By default, accessing the wrong addresses or invalid requests returns 404.

You can change this behaviour by setting a desired well known domain here. Please note that some websites blocked or restricted workers, so you should set and test them.

## Config Names

By default each generated config is named from its address type and port. If you prefer more descriptive names, this section lets you build a custom **name template** that is auto-filled for every config from a geo lookup (country, city, region, ISP, provider and connection type) plus any custom names you define yourself.

The default template is:

```
{MARKER}{FLAG}{COUNTRY}{CITY} - {IP} - {IPNAME}
```

You can change the template to any combination of the placeholders below.

The template box shows an autocomplete dropdown as you type: press `{` to see every placeholder, keep typing to filter the list, and use the arrow keys with Enter/Tab to insert one. The dropdown only appears while the caret is inside an open `{...}` token, so it never suggests mid-name.

!!! info
    Any placeholder with no known value renders as `--`, so the template shape stays stable even when geo data is missing.

### Available placeholders

- `{MARKER}` — the config-type prefix (`F ` for fragment, `D ` for custom domain, `C ` for custom CDN); empty when none apply.
- `{FLAG}` — country flag emoji.
- `{COUNTRY}` — country name.
- `{CITY}` — city name.
- `{REGION}` — region / province name.
- `{ISP}` — internet service provider.
- `{ASN}` — AS number.
- `{TYPE}` — connection type: `Hosting`, `Mobile` or `Residential`.
- `{LATENCY}` — latency in ms, kept fresh by the optional auto-test below (or a manual test from the Proxy IP page); `--` when no measured value exists.
- `{IP}` — the config address.
- `{IPNAME}` — your custom name for the address, if you set one below.
- `{B}` — the panel brand name.
- `{F}` — same as flag (legacy).
- `{D}` — the address/domain (legacy).
- `{C}` — the country name (legacy).
- `{index}` — the config index number.
- `{port}` — the config port number.

!!! tip
The `{FLAG}` emoji is derived from the two-letter country code returned by the geo lookup. Non-geo placeholders such as `{index}` and `{port}` always resolve without needing a lookup.

### Custom names per IP

To give a specific IP a fixed name, add one entry on its own line in the **Clean IPs** box. Each line is either a bare host or `host # Name` — the part after the first `#` is the config remark shown as `{IPNAME}`. For example:

```
1.2.3.4 # My Server
1.1.1.1 # Cloudflare
1.0.0.1
```

Any config whose address matches a line uses that name in place of `{IPNAME}`. Addresses are matched as written (IPv6 brackets are stripped). A line like `1.2.3.4 #` with an empty name simply contributes the bare host with no name.

### Auto-test latency

`{LATENCY}` stays fresh through an optional **auto-test** — a checkbox in the Config Names section, turned off by default. When enabled, the panel periodically re-measures config IPs at the interval you choose (10–1440 minutes), so `{LATENCY}` reflects recent results. When disabled, `{LATENCY}` renders `--` unless you run a manual test from the Proxy IP page. Note that this uses a small amount of Worker requests.

Latency is measured from the Worker's network (the same edge reachability test used by the Proxy IP page), so it reflects how quickly the panel can reach that address - not your local ping.
