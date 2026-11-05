//! Instant updates: Jellyfin pushes UserDataChanged and LibraryChanged over a
//! WebSocket, and the page refreshes when either arrives. Follows the official
//! SDK: `/socket?ApiKey=…`, and a KeepAlive at half the server's timeout.

use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use std::time::Duration;
use tauri::async_runtime::JoinHandle;
use tauri::{AppHandle, Emitter};
use tokio::time::{interval_at, sleep, Instant, Interval};
use tokio_tungstenite::{connect_async, tungstenite::Message};

const FIRST_RETRY: f64 = 1.0;
const MAX_RETRY: f64 = 300.0;

pub struct Live {
    task: Mutex<Option<JoinHandle<()>>>,
    connected: Arc<AtomicBool>,
}

impl Live {
    pub fn new() -> Self {
        Self { task: Mutex::new(None), connected: Arc::new(AtomicBool::new(false)) }
    }

    pub fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Relaxed)
    }

    pub fn start(&self, app: AppHandle, server: String, token: String) {
        self.stop();
        let connected = self.connected.clone();
        let handle = tauri::async_runtime::spawn(run(app, server, token, connected));
        *self.task.lock().unwrap() = Some(handle);
    }

    pub fn stop(&self) {
        if let Some(handle) = self.task.lock().unwrap().take() {
            handle.abort();
        }
        self.connected.store(false, Ordering::Relaxed);
    }
}

fn socket_url(server: &str, token: &str) -> String {
    let base = if let Some(rest) = server.strip_prefix("https://") {
        format!("wss://{rest}")
    } else if let Some(rest) = server.strip_prefix("http://") {
        format!("ws://{rest}")
    } else {
        server.to_string()
    };
    format!("{base}/socket?ApiKey={token}")
}

fn set_status(app: &AppHandle, connected: &AtomicBool, value: bool) {
    connected.store(value, Ordering::Relaxed);
    let _ = app.emit("live-status", value);
}

async fn tick(keep_alive: &mut Option<Interval>) {
    match keep_alive {
        Some(timer) => {
            timer.tick().await;
        }
        None => std::future::pending::<()>().await,
    }
}

async fn run(app: AppHandle, server: String, token: String, connected: Arc<AtomicBool>) {
    let keep_alive_message = r#"{"MessageType":"KeepAlive"}"#;
    let mut retry = FIRST_RETRY;
    loop {
        if let Ok((stream, _)) = connect_async(socket_url(&server, &token)).await {
            retry = FIRST_RETRY;
            set_status(&app, &connected, true);
            // Catch up on anything that changed while disconnected.
            let _ = app.emit("jellyfin-changed", "connected");
            let (mut write, mut read) = stream.split();
            let mut keep_alive: Option<Interval> = None;
            loop {
                tokio::select! {
                    message = read.next() => match message {
                        Some(Ok(Message::Text(text))) => {
                            let body: Value = serde_json::from_str(text.as_str()).unwrap_or_default();
                            match body["MessageType"].as_str() {
                                Some("ForceKeepAlive") => {
                                    let timeout = body["Data"].as_f64().unwrap_or(60.0).max(2.0);
                                    let every = Duration::from_secs_f64(timeout / 2.0);
                                    if write.send(Message::Text(keep_alive_message.into())).await.is_err() {
                                        break;
                                    }
                                    keep_alive = Some(interval_at(Instant::now() + every, every));
                                }
                                Some(kind @ ("UserDataChanged" | "LibraryChanged")) => {
                                    let _ = app.emit("jellyfin-changed", kind);
                                }
                                _ => {}
                            }
                        }
                        Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                        _ => {}
                    },
                    _ = tick(&mut keep_alive) => {
                        if write.send(Message::Text(keep_alive_message.into())).await.is_err() {
                            break;
                        }
                    }
                }
            }
            set_status(&app, &connected, false);
        }
        sleep(Duration::from_secs_f64(retry)).await;
        retry = (retry * 1.5).min(MAX_RETRY);
    }
}
