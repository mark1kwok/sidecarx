use axum::{
    body::Body,
    extract::Request,
    http::{header, HeaderMap, StatusCode, Uri},
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use base64::{engine::general_purpose, Engine as _};
use hmac::{Hmac, Mac};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use serde::{Deserialize, Serialize};
use sha2::Sha256;

use crate::utils::ApiError;

type HmacSha256 = Hmac<Sha256>;
const URL_AUTH_MARKER_HEADER: &str = "x-sidecar-url-auth";

/// JWT Claims structure
#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub exp: usize,
    pub iat: usize,
}

/// Login request body
#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub secret: String,
}

/// Auth status response body
#[derive(Debug, Serialize)]
pub struct AuthStatusResponse {
    pub valid: bool,
    pub exp: usize,
    pub root_dir: Option<String>,
}

fn generate_random_secret() -> String {
    use std::fs::File;
    use std::io::Read;
    
    let mut bytes = [0u8; 32];
    if let Ok(mut file) = File::open("/dev/urandom") {
        if file.read_exact(&mut bytes).is_ok() {
            let mut hex_string = String::with_capacity(64);
            for b in bytes {
                hex_string.push_str(&format!("{:02x}", b));
            }
            return hex_string;
        }
    }
    // High-entropy fallback using nano timestamp if /dev/urandom fails
    let mut fallback = String::new();
    for _ in 0..32 {
        fallback.push_str(&format!("{:x}", chrono::Utc::now().timestamp_nanos_opt().unwrap_or(0)));
    }
    fallback
}

static SECRET: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Get the JWT secret from environment or default to "admin"
fn get_secret() -> String {
    SECRET.get_or_init(|| {
        match std::env::var("SIDECAR_SECRET") {
            Ok(val) => {
                if val.trim().is_empty() {
                    tracing::info!("**********************************************************");
                    tracing::info!("SIDECAR_SECRET is empty. Using default secret: 'admin'");
                    tracing::info!("**********************************************************");
                    "admin".to_string()
                } else {
                    val
                }
            }
            Err(_) => {
                tracing::info!("**********************************************************");
                tracing::info!("SIDECAR_SECRET is not set. Using default secret: 'admin'");
                tracing::info!("**********************************************************");
                "admin".to_string()
            }
        }
    }).clone()
}

/// Generate a JWT token
pub fn generate_token() -> Result<(String, usize), ApiError> {
    let secret = get_secret();
    let now = chrono::Utc::now();
    let exp = now + chrono::Duration::hours(24 * 7);

    let claims = Claims {
        sub: "sidecar_user".to_string(),
        iat: now.timestamp() as usize,
        exp: exp.timestamp() as usize,
    };

    let token = encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| ApiError::Internal(format!("Failed to generate token: {}", e)))?;

    Ok((token, claims.exp))
}

fn to_hex(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len() * 2);
    for b in input {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

pub fn generate_fetch_key(exp_jwt: usize) -> String {
    general_purpose::URL_SAFE_NO_PAD.encode(exp_jwt.to_string().as_bytes())
}

pub fn decode_fetch_key(key: &str) -> Option<usize> {
    let bytes = general_purpose::URL_SAFE_NO_PAD.decode(key).ok()?;
    let text = String::from_utf8(bytes).ok()?;
    text.parse::<usize>().ok()
}

fn extract_referer(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::REFERER)
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| v.to_string())
}

pub fn generate_fetch_token(key: &str, referer: &str) -> Result<String, ApiError> {
    let secret = get_secret();
    let secret_b64 = general_purpose::STANDARD.encode(secret.as_bytes());
    let payload = format!("{}{}{}", secret_b64, referer, key);

    let mut mac = HmacSha256::new_from_slice(secret.as_bytes())
        .map_err(|e| ApiError::Internal(format!("Failed to initialize HMAC: {}", e)))?;
    mac.update(payload.as_bytes());
    let bytes = mac.finalize().into_bytes();
    Ok(to_hex(&bytes))
}

pub fn compose_fetch_token(signature: &str, key: &str) -> String {
    format!("{}.{}", signature, key)
}

pub fn split_fetch_token(token: &str) -> Option<(String, String)> {
    let (signature, key) = token.split_once('.')?;
    if signature.is_empty() || key.is_empty() {
        return None;
    }
    Some((signature.to_string(), key.to_string()))
}

fn is_url_fallback_endpoint(uri: &Uri) -> bool {
    matches!(
        uri.path(),
        "/api/fs/read" | "/api/fs/thumbnail" | "/fs/read" | "/fs/thumbnail"
    )
}

fn query_param(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        let mut it = pair.splitn(2, '=');
        let k = it.next()?;
        let v = it.next().unwrap_or("");
        if k == key {
            return Some(v.to_string());
        }
    }
    None
}

/// Validate a JWT token
pub fn validate_token(token: &str) -> Result<Claims, ApiError> {
    let secret = get_secret();

    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )
    .map(|data| data.claims)
    .map_err(|e| ApiError::Unauthorized(format!("Invalid token: {}", e)))
}

fn is_secure_network(headers: &HeaderMap) -> bool {
    if let Some(proto) = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
    {
        return proto.eq_ignore_ascii_case("https");
    }
    if let Some(ssl) = headers.get("x-forwarded-ssl").and_then(|v| v.to_str().ok()) {
        return ssl.eq_ignore_ascii_case("on");
    }
    false
}

pub fn build_set_cookie(token_value: &str, headers: &HeaderMap, clear: bool) -> String {
    let base = if clear {
        "token=; Path=/api; Max-Age=0; HttpOnly".to_string()
    } else {
        format!(
            "token={}; Path=/api; HttpOnly; Max-Age=604800",
            token_value
        )
    };
    if is_secure_network(headers) {
        format!("{base}; Secure; SameSite=None; Partitioned")
    } else {
        format!("{base}; SameSite=Lax")
    }
}

pub fn extract_token_from_ws_protocol(headers: &HeaderMap) -> Option<String> {
    headers
        .get("sec-websocket-protocol")
        .and_then(|value| value.to_str().ok())
        .and_then(|protocols| {
            protocols.split(',').find_map(|p| {
                let p = p.trim();
                p.strip_prefix("auth-token.").map(|token| token.to_string())
            })
        })
        .filter(|t| !t.is_empty())
}

pub fn extract_token_from_cookie(headers: &HeaderMap) -> Option<String> {
    headers
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(|cookie_str| {
            cookie_str.split(';').find_map(|pair| {
                let pair = pair.trim();
                if let Some(value) = pair.strip_prefix("token=") {
                    if !value.is_empty() {
                        Some(value.to_string())
                    } else {
                        None
                    }
                } else {
                    None
                }
            })
        })
}

pub async fn login(request: Request<Body>) -> Result<Response, ApiError> {
    let headers = request.headers().clone();
    let body_bytes = axum::body::to_bytes(request.into_body(), 1024 * 1024)
        .await
        .map_err(|_| ApiError::Internal("Failed to read request body".to_string()))?;
    let payload: LoginRequest = serde_json::from_slice(&body_bytes)
        .map_err(|_| ApiError::Unauthorized("Invalid request body".to_string()))?;

    let expected_secret = get_secret();
    if payload.secret != expected_secret {
        return Err(ApiError::Unauthorized("Invalid secret".to_string()));
    }

    let (token, exp) = generate_token()?;
    let referer = extract_referer(&headers);
    let fetch_token = match referer.as_deref() {
        Some(r) => {
            let fetch_key = generate_fetch_key(exp);
            let signature = generate_fetch_token(&fetch_key, r)?;
            Some(compose_fetch_token(&signature, &fetch_key))
        }
        None => None,
    };
    let cookie = build_set_cookie(&token, &headers, false);

    let body = serde_json::json!({
        "token": token,
        "fetchToken": fetch_token,
        "rootDir": None::<String>
    });

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::SET_COOKIE, cookie)
        .body(Body::from(serde_json::to_string(&body).unwrap()))
        .unwrap())
}

pub async fn logout(request: Request<Body>) -> Response {
    let cookie = build_set_cookie("", request.headers(), true);
    let body = serde_json::json!({ "success": true });

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::SET_COOKIE, cookie)
        .body(Body::from(serde_json::to_string(&body).unwrap()))
        .unwrap()
}

pub async fn auth_status(request: Request<Body>) -> Result<Json<AuthStatusResponse>, ApiError> {
    let auth_header = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok());

    let token = if let Some(auth_value) = auth_header {
        if auth_value.starts_with("Bearer ") {
            Some(auth_value[7..].to_string())
        } else {
            None
        }
    } else {
        extract_token_from_cookie(request.headers())
    };

    match token {
        Some(t) => {
            let claims = validate_token(&t)?;
            Ok(Json(AuthStatusResponse {
                valid: true,
                exp: claims.exp,
                root_dir: None,
            }))
        }
        None => Err(ApiError::Unauthorized(
            "Missing authentication token".to_string(),
        )),
    }
}

pub async fn auth_middleware(request: Request<Body>, next: Next) -> Response {
    let mut request = request;

    // Direct loopback Same-OS check: bypass auth if direct loopback connection with no proxy headers
    if let Some(axum::extract::ConnectInfo(addr)) = request.extensions().get::<axum::extract::ConnectInfo<std::net::SocketAddr>>() {
        let ip = addr.ip();
        if ip.is_loopback() {
            let headers = request.headers();
            let has_proxy_headers = [
                "x-forwarded-for",
                "x-real-ip",
                "x-forwarded-host",
                "x-forwarded-proto",
                "x-forwarded-ssl",
                "forwarded",
                "via",
            ]
            .iter()
            .any(|&h| headers.contains_key(h));

            if !has_proxy_headers {
                tracing::debug!("Bypassing auth for direct loopback connection from {:?}", addr);
                return next.run(request).await;
            }
        }
    }

    let auth_header = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .map(|s| s.to_string());

    if let Some(auth_value) = auth_header {
        if !auth_value.starts_with("Bearer ") {
            return ApiError::Unauthorized("Invalid Authorization header".to_string())
                .into_response();
        }
        let t = &auth_value[7..];
        if t.is_empty() {
            return ApiError::Unauthorized("Missing Bearer token".to_string()).into_response();
        }
        return match validate_token(t) {
            Ok(_claims) => next.run(request).await,
            Err(e) => e.into_response(),
        };
    }

    if let Some(ws_token) = extract_token_from_ws_protocol(request.headers()) {
        return match validate_token(&ws_token) {
            Ok(_claims) => next.run(request).await,
            Err(e) => e.into_response(),
        };
    }

    if let Some(cookie_token) = extract_token_from_cookie(request.headers()) {
        return match validate_token(&cookie_token) {
            Ok(_claims) => next.run(request).await,
            Err(e) => e.into_response(),
        };
    }

    if is_url_fallback_endpoint(request.uri()) {
        if let Some(query) = request.uri().query() {
            let token = query_param(query, "token");

            if let Some(token) = token {
                let Some((signature, key)) = split_fetch_token(&token) else {
                    return ApiError::Unauthorized("Invalid fetch token format".to_string())
                        .into_response();
                };

                let Some(exp) = decode_fetch_key(&key) else {
                    return ApiError::Unauthorized("Invalid fetch key".to_string()).into_response();
                };

                let now = chrono::Utc::now().timestamp() as usize;
                if now > exp {
                    return ApiError::Unauthorized("Fetch key expired".to_string()).into_response();
                }

                let Some(referer) = extract_referer(request.headers()) else {
                    return ApiError::Unauthorized("Missing Referer".to_string()).into_response();
                };

                let expected = match generate_fetch_token(&key, &referer) {
                    Ok(v) => v,
                    Err(e) => return e.into_response(),
                };

                if signature != expected {
                    return ApiError::Unauthorized("Invalid fetch token".to_string())
                        .into_response();
                }

                if let Ok(name) = URL_AUTH_MARKER_HEADER.parse::<header::HeaderName>() {
                    request
                        .headers_mut()
                        .insert(name, header::HeaderValue::from_static("1"));
                }

                return next.run(request).await;
            }
        }
    }

    ApiError::Unauthorized("Missing authentication token".to_string()).into_response()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderMap;
    use axum::http::Request;
    use axum::{body::Body, middleware, routing::get, Router};
    use tower::util::ServiceExt;

    fn build_auth_test_app() -> Router {
        Router::new()
            .route("/api/fs/read", get(|| async { "ok" }))
            .route("/api/fs/thumbnail", get(|| async { "ok" }))
            .route("/api/fs/list", get(|| async { "ok" }))
            .layer(middleware::from_fn(auth_middleware))
    }

    fn make_fetch_token(exp: usize, referer: &str) -> String {
        let key = generate_fetch_key(exp);
        let signature = generate_fetch_token(&key, referer).unwrap();
        compose_fetch_token(&signature, &key)
    }

    #[test]
    fn test_extract_token_single_cookie() {
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, "token=abc123".parse().unwrap());
        assert_eq!(
            extract_token_from_cookie(&headers),
            Some("abc123".to_string())
        );
    }

    #[test]
    fn test_extract_token_multiple_cookies() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            "session=xyz; token=abc123; theme=dark".parse().unwrap(),
        );
        assert_eq!(
            extract_token_from_cookie(&headers),
            Some("abc123".to_string())
        );
    }

    #[test]
    fn test_extract_token_missing_key() {
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, "session=xyz; theme=dark".parse().unwrap());
        assert_eq!(extract_token_from_cookie(&headers), None);
    }

    #[test]
    fn test_extract_token_empty_value() {
        let mut headers = HeaderMap::new();
        headers.insert(header::COOKIE, "token=".parse().unwrap());
        assert_eq!(extract_token_from_cookie(&headers), None);
    }

    #[test]
    fn test_extract_token_whitespace_around_pairs() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            "  session=xyz ;  token=abc123 ; theme=dark"
                .parse()
                .unwrap(),
        );
        assert_eq!(
            extract_token_from_cookie(&headers),
            Some("abc123".to_string())
        );
    }

    #[test]
    fn test_extract_token_no_cookie_header() {
        let headers = HeaderMap::new();
        assert_eq!(extract_token_from_cookie(&headers), None);
    }

    // --- extract_token_from_ws_protocol tests ---

    #[test]
    fn test_ws_protocol_single_auth_token() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "sec-websocket-protocol",
            "auth-token.jwt123".parse().unwrap(),
        );
        assert_eq!(
            extract_token_from_ws_protocol(&headers),
            Some("jwt123".to_string())
        );
    }

    #[test]
    fn test_ws_protocol_multiple_protocols() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "sec-websocket-protocol",
            "graphql-ws, auth-token.jwt456".parse().unwrap(),
        );
        assert_eq!(
            extract_token_from_ws_protocol(&headers),
            Some("jwt456".to_string())
        );
    }

    #[test]
    fn test_ws_protocol_no_auth_token() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "sec-websocket-protocol",
            "graphql-ws, binary".parse().unwrap(),
        );
        assert_eq!(extract_token_from_ws_protocol(&headers), None);
    }

    #[test]
    fn test_ws_protocol_empty_token() {
        let mut headers = HeaderMap::new();
        headers.insert("sec-websocket-protocol", "auth-token.".parse().unwrap());
        assert_eq!(extract_token_from_ws_protocol(&headers), None);
    }

    #[test]
    fn test_ws_protocol_missing_header() {
        let headers = HeaderMap::new();
        assert_eq!(extract_token_from_ws_protocol(&headers), None);
    }

    // --- is_secure_network tests ---

    #[test]
    fn test_secure_x_forwarded_proto_https() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-proto".parse::<header::HeaderName>().unwrap(),
            "https".parse().unwrap(),
        );
        assert!(is_secure_network(&headers));
    }

    #[test]
    fn test_secure_x_forwarded_proto_http() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-proto".parse::<header::HeaderName>().unwrap(),
            "http".parse().unwrap(),
        );
        assert!(!is_secure_network(&headers));
    }

    #[test]
    fn test_secure_x_forwarded_ssl_on() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-ssl".parse::<header::HeaderName>().unwrap(),
            "on".parse().unwrap(),
        );
        assert!(is_secure_network(&headers));
    }

    #[test]
    fn test_secure_x_forwarded_ssl_off() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-ssl".parse::<header::HeaderName>().unwrap(),
            "off".parse().unwrap(),
        );
        assert!(!is_secure_network(&headers));
    }

    #[test]
    fn test_secure_no_proxy_headers() {
        let headers = HeaderMap::new();
        assert!(!is_secure_network(&headers));
    }

    #[test]
    fn test_secure_proto_takes_priority_over_ssl() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-proto".parse::<header::HeaderName>().unwrap(),
            "https".parse().unwrap(),
        );
        headers.insert(
            "x-forwarded-ssl".parse::<header::HeaderName>().unwrap(),
            "off".parse().unwrap(),
        );
        // X-Forwarded-Proto wins
        assert!(is_secure_network(&headers));
    }

    #[test]
    fn test_secure_http_origin_behind_https_proxy() {
        // Browser on HTTP page, but request delivered over HTTPS proxy
        let mut headers = HeaderMap::new();
        headers.insert(header::ORIGIN, "http://34.1.134.203:3000".parse().unwrap());
        headers.insert(
            "x-forwarded-proto".parse::<header::HeaderName>().unwrap(),
            "https".parse().unwrap(),
        );
        // Origin is irrelevant — transport is HTTPS
        assert!(is_secure_network(&headers));
    }

    // --- build_set_cookie tests ---

    #[test]
    fn test_cookie_plain_http_no_proxy() {
        // Direct HTTP access, no proxy headers → Lax
        let headers = HeaderMap::new();
        let cookie = build_set_cookie("jwt123", &headers, false);
        assert!(cookie.contains("SameSite=Lax"));
        assert!(!cookie.contains("Secure"));
        assert!(cookie.contains("token=jwt123"));
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("Path=/api"));
    }

    #[test]
    fn test_cookie_behind_https_proxy() {
        // Behind HTTPS-terminating proxy (e.g. Railway)
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-proto".parse::<header::HeaderName>().unwrap(),
            "https".parse().unwrap(),
        );
        let cookie = build_set_cookie("jwt456", &headers, false);
        assert!(cookie.contains("SameSite=None"));
        assert!(cookie.contains("Secure"));
        assert!(cookie.contains("token=jwt456"));
    }

    #[test]
    fn test_cookie_http_origin_behind_https_proxy() {
        // HTTP page calling HTTPS backend — transport is HTTPS → Secure
        let mut headers = HeaderMap::new();
        headers.insert(header::ORIGIN, "http://34.1.134.203:3000".parse().unwrap());
        headers.insert(
            "x-forwarded-proto".parse::<header::HeaderName>().unwrap(),
            "https".parse().unwrap(),
        );
        let cookie = build_set_cookie("jwt_cross", &headers, false);
        assert!(cookie.contains("SameSite=None"));
        assert!(cookie.contains("Secure"));
    }

    #[test]
    fn test_cookie_clear_behind_https_proxy() {
        let mut headers = HeaderMap::new();
        headers.insert(
            "x-forwarded-proto".parse::<header::HeaderName>().unwrap(),
            "https".parse().unwrap(),
        );
        let cookie = build_set_cookie("", &headers, true);
        assert!(cookie.contains("token="));
        assert!(cookie.contains("Max-Age=0"));
        assert!(cookie.contains("SameSite=None"));
        assert!(cookie.contains("Secure"));
    }

    #[test]
    fn test_cookie_clear_plain_http() {
        let headers = HeaderMap::new();
        let cookie = build_set_cookie("", &headers, true);
        assert!(cookie.contains("Max-Age=0"));
        assert!(cookie.contains("SameSite=Lax"));
        assert!(!cookie.contains("Secure"));
    }

    #[test]
    fn test_cookie_no_proxy_headers_fallback_lax() {
        let headers = HeaderMap::new();
        let cookie = build_set_cookie("jwt789", &headers, false);
        assert!(cookie.contains("SameSite=Lax"));
        assert!(!cookie.contains("Secure"));
    }

    #[test]
    fn test_fetch_key_roundtrip() {
        let exp = 1_900_000_000usize;
        let key = generate_fetch_key(exp);
        assert_eq!(decode_fetch_key(&key), Some(exp));
    }

    #[test]
    fn test_fetch_token_deterministic_for_same_key() {
        let key = generate_fetch_key(1_900_000_000usize);
        let referer = "https://example.com/admin/";
        let a = generate_fetch_token(&key, referer).unwrap();
        let b = generate_fetch_token(&key, referer).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn test_fetch_token_changes_when_key_changes() {
        let key_a = generate_fetch_key(1_900_000_000usize);
        let key_b = generate_fetch_key(1_900_000_001usize);
        let referer = "https://example.com/admin/";
        let token_a = generate_fetch_token(&key_a, referer).unwrap();
        let token_b = generate_fetch_token(&key_b, referer).unwrap();
        assert_ne!(token_a, token_b);
    }

    #[test]
    fn test_fetch_token_changes_when_referer_changes() {
        let key = generate_fetch_key(1_900_000_000usize);
        let token_a = generate_fetch_token(&key, "https://example.com/a").unwrap();
        let token_b = generate_fetch_token(&key, "https://example.com/b").unwrap();
        assert_ne!(token_a, token_b);
    }

    #[test]
    fn test_fetch_token_compose_split_roundtrip() {
        let key = generate_fetch_key(1_900_000_000usize);
        let signature = generate_fetch_token(&key, "https://example.com/admin/").unwrap();
        let blended = compose_fetch_token(&signature, &key);
        let (sig2, key2) = split_fetch_token(&blended).unwrap();
        assert_eq!(sig2, signature);
        assert_eq!(key2, key);
    }

    #[tokio::test]
    async fn test_url_fallback_allowed_endpoint_success() {
        let app = build_auth_test_app();
        let exp = (chrono::Utc::now().timestamp() as usize) + 3600;
        let referer = "https://example.com/admin/";
        let token = make_fetch_token(exp, referer);

        let req = Request::builder()
            .uri(format!("/api/fs/read?path=/tmp/a.png&token={token}"))
            .header(header::REFERER, referer)
            .body(Body::empty())
            .unwrap();

        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn test_url_fallback_disallowed_endpoint_rejected() {
        let app = build_auth_test_app();
        let exp = (chrono::Utc::now().timestamp() as usize) + 3600;
        let token = make_fetch_token(exp, "https://example.com/admin/");

        let req = Request::builder()
            .uri(format!("/api/fs/list?path=/&token={token}"))
            .body(Body::empty())
            .unwrap();

        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_invalid_authorization_header_does_not_fall_through_to_url_fallback() {
        let app = build_auth_test_app();
        let exp = (chrono::Utc::now().timestamp() as usize) + 3600;
        let token = make_fetch_token(exp, "https://example.com/admin/");

        let req = Request::builder()
            .uri(format!("/api/fs/read?path=/tmp/a.png&token={token}"))
            .header(header::AUTHORIZATION, "Basic abc")
            .body(Body::empty())
            .unwrap();

        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_invalid_cookie_does_not_fall_through_to_url_fallback() {
        let app = build_auth_test_app();
        let exp = (chrono::Utc::now().timestamp() as usize) + 3600;
        let token = make_fetch_token(exp, "https://example.com/admin/");

        let req = Request::builder()
            .uri(format!("/api/fs/read?path=/tmp/a.png&token={token}"))
            .header(header::COOKIE, "token=not-a-jwt")
            .body(Body::empty())
            .unwrap();

        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_expired_fetch_key_rejected() {
        let app = build_auth_test_app();
        let exp = (chrono::Utc::now().timestamp() as usize).saturating_sub(1);
        let token = make_fetch_token(exp, "https://example.com/admin/");

        let req = Request::builder()
            .uri(format!("/api/fs/read?path=/tmp/a.png&token={token}"))
            .body(Body::empty())
            .unwrap();

        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_bad_hmac_rejected() {
        let app = build_auth_test_app();
        let exp = (chrono::Utc::now().timestamp() as usize) + 3600;
        let key = generate_fetch_key(exp);
        let token = compose_fetch_token("deadbeef", &key);

        let req = Request::builder()
            .uri(format!("/api/fs/read?path=/tmp/a.png&token={token}"))
            .header(header::REFERER, "https://example.com/admin/")
            .body(Body::empty())
            .unwrap();

        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_url_fallback_missing_referer_rejected() {
        let app = build_auth_test_app();
        let exp = (chrono::Utc::now().timestamp() as usize) + 3600;
        let token = make_fetch_token(exp, "https://example.com/admin/");

        let req = Request::builder()
            .uri(format!("/api/fs/read?path=/tmp/a.png&token={token}"))
            .body(Body::empty())
            .unwrap();

        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }

    #[tokio::test]
    async fn test_missing_query_params_rejected() {
        let app = build_auth_test_app();

        let req = Request::builder()
            .uri("/api/fs/read?path=/tmp/a.png")
            .body(Body::empty())
            .unwrap();

        let res = app.oneshot(req).await.unwrap();
        assert_eq!(res.status(), StatusCode::UNAUTHORIZED);
    }
}
