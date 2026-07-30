# Network Security - Protocol, Auth, Proxy and Functionality

This doc serves as a repo of knowledge regarding network security, particularly HTTP/HTTPS, and browser adaptations and policies on these protocols, to address this project's overall authentication, proxying and there-on functionalities.

Status: updated after v0.1.6b implementation (WS TCP tunnel, cookie transport-detection fix).

Primary objective of this document:
- Preserve decisions already validated in production-like scenarios
- Prevent regressions to previously rejected approaches
- Reduce duplicate investigation on known HTTP/HTTPS + cookie + proxy edge cases


## Architect of this Project
1.  A lightweight wrapper, running typically from container/docker.
2.  HTTP API and static serving, no TLS termination by itself:
    - Simplicity 
    - Complexity is mainly maintenance of a valid TLS certificate (self-signed certificate is constrained and possible rejection by browser)
    - Typical use scenario in container/docker provides edge termination
    - In a TLS must scenario, adding a Caddy in front of this is simple
3.  HTTP/HTTPS/WS Proxying:
    - this is the base to be a "wrapper" that main app traffic is routed
    - proxying for other sidecar instances is a bonus, and a solution for edge cases of one SPA management of multi instances
4.  Its core functionalities (file management, shell terminal connection) are accessible via programmatic API calls.
5.  A frontend SPA designed and shipped together as a self-contained project.
6.  Multi instances centralized management is a feature that encourages adaptation of this project and brings ease of adaptation and implementation.


## Knowledge Base
Knowledge base is know-hows, verified facts, network standards, independent of the design of this project, user-friendly 101, re-usable to similar projects, **and** accumulates over time.

## Validated Scenario (Reference Case)

The key edge case that drove these decisions:

1. Sidecar A served over HTTP (e.g., `http://host:3000`) with proxy route `/car -> https://sidecar-b`
2. Sidecar B served over HTTPS (upstream)
3. User enters `http://host:3000/car`
4. Login appears successful, but subsequent API calls fail (401) and browser reports secure-cookie rejection

Observed symptoms:
- Browser warning: secure cookie rejected on non-HTTPS page
- API calls accidentally targeting `/admin/api/...` instead of `/car/admin/api/...` (frontend base-path issue)
- Cookie path scope mismatch (`Path=/admin/api` not matching `/car/admin/api/...`)

This document records the backend/security part of the fix. Frontend base-path handling is documented separately in frontend docs.

## Validated Scenario 2 — Cross-Site Auth Failure (HTTP-Origin SPA → HTTPS Remote Machine)

Real-world case observed in production (Feb 2026):

1. GCP sidecar running at `http://34.1.134.203:3000` (HTTP), user opens GCP SPA.
2. Railway sidecar running at `https://sidecar-production.up.railway.app` (HTTPS) configured as a remote machine.
3. User logs in to Railway from the GCP SPA. Login `POST` is cross-origin:
   - `Origin: http://34.1.134.203:3000` (HTTP)
   - Railway applies v0.1.5 rule → HTTP Origin → sets `SameSite=Lax` cookie (no `Secure`).
4. User switches active machine to Railway. Behaviour observed:

   a. **Thumbnail 401 at moment of switch** — file-browser still renders old GCP items briefly; their `<img src>` elements point to `https://railway.app/admin/api/fs/thumbnail?path=<gcp-path>`. Request is cross-site subresource (`Sec-Fetch-Site: cross-site`, `Sec-Fetch-Mode: no-cors`). `SameSite=Lax` cookie is NOT sent on cross-site subresourse loads → 401.

   b. **WebSocket 401 on Terminal** — `wss://railway.app/admin/api/ws/terminal` upgrade is cross-site. `SameSite=Lax` cookie is not sent on cross-site WebSocket upgrades → 401.

   c. **Thumbnail 401 after content loads** — Railway content fully loaded, user browses Railway folders. Thumbnail `<img>` requests to `https://railway.app/admin/api/fs/thumbnail?path=<railway-path>` are still cross-site (page origin is still `http://34.1.134.203:3000`). Same `SameSite=Lax` cookie → NOT sent → 401.

**Root cause**: The v0.1.5 Origin-scheme rule (`http://` Origin → `SameSite=Lax`) is correct for the same-origin proxy scenario but produces a wrong result for cross-origin remote machine access from an HTTP-origin SPA. `SameSite=Lax` only covers same-site requests and cross-site top-level navigations; it does NOT cover cross-site subresource loads (`<img>`, `fetch`) or WebSocket upgrades, which are exactly the access patterns used for thumbnails and terminal.

**Secondary issue — machine-switch race condition**: At the instant of switching, old DOM thumbnail `<img>` elements from the previous machine can fire requests to the new machine's base URL while still carrying old-machine file paths. Even with correct cookies these would be path-mismatch requests. This is a frontend cleanup / render-ordering concern separate from the cookie policy.

**SameSite=Lax sending rules (browser standard)**:
- Sent: same-site requests at any level; cross-site **top-level navigations** via safe methods (GET/HEAD).
- NOT sent: cross-site subresource loads (`<img>`, `<script>`, `<iframe>`), cross-site `fetch()` / XHR, cross-site WebSocket upgrades.

**Implication**: For cross-site cookie use (thumbnails as `<img src>`, WebSocket upgrades from a different origin), the cookie must be `SameSite=None; Secure`. This requires:
1. The cookie-setting endpoint is HTTPS (so `Secure` is valid and accepted by the browser).
2. The backend sets `SameSite=None; Secure` based on its own transport security, not the requesting Origin's scheme.

The v0.1.5 Origin-scheme rule must be revisited for remote machines: a remote HTTPS machine should set `SameSite=None; Secure` regardless of the `Origin` header of the login request, because the cookie will be transmitted over HTTPS and must survive in a cross-site embedding context.

**Resolution (v0.1.6)**: Fixed by switching the cookie rule from `Origin`-scheme detection to server-side transport detection via `X-Forwarded-Proto` / `X-Forwarded-Ssl` headers (see Implemented Rule section). Railway's edge sets `X-Forwarded-Proto: https` → Railway sidecar now issues `SameSite=None; Secure` regardless of the requesting Origin — the cookie is stored and sent on cross-site `<img>` (thumbnails) and cross-site WebSocket (terminal) requests. Scenario 2 is **resolved**.


### JWT Auth 

- Primary auth token format remains JWT (HS256)
- Resolution order in backend:
    1) `Authorization: Bearer <jwt>`
    2) `Cookie: token=<jwt>`
    3) otherwise `401 Unauthorized`
- JWT and cookie auth are intentionally hybrid:
    - API clients can use bearer token directly
    - Browsers can rely on HttpOnly cookie auto-send

#### Client-Side Token Storage

- Frontend stores the JWT (returned by login response body) in `localStorage`, machine-scoped to avoid cross-machine token bleed.
- Storage key pattern: `auth_token_<machine_key>` + `auth_token_expiry_<machine_key>` (24 h TTL).
- The `Self` machine and any machine with a missing name normalize the key suffix to `default`.
- Machine identity is name-based (not array-index-based), so token lookup is stable across config array reorders.
- The bearer token in `Authorization` header is sourced from this localStorage entry for programmatic / non-browser clients; the browser additionally sends the `HttpOnly` cookie automatically.

### WebSocket Auth

WebSocket upgrade requests authenticate via `Sec-WebSocket-Protocol` subprotocol header (primary) with cookie fallback.

**Auth resolution order for WebSocket upgrades** (v0.1.6c):
1. `Authorization: Bearer <jwt>` header (non-browser clients only — browser `WebSocket()` cannot set custom headers)
2. `Sec-WebSocket-Protocol: auth-token.<jwt>` header (browser WebSocket — always sent by constructor)
3. `Cookie: token=<jwt>` (fallback — may be suppressed by iOS Safari ITP)
4. 401 Unauthorized

**Why `Sec-WebSocket-Protocol`:**
- iOS Safari's Intelligent Tracking Prevention (ITP) can intermittently suppress `HttpOnly` cookies on WebSocket upgrade handshakes, particularly for cross-site connections or after cookie-partitioning rules activate. This causes sporadic terminal 401 failures on iOS devices while desktop browsers work reliably.
- The browser's `WebSocket()` constructor does not support custom headers (no `Authorization`), but DOES accept a subprotocol list as its second argument: `new WebSocket(url, ['auth-token.<jwt>'])`. The browser includes the value as a standard `Sec-WebSocket-Protocol` header in the upgrade request.
- The token is transmitted as an HTTP header, NOT in the URL — it does not appear in server access logs, browser history, or Referer headers. This preserves the security properties that motivated the v0.1.4a removal of `?token=` query param auth.
- RFC 6455 §4.2.2 requires the server to echo the selected subprotocol in the 101 response. The `ws_terminal()` handler calls `ws.protocols([subprotocol])` to do this.
- Used by Kubernetes API server, Grafana Live, Hasura, and other production systems.

**No conflict with proxied upstream subprotocols:**
The subprotocol auth applies only to sidecar's own `/admin/api/ws/terminal` endpoint (handled by `auth_middleware` → `ws_terminal()`). Proxied upstream WebSocket connections go through `handle_ws_tunnel()` — a raw TCP tunnel that forwards all headers including real `Sec-WebSocket-Protocol` values (e.g., `grpc-websockets`, `graphql-ws`) without inspection or modification. The two code paths are completely separate.

Implemented rule:
- WS URL pattern: `${wsProtocol}//${host}${BASE_PATH}/admin/api/ws/terminal?cols=…&rows=…`
- Frontend passes JWT as: `new WebSocket(url, ['auth-token.' + token])`
- `BASE_PATH` prefix is applied for Self-machine WS connections when behind a reverse proxy (see Proxy section).
- Remote machine WS connections target the machine's own origin directly with no extra prefix.

Client-side guard:
- Before initiating a WebSocket, the frontend checks that a local JWT exists for the active machine.
- If no JWT is found the terminal displays an authentication error and does not attempt the upgrade — avoids dangling unauthenticated WS handshakes.

**iOS Safari ITP behavior (reference):**
- Safari on iOS applies Intelligent Tracking Prevention which can partition or suppress third-party cookies.
- WebSocket upgrade requests are HTTP requests; ITP cookie suppression applies to them.
- Same-site WebSocket cookies are generally reliable; cross-site cookies are intermittently blocked.
- The `Sec-WebSocket-Protocol` subprotocol header is immune to ITP — it is always included by the browser's `WebSocket()` constructor.



### Cookie Auth

#### credentials: 'include' Requirement

Browser `fetch()` calls to the login endpoint **must** include `credentials: 'include'` for the browser to store the `Set-Cookie` response header.

- Without this flag the browser silently drops the `Set-Cookie` header from cross-origin or even same-origin fetch responses and the `HttpOnly` cookie is never stored.
- This applies to both the Self machine (`./api/auth/login`) and remote machines (`${machine.url}/admin/api/auth/login`).
- Non-browser API clients (curl, scripts) are unaffected — they handle cookies explicitly or use `Authorization: Bearer`.

#### Direct Read URL (Cookie-Authenticated)

The `getReadURL(path, cacheSecs)` helper builds a URL for `GET /admin/api/fs/read?path=<encoded>` that is directly usable as an HTML `src` attribute (e.g., `<img src>`, `<video src>`).

- No custom request headers are needed — the browser auto-attaches the auth cookie.
- Optional `cache=<seconds>` query param controls upstream caching.
- This avoids a separate blob-fetch + object-URL lifecycle for media embedding.

### Implemented Rule (v0.1.5 → superseded by v0.1.6)

**v0.1.5 rule** (Origin-scheme): Cookie `Secure`/`SameSite` was determined by the `Origin` request header scheme. Produced wrong results for cross-origin remote machine access from an HTTP-origin SPA (see Validated Scenario 2). Superseded.

### Implemented Rule (v0.1.6)

Cookie `Secure` / `SameSite` is determined by **server-side transport** (`X-Forwarded-Proto` / `X-Forwarded-Ssl`), not the `Origin` header scheme.

Implemented in `src/auth.rs` — `is_secure_network()` + `build_set_cookie()`:

```
1. X-Forwarded-Proto: https  → Secure; SameSite=None
2. X-Forwarded-Ssl: on       → Secure; SameSite=None
3. Neither header present    → SameSite=Lax  (no Secure, plain HTTP assumed)
```

Why this is the correct rule:
- `X-Forwarded-Proto` reflects the transport between browser and the TLS-terminating edge (Railway, nginx, Caddy), not the requesting page's origin.
- A sidecar behind HTTPS termination correctly issues `SameSite=None; Secure` — the browser accepts and stores the cookie, and sends it on subsequent cross-site subresource requests (`<img>`, WebSocket) because both conditions are met: cookie is `Secure` and the request goes over HTTPS.
- A sidecar on plain HTTP (no forwarded proto header) issues `SameSite=Lax` — correct for direct HTTP access, avoids rejected `Secure` cookie on non-TLS transport.
- The `Origin` header is intentionally NOT used: an HTTP-origin page legitimately fetches from an HTTPS remote machine; the response is delivered over TLS and the cookie must be `Secure`.

### Dead End Rejected

Rejected old approach: compare `Origin` host against `Host` header to decide cross-origin.

Why it fails in proxy chains:
- Proxy forwards browser `Origin` but rewrites `Host` to upstream host
- Host mismatch is common in proxying and does not imply browser transport is HTTPS
- This incorrectly classifies proxied HTTP requests as cross-origin secure-cookie candidates
- Result: browser rejects cookie, leading to auth breakage after login

### Cookie Path Scope

Current auth cookie path from backend auth logic: `Path=/admin/api`

Important with path-prefix proxying:
- If browser route is `/car/admin/api/...`, cookie with `Path=/admin/api` does not match
- Proxy must rewrite upstream `Set-Cookie Path=` when request is under prefix routes
- v0.1.5 behavior: prepend route prefix
    - example: `Path=/admin/api` -> `Path=/car/admin/api`

This is a proxy responsibility (path-space adaptation between upstream and client-facing URL space).

#### Valid Combinations

Not all combinations of these attributes are accepted by modern browsers. The most critical rule is that SameSite=None must always be paired with Secure.

| Combination | Validity | Notes |
|-------------|----------|-------|
| SameSite=Strict; Secure | Valid | High security; recommended for sensitive sessions over HTTPS. |
| SameSite=Strict | Valid | Strictly same-site, allowed over HTTP (though HTTPS is preferred). |
| SameSite=Lax; Secure | Valid | Balanced security; modern standard for HTTPS sites. |
| SameSite=Lax | Valid | Balanced security, allowed over HTTP. |
| SameSite=None; Secure | Valid | Required for third-party/cross-site cookies. |
| SameSite=None | Invalid | Rejected by modern browsers; if None is used, Secure is mandatory. |



### Logout and Server-Side Cookie Clearing

Logout is a two-step sequence: server-side cookie invalidation, then client-side token removal.

1. Frontend calls `POST /admin/api/auth/logout` (or `./api/auth/logout` for Self) with `credentials: 'include'`.
   - Server responds with a `Set-Cookie` that clears / expires the `HttpOnly` auth cookie.
2. Client removes the JWT from `localStorage` regardless of API response (fire-and-forget).
   - Network failure or server down does not block client-side logout — the local token is always cleared.

Why both steps are needed:
- `HttpOnly` cookies cannot be deleted from JavaScript, so a server round-trip is the only way to clear them.
- Removing the localStorage token prevents future bearer-auth calls even if the cookie somehow persists (e.g., browser cookie store not updated immediately).

### URL-based Auth

- Query token auth (`?token=...`) is intentionally removed and must not be reintroduced.
- Applies to **both** HTTP API calls and WebSocket URLs.
- Reasons:
    - URL leakage via logs/history/referrer
    - weakens operational security guarantees
    - unnecessary now that hybrid bearer+cookie auth is implemented
    - WS cookie upgrade makes token-in-URL obsolete for terminal connections




### Browser Behavor

### Browser Policy Facts Used in This Project

1. `SameSite=None` without `Secure` is rejected by modern browsers.
2. `Secure` cookies are not accepted/sent on HTTP pages. (*user remark: need verification*)
3. Cookie sending is scoped by domain + path; path must prefix-match request path.
4. Proxying HTTPS upstream behind HTTP edge does not make browser context HTTPS.
5. `SameSite=Lax` cookies are NOT sent on cross-site subresource requests (`<img>`, `<script>`, `fetch()`, `XHR`) or cross-site WebSocket upgrades. They are only sent same-site or on cross-site top-level navigations (browser bar GET). This means `SameSite=Lax` cookies cannot authenticate cross-origin `<img src>` thumbnail endpoints or cross-origin WebSocket connections.
6. A `Secure` cookie set by an HTTPS endpoint can be stored by the browser even if the current page is HTTP (the `Secure` flag restricts the transmission channel of future sends, not the storage). A cookie with `SameSite=None; Secure` received from an HTTPS cross-origin login response is storable and later sendable on cross-site HTTPS requests.


## Implication and Design of this Project
Decisions made, implication and constrains by the above knowledge. This could be temporary, or dependent on the depth of know-how, undiscovered bugs, compromised decisions, or merely being not up to date. In other words, content of this section might be wrong.

### Practical Implications for Sidecar

- Sidecar can stay HTTP-only by design (no TLS termination in process), but then:
    - browser-facing pages are HTTP
    - cookie policy must be HTTP-compatible (`Lax`, no `Secure`) unless true HTTPS is used at edge
- For true cross-site cookie behavior in browsers, deploy behind HTTPS edge and use `Secure; SameSite=None`.

### Known Limitation — v0.1.5 Cookie Rule Breaks Cross-Origin Remote Machine Access from HTTP SPA

The v0.1.5 Origin-scheme rule was designed for the proxy scenario where the browser-facing origin IS the sidecar. It does not generalise correctly when an HTTP-origin SPA accesses a remote HTTPS machine:

| Scenario | Origin header | v0.1.5 sets | Works for `<img>`/WS? |
|---|---|---|---|
| HTTPS SPA → HTTPS remote | `https://...` | `Secure; SameSite=None` | ✓ |
| HTTP SPA → HTTP remote | `http://...` | `SameSite=Lax` | ✓ (same-site) |
| HTTP SPA → HTTPS remote | `http://...` | `SameSite=Lax` | **✗** (cross-site subresource) |

The third row is the broken scenario. The Railway cookie is stored but `SameSite=Lax` prevents the browser from sending it on cross-site `<img>` thumbnail requests or cross-site WebSocket upgrades, causing persistent 401 on those endpoints even after successful login.

**Correct resolution**: The cookie attribute policy for a remote machine endpoint should be based on the server's own transport (HTTPS or HTTP), not the `Origin` header scheme of the login request. An HTTPS sidecar should always set `Secure; SameSite=None` if it expects to be used cross-origin (e.g., embedded as a remote machine from a different-origin SPA).

**Workaround while rule is not yet updated**: Bear-token (`Authorization: Bearer`) auth works for `apiRequest()` fetch calls. It does not work for `<img src>` or WebSocket because custom headers cannot be set on those. For those access patterns, the cookie policy must be correct — there is no header-based workaround.

### Frontend BASE_PATH Detection (Proxy Counterpart)

The backend proxy-path fix (cookie path rewriting) has a matching frontend fix: `BASE_PATH` detection.

`BASE_PATH` is computed once at module load from `window.location.pathname` by extracting the segment before the last occurrence of `/admin`:

```
/admin/          -> BASE_PATH = ""
/car/admin/      -> BASE_PATH = "/car"
/x/y/admin/      -> BASE_PATH = "/x/y"
<no /admin>      -> BASE_PATH = ""
```

All Self-machine HTTP API calls and WebSocket URLs are prefixed with `BASE_PATH`. Remote machine calls are not prefixed — they target the machine's own full URL directly.

`BASE_PATH` is immutable for the session lifetime; a page reload is required to re-detect it. It is exported from `src/utils/config.js`.

Without this frontend fix, API calls would target `/admin/api/…` instead of `/car/admin/api/…`, causing 404s or misroutes even after the backend cookie path is correctly rewritten.

### Machine URL Format and Auth Scope

Each machine is configured with a single `url` field containing the full URL: `scheme + host + optional port + optional base path` (e.g., `http://34.1.134.203:3000`, `https://app.railway.app/icon`). There is no separate `port` field.

Security implication:
- The scheme in `url` is explicit at config time, so the frontend knows the transport security level of each machine before any request is made.
- This is the input that drives origin-scheme-based cookie policy: if a remote machine URL starts with `https://`, cookies for that machine will be set/expected as `Secure`.
- `getMachineBaseURL()` strips trailing slashes from the URL; for the Self machine it returns `BASE_PATH` (empty string when no proxy is in use).

This makes HTTP-vs-HTTPS per-machine cookie security deterministic from config rather than inferred from response headers.

### Proxy Header Handling Rules (v0.1.5)

1. Preserve multi-value response headers using append semantics.
     - especially `Set-Cookie` (multiple cookies must not be collapsed)
2. Rewrite `Location` for prefixed routes (already existing behavior)
3. Rewrite `Set-Cookie Path=` for prefixed routes (new in v0.1.5)

### WebSocket Proxy — Raw TCP Tunnel (v0.1.6b)

**Problem (v0.1.5 / v0.1.6a — superseded):** The proxy forwarded WebSocket connections via a two-leg `tokio-tungstenite` approach where the proxy performed its own WS handshake with the upstream. This was fragile:

- **v0.1.5:** `connect_async(&str)` generated fresh WS headers but carried no `Cookie` → upstream `auth_middleware` returned 401 → tunnel failed immediately.
- **v0.1.6a attempted fix:** `connect_async(http::Request)` to carry cookies. Failed because `build_forwarded_headers()` strips `Connection` and `Upgrade` as hop-by-hop headers (correct for HTTP forwarding) — but tungstenite's `generate_request()` internally calls `headers.remove("Connection").ok_or(InvalidHeader)?` → missing header → protocol error before TCP connect → client WS dropped after 101.

**Solution (v0.1.6b — implemented):** Raw TCP tunnel in `src/proxy.rs`.

1. Detect WS upgrade via `Connection: Upgrade` / `Upgrade: websocket` headers (`is_ws_upgrade()`).
2. Return `101 Switching Protocols` to the browser; compute `Sec-WebSocket-Accept` from the client's `Sec-WebSocket-Key` (`derive_accept_key` from tungstenite).
3. Extract the raw upgraded byte stream via `hyper::upgrade::on()` (wrapped in `TokioIo` adapter from `hyper-util`).
4. TCP-connect to upstream (`parse_upstream_addr()` → host, port, TLS flag); TLS via `tokio-rustls 0.26` + `webpki-roots 1.0` (`TlsConnector` stored on `ProxyState`).
5. Write upstream HTTP/1.1 upgrade request as raw bytes: forward auth headers (`Cookie`, `Authorization`, `Origin`, etc.) verbatim; skip and regenerate hop-by-hop WS headers (`host`, `connection`, `upgrade`, `sec-websocket-key`, `sec-websocket-version`, `sec-websocket-extensions`).
6. Read and validate upstream `101` response (`read_upstream_101()`).
7. `tokio::io::copy_bidirectional()` pipes bytes in both directions until either side closes.

The proxy never parses WebSocket frames. The upstream handles its own WS subprotocol. Auth cookies and bearer tokens are forwarded correctly.

**Why TCP tunnel > two-leg message proxy:** Industry standard (nginx, Caddy, Traefik all tunnel WS at TCP layer). Immune to hop-by-hop header edge cases. Works for any WS subprotocol. No message-copy overhead. VS Code Remote's port-forward WS proxying also uses raw TCP tunnel.

**Non-regression note:** The tungstenite dependency is still present in `Cargo.toml` for `derive_accept_key` only. The proxy itself does not use tungstenite for connection establishment or frame I/O.

### Login Overlay vs. Machine-Switch Auth

The login overlay has two distinct trigger contexts with different dismissal rules:

| Context | Escape key | Reason |
|---------|-----------|--------|
| Fresh page load (mandatory auth) | **Blocked** | App cannot function without a valid Self token; overlay must not be dismissed |
| Machine switch (target machine requires auth) | **Allowed** | Dismissing cancels the switch and returns to the current machine; no state is lost |

No state mutation occurs until both machine-switch confirmation AND authentication succeed. If auth is cancelled or fails the current machine remains active and all UI state is unchanged.

### Non-Goals / Avoid Re-Research

The following were already evaluated and should not be treated as open design questions unless new constraints appear:

- "Should we keep host-comparison-based cookie policy?" -> No (rejected)
- "Should proxy skip cookie/path rewriting and leave everything to auth service?" -> No, prefix path adaptation is proxy-layer concern
- "Can HTTP browser accept Secure cookie if upstream is HTTPS?" -> No
- "Should URL token auth be brought back for convenience?" -> No, applies to both HTTP API and WebSocket URLs
- "Should WebSocket include ?token= for reliability?" -> No, `Sec-WebSocket-Protocol` subprotocol header achieves the same reliability without URL token exposure (v0.1.6c)
- "Does Sec-WebSocket-Protocol auth conflict with proxied upstream real subprotocols?" -> No; subprotocol auth is scoped to sidecar's own `/admin/api/ws/terminal` handler; proxied upstream WS goes through raw TCP tunnel (`handle_ws_tunnel`) which forwards all headers including real subprotocols without inspection
- "Should logout be client-only (just clear localStorage)?" -> No, server must clear HttpOnly cookie — JS cannot delete HttpOnly cookies directly
- "Can we use SameSite=Lax for a remote HTTPS machine accessed from an HTTP SPA?" -> No (validated failure Feb 2026); cross-site `<img>` and WebSocket do not carry Lax cookies
- "Can Secure cookies be stored by browser when current page is HTTP but Set-Cookie comes from HTTPS?" -> Yes, Secure restricts send channel not storage; a cross-origin HTTPS login response can store a Secure cookie in the browser
- "Is the machine-switch thumbnail 401 at moment of switch a cookie issue?" -> Partially; stale DOM items from pre-switch machine also contribute a race-condition path that sends wrong-machine file paths to the new machine
- "Should two-leg tungstenite WebSocket proxy be restored?" -> No; superseded by raw TCP tunnel (v0.1.6b); hop-by-hop header stripping makes tungstenite two-leg approach inherently broken in this proxy pipeline
- "Should proxy inspect/parse WS frames for auth or routing?" -> No; TCP tunnel is sufficient; frame parsing adds complexity with no benefit for this use case; upstream handles its own WS subprotocol

### Decision Summary (Authoritative)

- Auth cookie attribute policy: server-transport-based via `X-Forwarded-Proto`/`X-Forwarded-Ssl` (**v0.1.6, implemented**) — HTTPS edge → `Secure; SameSite=None`; plain HTTP → `SameSite=Lax`. Origin-scheme-based rule (v0.1.5) was broken for HTTP-origin SPA accessing HTTPS remote machine and is superseded.
- Proxy response header forwarding: append/preserve multi-value headers
- Proxy cookie path adaptation: enabled for prefixed proxy routes
- URL query auth: permanently disabled (HTTP API and WebSocket)
- WebSocket auth: `Sec-WebSocket-Protocol: auth-token.<jwt>` subprotocol header (primary, v0.1.6c) with cookie fallback; no `?token=` in URL. Fixes iOS Safari ITP intermittent cookie suppression. Subprotocol auth scoped to `/admin/api/ws/terminal` only — does not conflict with proxied upstream real subprotocols.
- Logout: two-step — server API clears HttpOnly cookie, then client clears localStorage JWT (fire-and-forget)
- Browser fetch credential propagation: `credentials: 'include'` required on login requests
- Machine URL format: single full URL field (scheme + host + port + path); scheme drives per-machine cookie security policy
- Frontend proxy prefix: `BASE_PATH` detected from page URL, prefixed on all Self-machine requests
- Login overlay Escape: allowed only during machine-switch auth; blocked during mandatory startup auth
- WebSocket proxy implementation: raw TCP tunnel (`hyper::upgrade::on()` + `tokio::io::copy_bidirectional`, v0.1.6b); auth headers (`Cookie`, `Authorization`) forwarded verbatim in upstream upgrade request; hop-by-hop WS headers regenerated fresh; `tokio-rustls` for wss:// upstreams; no WS frame parsing in proxy

When proposing changes to auth/proxy behavior, validate against this summary first to avoid regressions.


