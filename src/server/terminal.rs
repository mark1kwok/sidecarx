use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        Query,
    },
    http::HeaderMap,
    response::Response,
};
use futures_util::{SinkExt, StreamExt};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{Read, Write};
use std::sync::Arc;
use tokio::sync::Mutex;

/// Query parameters for WebSocket terminal
#[derive(Debug, serde::Deserialize)]
pub struct TerminalQuery {
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

/// Extract the `auth-token.*` subprotocol from the request headers, if present.
/// RFC 6455 requires the server to echo the selected subprotocol in the 101 response.
fn extract_auth_subprotocol(headers: &HeaderMap) -> Option<String> {
    headers
        .get("sec-websocket-protocol")
        .and_then(|v| v.to_str().ok())
        .and_then(|protocols| {
            protocols
                .split(',')
                .map(|p| p.trim())
                .find(|p| p.starts_with("auth-token."))
                .map(|p| p.to_string())
        })
}

/// WebSocket terminal handler
/// Auth is handled by auth_middleware (Authorization header / Sec-WebSocket-Protocol / cookie)
pub async fn ws_terminal(
    headers: HeaderMap,
    ws: WebSocketUpgrade,
    Query(params): Query<TerminalQuery>,
) -> Response {
    let cols = params.cols.unwrap_or(80);
    let rows = params.rows.unwrap_or(24);

    // If client sent auth via Sec-WebSocket-Protocol, echo it back (RFC 6455 §4.2.2)
    let ws = if let Some(subprotocol) = extract_auth_subprotocol(&headers) {
        ws.protocols([subprotocol])
    } else {
        ws
    };

    ws.on_upgrade(move |socket| handle_terminal(socket, cols, rows))
}

/// Handle the WebSocket terminal connection
async fn handle_terminal(socket: WebSocket, cols: u16, rows: u16) {
    tracing::info!("Terminal WebSocket connected ({}x{})", cols, rows);

    // Create PTY
    let pty_system = native_pty_system();

    let pty_pair = match pty_system.openpty(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }) {
        Ok(pair) => pair,
        Err(e) => {
            tracing::error!("Failed to open PTY: {}", e);
            return;
        }
    };

    // Get the shell to use
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/bash".to_string());

    // Spawn shell process
    let mut cmd = CommandBuilder::new(&shell);
    cmd.env("TERM", "xterm-256color");

    let child = match pty_pair.slave.spawn_command(cmd) {
        Ok(child) => child,
        Err(e) => {
            tracing::error!("Failed to spawn shell: {}", e);
            return;
        }
    };

    let child = Arc::new(Mutex::new(child));

    // Get reader and writer for PTY master
    let reader = match pty_pair.master.try_clone_reader() {
        Ok(r) => r,
        Err(e) => {
            tracing::error!("Failed to clone PTY reader: {}", e);
            return;
        }
    };

    let writer = match pty_pair.master.take_writer() {
        Ok(w) => Arc::new(Mutex::new(w)),
        Err(e) => {
            tracing::error!("Failed to get PTY writer: {}", e);
            return;
        }
    };

    let master = Arc::new(Mutex::new(pty_pair.master));

    // Split WebSocket
    let (ws_sender, ws_receiver) = socket.split();
    let ws_sender = Arc::new(Mutex::new(ws_sender));

    // Task to read from PTY and send to WebSocket
    let ws_sender_clone = Arc::clone(&ws_sender);
    let pty_to_ws = tokio::task::spawn_blocking(move || {
        let mut reader = reader;
        let mut buf = [0u8; 4096];

        loop {
            match reader.read(&mut buf) {
                Ok(0) => {
                    tracing::info!("PTY EOF");
                    break;
                }
                Ok(n) => {
                    let data = buf[..n].to_vec();
                    let sender = Arc::clone(&ws_sender_clone);

                    // Send to WebSocket
                    let rt = tokio::runtime::Handle::current();
                    rt.block_on(async {
                        let mut sender = sender.lock().await;
                        if sender.send(Message::Binary(data)).await.is_err() {
                            tracing::warn!("Failed to send to WebSocket");
                        }
                    });
                }
                Err(e) => {
                    tracing::error!("PTY read error: {}", e);
                    break;
                }
            }
        }
    });

    // Task to read from WebSocket and write to PTY
    let writer_clone = Arc::clone(&writer);
    let child_clone = Arc::clone(&child);
    let master_clone = Arc::clone(&master);
    let ws_to_pty = {
        let mut ws_receiver = ws_receiver;

        async move {
            while let Some(msg) = ws_receiver.next().await {
                match msg {
                    Ok(Message::Text(text)) => {
                        // Handle resize request
                        if text.starts_with("{\"type\":\"resize\"") {
                            if let Ok(msg) = serde_json::from_str::<ResizeMessage>(&text) {
                                let master = master_clone.lock().await;
                                if let Err(e) = master.resize(PtySize {
                                    rows: msg.rows,
                                    cols: msg.cols,
                                    pixel_width: 0,
                                    pixel_height: 0,
                                }) {
                                    tracing::error!("PTY resize error: {}", e);
                                } else {
                                    tracing::info!("Resized PTY to {}x{}", msg.cols, msg.rows);
                                }
                            }
                        } else {
                            // Handle keyboard input text
                            let mut writer = writer_clone.lock().await;
                            if let Err(e) = writer.write_all(text.as_bytes()) {
                                tracing::error!("PTY write error: {}", e);
                                break;
                            }
                            let _ = writer.flush();
                        }
                    }
                    Ok(Message::Binary(data)) => {
                        // Handle binary messages
                        let mut writer = writer_clone.lock().await;
                        if let Err(e) = writer.write_all(&data) {
                            tracing::error!("PTY write error: {}", e);
                            break;
                        }
                        let _ = writer.flush();
                    }
                    Ok(Message::Close(_)) => {
                        tracing::info!("WebSocket closed by client");
                        break;
                    }
                    Err(e) => {
                        tracing::error!("WebSocket error: {}", e);
                        break;
                    }
                    _ => {}
                }
            }

            // Kill the child process when WebSocket closes
            let mut child = child_clone.lock().await;
            let _ = child.kill();
        }
    };

    // Wait for tasks
    tokio::select! {
        _ = pty_to_ws => {
            tracing::info!("PTY reader task ended");
        }
        _ = ws_to_pty => {
            tracing::info!("WebSocket reader task ended");
        }
    }

    // Cleanup
    let mut child = child.lock().await;
    let _ = child.kill();

    tracing::info!("Terminal WebSocket disconnected");
}

/// Resize terminal message (for future implementation)
#[derive(Debug, serde::Deserialize)]
#[allow(dead_code)]
pub struct ResizeMessage {
    pub cols: u16,
    pub rows: u16,
}
