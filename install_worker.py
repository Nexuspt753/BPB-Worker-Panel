#!/usr/bin/env python3
"""Install BPB-Worker-Panel on a Cloudflare Worker.

Standard-library only (no pip dependencies). The flow:

  1. Prints a two-click Cloudflare link with the required permissions
     pre-filled; you just open it, press "Create Token", and paste the key.
  2. Detects your account, creates a KV namespace if needed.
  3. Generates/collects panel settings, injects EMBEDED_SETTINGS into a fresh
     dist/worker.js bundle, and uploads it as a Worker module.
  4. Enables the workers.dev route, seeds the panel password, and probes the
     health endpoint.

Secrets hygiene: credentials are only ever read from hidden prompts or
environment variables, are masked in all output, and are never written to
disk. Resource names stay plain ("bpb-panel", "bpb-kv") by design.

Usage:
    python install_worker.py                 # interactive install
    python install_worker.py --build         # run `npm run build` first
    python install_worker.py --reveal        # print the full panel URL
    python install_worker.py --auth global   # Global API Key instead of token
"""

import argparse
import datetime
import getpass
import json
import os
import secrets
import shutil
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
import webbrowser

API_BASE = "https://api.cloudflare.com/client/v4"
DASH_TOKEN_URL = "https://dash.cloudflare.com/profile/api-tokens"
DEFAULT_SCRIPT_NAME = "bpb-panel"
KV_TITLE = "bpb-kv"
KV_BINDING_NAME = "kv"

# Permissions pre-filled in the two-click token-creation link. Encoded per
# https://developers.cloudflare.com/fundamentals/api/how-to/account-owned-token-template/
REQUIRED_PERMISSIONS = [
    {"key": "workers_scripts", "type": "edit"},
    {"key": "workers_kv_storage", "type": "edit"},
]


def build_template_url():
    """Two-click API-token URL: open -> Create Token. Fields are pre-filled."""
    query = urllib.parse.urlencode({
        "permissionGroupKeys": json.dumps(REQUIRED_PERMISSIONS, separators=(",", ":")),
        "accountId": "*",
        "zoneId": "all",
        "name": "BPB Panel",
    }, quote_via=urllib.parse.quote)
    return f"{DASH_TOKEN_URL}?{query}"


def mask(value):
    if not value:
        return "(not set)"
    if len(value) <= 8:
        return "****"
    return f"{value[:2]}...{value[-4:]}"


class ApiError(RuntimeError):
    pass


class ApiClient:
    """Minimal Cloudflare API client (Bearer token or Global Key auth)."""

    def __init__(self, auth_mode, token=None, email=None, key=None, proxy=None):
        self.auth_mode = auth_mode
        self.token = token
        self.email = email
        self.key = key
        handlers = []
        if proxy:
            handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
        self.opener = urllib.request.build_opener(*handlers)

    def _headers(self, content_type=None):
        headers = {"User-Agent": "bpb-installer/1.0"}
        if self.auth_mode == "token":
            headers["Authorization"] = f"Bearer {self.token}"
        else:
            headers["X-Auth-Email"] = self.email
            headers["X-Auth-Key"] = self.key
        if content_type:
            headers["Content-Type"] = content_type
        return headers

    def request(self, method, path, json_body=None, raw_body=None, content_type="application/json"):
        url = path if path.startswith("http") else f"{API_BASE}{path}"
        body = None
        if json_body is not None:
            body = json.dumps(json_body).encode("utf-8")
        elif raw_body is not None:
            body = raw_body
        req = urllib.request.Request(url, data=body, method=method, headers=self._headers(content_type))
        try:
            with self.opener.open(req, timeout=60) as res:
                payload = res.read().decode("utf-8")
        except urllib.error.HTTPError as err:
            detail = err.read().decode("utf-8", "replace")
            raise ApiError(f"HTTP {err.code} on {method} {path}: {detail[:500]}") from err
        except urllib.error.URLError as err:
            raise ApiError(f"network error on {method} {path}: {err.reason} "
                           "(is a proxy needed? try --proxy http://127.0.0.1:10808)") from err
        try:
            data = json.loads(payload)
        except json.JSONDecodeError as err:
            raise ApiError(f"non-JSON response from {method} {path}") from err
        if not data.get("success"):
            messages = "; ".join(
                f"{e.get('code', '?')}: {e.get('message', 'unknown error')}" for e in data.get("errors", [])
            )
            raise ApiError(f"{method} {path} failed: {messages or payload[:300]}")
        return data.get("result")

    def upload_worker(self, account_id, script_name, code, kv_namespace_id):
        """Multipart PUT of the worker module + metadata bindings."""
        boundary = f"----bpb{secrets.token_hex(16)}"
        metadata = {
            "main_module": "worker.js",
            "bindings": [{"type": "kv_namespace", "name": KV_BINDING_NAME, "namespace_id": kv_namespace_id}],
            "compatibility_date": datetime.date.today().isoformat(),
            "compatibility_flags": ["nodejs_compat"],
        }
        parts = []

        def part(name, filename, content_type, content):
            parts.append(
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
                f"Content-Type: {content_type}\r\n\r\n".encode("utf-8")
                + (content.encode("utf-8") if isinstance(content, str) else content)
                + b"\r\n"
            )

        part("metadata", "metadata.json", "application/json", json.dumps(metadata))
        part("worker.js", "worker.js", "application/javascript+module", code)
        body = b"".join(parts) + f"--{boundary}--\r\n".encode("utf-8")

        url = f"{API_BASE}/accounts/{account_id}/workers/scripts/{script_name}"
        req = urllib.request.Request(url, data=body, method="PUT",
                                     headers=self._headers(f"multipart/form-data; boundary={boundary}"))
        try:
            with self.opener.open(req, timeout=120) as res:
                data = json.loads(res.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            detail = err.read().decode("utf-8", "replace")
            raise ApiError(f"upload failed: HTTP {err.code}: {detail[:500]}") from err
        if not data.get("success"):
            messages = "; ".join(e.get("message", "?") for e in data.get("errors", []))
            raise ApiError(f"upload failed: {messages}")
        return True


def prompt_hidden(label, env_name=None):
    value = os.environ.get(env_name, "") if env_name else ""
    if value:
        print(f"{label}: (read from {env_name}, {mask(value)})")
        return value
    return getpass.getpass(f"{label}: ").strip()


def prompt_default(label, default="", env_name=None):
    env_value = os.environ.get(env_name) if env_name else None
    if env_value is not None and env_value != "":
        print(f"{label}: {env_value} (from {env_name})")
        return env_value
    shown = default if default != "" else ""
    suffix = f" [{shown}]" if default else ""
    answer = input(f"{label}{suffix}: ").strip()
    return answer or default


def collect_credentials(args):
    auth_mode = args.auth
    token = key = email = None
    if auth_mode == "token":
        token = os.environ.get("CF_API_TOKEN") or ""
        if token:
            print(f"Using CF_API_TOKEN from environment ({mask(token)}).")
        else:
            token = prompt_hidden("Paste your Cloudflare API token", "CF_API_TOKEN")
        if not token:
            sys.exit("No API token provided.")
    else:
        email = os.environ.get("CF_API_EMAIL") or input("Cloudflare account email: ").strip()
        key = os.environ.get("CF_API_KEY") or prompt_hidden("Global API Key", "CF_API_KEY")
        if not email or not key:
            sys.exit("Both the account email and the Global API Key are required.")
    return auth_mode, token, email, key


def pick_account(client):
    accounts = client.request("GET", "/accounts") or []
    if not accounts:
        sys.exit("The provided credentials can see no Cloudflare account.")
    if len(accounts) == 1:
        account = accounts[0]
        print(f"Account detected: {account['name']} ({account['id']})")
        return account["id"]
    override = os.environ.get("CF_ACCOUNT_ID")
    if override in {a["id"] for a in accounts}:
        print(f"Using CF_ACCOUNT_ID ({override}).")
        return override
    print("Multiple accounts found:")
    for index, account in enumerate(accounts, start=1):
        print(f"  {index}. {account['name']} ({account['id']})")
    choice = int(prompt_default("Select account number", "1")) - 1
    return accounts[choice]["id"]


def detect_login_email(client):
    try:
        user = client.request("GET", "/user") or {}
        return user.get("email") or ""
    except ApiError:
        return ""


def ensure_kv_namespace(client, account_id):
    namespaces = client.request("GET", f"/accounts/{account_id}/storage/kv/namespaces") or []
    for namespace in namespaces:
        if namespace.get("title") == KV_TITLE:
            print(f"Reusing KV namespace '{KV_TITLE}' ({namespace['id']}).")
            return namespace["id"]
    created = client.request(
        "POST",
        f"/accounts/{account_id}/storage/kv/namespaces",
        json_body={"title": KV_TITLE},
    )
    print(f"Created KV namespace '{KV_TITLE}' ({created['id']}).")
    return created["id"]


def ensure_workers_dev_subdomain(client, account_id):
    try:
        result = client.request("GET", f"/accounts/{account_id}/workers/subdomain")
        if result and result.get("subdomain"):
            return result["subdomain"]
    except ApiError:
        pass
    desired = prompt_default(
        "No workers.dev subdomain yet; choose one (letters/digits/hyphens)", "", "BPB_SUBDOMAIN"
    )
    if not desired:
        return ""
    result = client.request(
        "PUT", f"/accounts/{account_id}/workers/subdomain", json_body={"subdomain": desired}
    )
    return (result or {}).get("subdomain", desired)


def enable_on_workers_dev(client, account_id, script_name):
    client.request(
        "POST",
        f"/accounts/{account_id}/workers/scripts/{script_name}/subdomain",
        json_body={"enabled": True},
    )


def seed_panel_password(client, account_id, namespace_id, password):
    client.request(
        "PUT",
        f"/accounts/{account_id}/storage/kv/namespaces/{namespace_id}/values/pwd",
        raw_body=password.encode("utf-8"),
        content_type="text/plain",
    )


def load_bundle(run_build):
    if run_build:
        npm = shutil.which("npm")
        if not npm:
            sys.exit("npm not found; build the bundle yourself with `npm run build`.")
        print("Running `npm run build`...")
        subprocess.run([npm, "run", "build"], check=True)
    bundle_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "dist", "worker.js")
    if not os.path.isfile(bundle_path):
        sys.exit(f"{bundle_path} not found. Run `npm run build` first or pass --build.")
    with open(bundle_path, "r", encoding="utf-8") as handle:
        code = handle.read()
    # A stale deployed copy pasted into dist/ would double-inject settings.
    if "EMBEDED_SETTINGS" in code:
        sys.exit("dist/worker.js already contains EMBEDED_SETTINGS. Rebuild: `npm run build`.")
    return code


def probe_panel(host, secure_path, proxy):
    url = f"https://{host}/{secure_path}/panel"
    handlers = [NoRedirect()]
    if proxy:
        handlers.append(urllib.request.ProxyHandler({"http": proxy, "https": proxy}))
    opener = urllib.request.build_opener(*handlers)
    request = urllib.request.Request(url, method="GET", headers={"User-Agent": "bpb-installer/1.0"})
    try:
        with opener.open(request, timeout=30) as response:
            return response.status
    except urllib.error.HTTPError as err:
        return err.code


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        return None  # surface redirects as HTTPError so we can assert on them


def main():
    parser = argparse.ArgumentParser(description="Install BPB-Worker-Panel on a Cloudflare Worker.")
    parser.add_argument("--auth", choices=["token", "global"], default="token",
                        help="'token' (default) uses an API token created via the two-click link; "
                             "'global' uses the Global API Key with your account email.")
    parser.add_argument("--build", action="store_true", help="run `npm run build` before uploading")
    parser.add_argument("--script-name", default=os.environ.get("BPB_SCRIPT_NAME", DEFAULT_SCRIPT_NAME),
                        help=f"Worker name (default: {DEFAULT_SCRIPT_NAME})")
    parser.add_argument("--proxy", default=os.environ.get("BPB_PROXY"),
                        help="HTTP(S) proxy for outbound calls, e.g. http://127.0.0.1:10808")
    parser.add_argument("--reveal", action="store_true",
                        help="print the full panel URL including the secret path at the end")
    parser.add_argument("--skip-probe", action="store_true", help="skip the final health check")
    args = parser.parse_args()

    print("=" * 62)
    print("BPB-Worker-Panel installer for Cloudflare Workers")
    print("=" * 62)

    if args.auth == "token":
        url = build_template_url()
        print("\nStep 1 - create an API token with the exact permissions needed:")
        print(f"  {url}")
        print("Step 2 - on the opened page everything is pre-filled;")
        print("         press 'Continue to summary' then 'Create Token' and copy it.\n")
        try:
            webbrowser.open(url)
        except Exception:
            pass

    auth_mode, token, email, key = collect_credentials(args)
    client = ApiClient(auth_mode, token=token, email=email, key=key, proxy=args.proxy)

    print("\nVerifying credentials...")
    if auth_mode == "token":
        verify = client.request("GET", "/user/tokens/verify")
        print(f"Token active: {verify.get('status', 'unknown')}")
    else:
        print(f"Authenticated as {client.request('GET', '/user').get('email')}")

    account_id = pick_account(client)

    login_email = prompt_default(
        "Panel login email", email or detect_login_email(client), "BPB_LOGIN_EMAIL"
    )
    if not login_email:
        sys.exit("A panel login email is required.")

    script_name = prompt_default("Worker name", args.script_name, "BPB_SCRIPT_NAME")

    print("\nGenerating panel settings (leave blank to accept).")
    panel_password = os.environ.get("BPB_PANEL_PASSWORD") or prompt_hidden(
        "New panel password (blank = set it on first login instead)"
    )
    vl_uuid = prompt_default("VLESS UUID", str(uuid.uuid4()), "BPB_VL_UUID")
    tr_pass = prompt_default("Trojan password", secrets.token_urlsafe(15), "BPB_TR_PASS")
    secure_path = prompt_default(
        "Secret panel path", secrets.token_urlsafe(9).replace("-", "x").replace("_", "y"), "BPB_SECURE_PATH"
    )

    subdomain = ensure_workers_dev_subdomain(client, account_id)
    host = f"{script_name}.{subdomain}.workers.dev" if subdomain else ""
    main_domain = prompt_default(
        "Main domain", host or "(required, e.g. panel.example.com)", "BPB_MAIN_DOMAIN"
    )
    if not main_domain:
        sys.exit("A main domain is required.")

    embedded = {
        "accID": account_id,
        "accEmail": login_email,
        "apiToken": token or "",
        "vlUUID": vl_uuid,
        "trPass": tr_pass,
        "securePath": secure_path,
        "proxyIpMode": "off",
        "proxyIPs": ["bpb.yousef.isegaro.com"],
        "prefixes": [],
        "fallback": "",
        "dohUrl": "https://cloudflare-dns.com/dns-query",
        "mainDomain": main_domain,
    }

    print("\nPreparing KV namespace...")
    namespace_id = ensure_kv_namespace(client, account_id)

    code = load_bundle(args.build)
    script = f"const EMBEDED_SETTINGS = {json.dumps(embedded)};\n" + code

    print(f"Uploading worker '{script_name}' ({len(script)} bytes, secrets masked)...")
    client.upload_worker(account_id, script_name, script, namespace_id)
    print("Upload succeeded.")

    if subdomain:
        enable_on_workers_dev(client, account_id, script_name)
        print(f"Enabled https://{host}")

    if panel_password:
        seed_panel_password(client, account_id, namespace_id, panel_password)
        print("Panel password seeded into KV.")
    else:
        print("No password seeded: use the panel's first-login password reset.")

    print("\nSummary")
    print(f"  Account       : {mask(account_id)}")
    print(f"  Worker        : {script_name}")
    print(f"  KV binding    : {KV_BINDING_NAME} -> '{KV_TITLE}' ({mask(namespace_id)})")
    print(f"  Login email   : {login_email}")
    print(f"  API token     : {mask(token or '')}")
    print(f"  VLESS UUID    : {mask(vl_uuid)}")
    print(f"  Trojan pass   : {mask(tr_pass)}")
    print(f"  Secret path   : {mask(secure_path)}")
    full_url = f"https://{main_domain}/{secure_path}/panel"
    if args.reveal:
        print(f"  Panel URL     : {full_url}  (keep private)")
    else:
        print(f"  Panel URL     : https://{main_domain}/<secret-path>/panel  (--reveal to show)")

    if host and not args.skip_probe:
        print("\nProbing health endpoint (302 expected; bare paths returning 404 is normal)...")
        status = probe_panel(host, secure_path, args.proxy)
        print(f"  GET /{mask(secure_path)}/panel -> HTTP {status}")
        if status == 302:
            print("Install complete: the panel is up and redirecting to login.")
        else:
            print("Warning: unexpected status. Check the deployment in the dashboard logs.")
    else:
        print("\nInstall finished.")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit("\nCancelled.")
    except ApiError as error:
        sys.exit(f"\nERROR: {error}")
