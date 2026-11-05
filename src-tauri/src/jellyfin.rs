//! Talks to the Jellyfin server. The access token stays on this side:
//! it lives in Windows Credential Manager and is never passed to the page.

use reqwest::{Client, Method, RequestBuilder, StatusCode};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{fs, path::PathBuf, sync::RwLock, time::Duration};

const CLIENT_NAME: &str = "Interlude";
const VERSION: &str = env!("CARGO_PKG_VERSION");
#[cfg_attr(debug_assertions, allow(dead_code))]
const KEYRING_SERVICE: &str = "Interlude";
const IMAGE_TYPES: [&str; 3] = ["Primary", "Backdrop", "Thumb"];
const READABLE_PATHS: [&str; 3] = ["/Shows/", "/UserItems/Resume", "/Users/"];

#[derive(Debug, Serialize)]
pub struct Failure {
    /// "auth", "network" or "server"; the page picks its response from this.
    pub kind: &'static str,
    pub message: String,
}

impl Failure {
    pub fn server(message: impl Into<String>) -> Self {
        Self { kind: "server", message: message.into() }
    }
    pub fn auth(message: impl Into<String>) -> Self {
        Self { kind: "auth", message: message.into() }
    }
    pub fn tmdb_auth(message: impl Into<String>) -> Self {
        Self { kind: "tmdbauth", message: message.into() }
    }
    pub fn network(message: impl Into<String>) -> Self {
        Self { kind: "network", message: message.into() }
    }
}

#[derive(Clone, Serialize, Deserialize)]
struct Saved {
    device_id: String,
    server: Option<String>,
    user_id: Option<String>,
    user_name: Option<String>,
    #[serde(default)]
    settings: Settings,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Settings {
    /// Closing the window keeps Interlude running in the tray.
    pub tray: bool,
    pub notify_added: bool,
    pub notify_airing: bool,
    /// Missing episodes from before the first one on the server are hidden.
    pub ignore_earlier: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self { tray: true, notify_added: true, notify_airing: true, ignore_earlier: true }
    }
}

#[derive(Clone)]
struct Session {
    server: String,
    token: String,
    user_id: String,
    user_name: String,
}

#[derive(Clone, Serialize)]
pub struct SessionView {
    pub server: String,
    #[serde(rename = "userId")]
    pub user_id: String,
    #[serde(rename = "userName")]
    pub user_name: String,
    /// False when the sign-in couldn't be saved for the next launch.
    pub remembered: bool,
}

#[derive(Serialize)]
pub struct ServerInfo {
    pub name: String,
    pub version: String,
}

pub struct Jellyfin {
    client: Client,
    config_dir: PathBuf,
    config_path: PathBuf,
    saved: RwLock<Saved>,
    session: RwLock<Option<Session>>,
}

/// Secrets (the Jellyfin token, the TMDB key). Release builds keep them
/// in Windows Credential Manager under "Interlude".
#[cfg(not(debug_assertions))]
pub mod secrets {
    use super::KEYRING_SERVICE;

    fn entry(name: &str) -> Option<keyring::Entry> {
        keyring::Entry::new(KEYRING_SERVICE, name).ok()
    }
    pub fn load(_dir: &std::path::Path, name: &str) -> Option<String> {
        entry(name)?.get_password().ok()
    }
    pub fn save(_dir: &std::path::Path, name: &str, value: &str) -> bool {
        entry(name).is_some_and(|e| e.set_password(value).is_ok())
    }
    pub fn clear(_dir: &std::path::Path, name: &str) {
        if let Some(e) = entry(name) {
            let _ = e.delete_credential();
        }
    }
}

/// Debug builds use plain files so tests can run without a credential store.
#[cfg(debug_assertions)]
pub mod secrets {
    use std::{fs, path::Path};

    fn file(dir: &Path, name: &str) -> std::path::PathBuf {
        dir.join(format!("debug-secret-{name}"))
    }
    pub fn load(dir: &Path, name: &str) -> Option<String> {
        fs::read_to_string(file(dir, name)).ok()
    }
    pub fn save(dir: &Path, name: &str, value: &str) -> bool {
        fs::write(file(dir, name), value).is_ok()
    }
    pub fn clear(dir: &Path, name: &str) {
        let _ = fs::remove_file(file(dir, name));
    }
}

fn normalize_server(url: &str) -> Result<String, Failure> {
    let trimmed = url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        return Err(Failure::network("Enter your Jellyfin server address."));
    }
    let full = if trimmed.contains("://") {
        trimmed.to_string()
    } else {
        format!("http://{trimmed}")
    };
    match reqwest::Url::parse(&full) {
        Ok(u) if matches!(u.scheme(), "http" | "https") && u.host().is_some() => Ok(full),
        _ => Err(Failure::network(format!("\"{trimmed}\" isn't a valid server address."))),
    }
}

/// `/Items/{id}` (details) and `/Items/{id}/Similar`.
fn is_item_route(path: &str) -> bool {
    let mut parts = path.trim_start_matches("/Items/").split('/');
    path.starts_with("/Items/")
        && parts.next().is_some_and(is_item_id)
        && matches!(parts.next(), None | Some("Similar"))
        && parts.next().is_none()
}

fn is_item_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 36 && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-')
}

impl Jellyfin {
    pub fn load(config_dir: PathBuf) -> Self {
        let _ = fs::create_dir_all(&config_dir);
        let config_path = config_dir.join("config.json");
        let saved: Saved = fs::read(&config_path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_else(|| Saved {
                device_id: uuid::Uuid::new_v4().to_string(),
                server: None,
                user_id: None,
                user_name: None,
                settings: Settings::default(),
            });

        let token = secrets::load(&config_dir, &saved.device_id);
        let session = match (&saved.server, &saved.user_id, &saved.user_name, token) {
            (Some(server), Some(user_id), Some(user_name), Some(token)) => Some(Session {
                server: server.clone(),
                token,
                user_id: user_id.clone(),
                user_name: user_name.clone(),
            }),
            _ => None,
        };

        let this = Self {
            client: Client::builder()
                .timeout(Duration::from_secs(15))
                .build()
                .expect("HTTP client"),
            config_dir,
            config_path,
            saved: RwLock::new(saved),
            session: RwLock::new(session),
        };
        this.persist();
        this
    }

    fn persist(&self) {
        if let Ok(bytes) = serde_json::to_vec_pretty(&*self.saved.read().unwrap()) {
            let _ = fs::write(&self.config_path, bytes);
        }
    }

    fn auth_header(&self, token: Option<&str>) -> String {
        let device_id = self.saved.read().unwrap().device_id.clone();
        let mut header = format!(
            "MediaBrowser Client=\"{CLIENT_NAME}\", Device=\"Windows\", DeviceId=\"{device_id}\", Version=\"{VERSION}\""
        );
        if let Some(token) = token {
            header.push_str(&format!(", Token=\"{token}\""));
        }
        header
    }

    fn session(&self) -> Result<Session, Failure> {
        self.session
            .read()
            .unwrap()
            .clone()
            .ok_or_else(|| Failure::auth("Sign in to continue."))
    }

    fn request(&self, session: &Session, method: Method, path: &str) -> RequestBuilder {
        self.client
            .request(method, format!("{}{}", session.server, path))
            .header("Authorization", self.auth_header(Some(&session.token)))
    }

    async fn send(&self, request: RequestBuilder, server: &str) -> Result<reqwest::Response, Failure> {
        let response = request.send().await.map_err(|_| {
            Failure::network(format!("Can't reach {server}. Check that Jellyfin is running."))
        })?;
        match response.status() {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                Err(Failure::auth("Your Jellyfin session ended. Sign in again."))
            }
            status if status.is_success() || status == StatusCode::NOT_FOUND => Ok(response),
            status => Err(Failure::server(format!("Jellyfin returned an error ({status})."))),
        }
    }

    pub async fn server_info(&self, url: &str) -> Result<ServerInfo, Failure> {
        let server = normalize_server(url)?;
        let response = self
            .client
            .get(format!("{server}/System/Info/Public"))
            .send()
            .await
            .map_err(|_| Failure::network(format!("Can't reach {server}. Check the address and that Jellyfin is running.")))?;
        let body: Value = response
            .json()
            .await
            .map_err(|_| Failure::server(format!("{server} doesn't look like a Jellyfin server.")))?;
        let field = |name: &str| body[name].as_str().unwrap_or_default().to_string();
        if field("Version").is_empty() {
            return Err(Failure::server(format!("{server} doesn't look like a Jellyfin server.")));
        }
        Ok(ServerInfo { name: field("ServerName"), version: field("Version") })
    }

    pub async fn sign_in(&self, url: &str, username: &str, password: &str) -> Result<SessionView, Failure> {
        let server = normalize_server(url)?;
        let response = self
            .client
            .post(format!("{server}/Users/AuthenticateByName"))
            .header("Authorization", self.auth_header(None))
            .json(&json!({ "Username": username, "Pw": password }))
            .send()
            .await
            .map_err(|_| Failure::network(format!("Can't reach {server}. Check the address and that Jellyfin is running.")))?;

        match response.status() {
            StatusCode::UNAUTHORIZED => return Err(Failure::auth("Wrong username or password.")),
            status if !status.is_success() => {
                return Err(Failure::server(format!("Jellyfin refused the sign-in ({status}).")))
            }
            _ => {}
        }

        let body: Value = response
            .json()
            .await
            .map_err(|_| Failure::server("Jellyfin sent an unreadable sign-in response."))?;
        let token = body["AccessToken"].as_str().unwrap_or_default().to_string();
        let user_id = body["User"]["Id"].as_str().unwrap_or_default().to_string();
        let user_name = body["User"]["Name"].as_str().unwrap_or(username).to_string();
        if token.is_empty() || user_id.is_empty() {
            return Err(Failure::server("Jellyfin sent an incomplete sign-in response."));
        }

        let device_id = {
            let mut saved = self.saved.write().unwrap();
            saved.server = Some(server.clone());
            saved.user_id = Some(user_id.clone());
            saved.user_name = Some(user_name.clone());
            saved.device_id.clone()
        };
        self.persist();
        // If this fails the session still works until the app closes, and the page says so.
        let remembered = secrets::save(&self.config_dir, &device_id, &token);
        *self.session.write().unwrap() = Some(Session {
            server: server.clone(),
            token,
            user_id: user_id.clone(),
            user_name: user_name.clone(),
        });
        Ok(SessionView { server, user_id, user_name, remembered })
    }

    pub fn session_view(&self) -> Option<SessionView> {
        self.session.read().unwrap().as_ref().map(|s| SessionView {
            server: s.server.clone(),
            user_id: s.user_id.clone(),
            user_name: s.user_name.clone(),
            remembered: true,
        })
    }

    /// Server and token for the live connection.
    pub fn live_target(&self) -> Option<(String, String)> {
        self.session.read().unwrap().as_ref().map(|s| (s.server.clone(), s.token.clone()))
    }

    pub fn settings(&self) -> Settings {
        self.saved.read().unwrap().settings.clone()
    }

    pub fn set_settings(&self, settings: Settings) {
        self.saved.write().unwrap().settings = settings;
        self.persist();
    }

    pub fn last_server(&self) -> Option<String> {
        self.saved.read().unwrap().server.clone()
    }

    pub async fn sign_out(&self) {
        if let Ok(session) = self.session() {
            let request = self.request(&session, Method::POST, "/Sessions/Logout");
            let _ = request.send().await;
        }
        *self.session.write().unwrap() = None;
        let device_id = {
            let mut saved = self.saved.write().unwrap();
            saved.user_id = None;
            saved.user_name = None;
            saved.device_id.clone()
        };
        self.persist();
        secrets::clear(&self.config_dir, &device_id);
    }

    /// Read-only access for the page, limited to the routes it uses.
    pub async fn get(&self, path: &str, query: &[(String, String)]) -> Result<Value, Failure> {
        let allowed = path == "/Items"
            || READABLE_PATHS.iter().any(|p| path.starts_with(p))
            || is_item_route(path);
        if !allowed || path.contains("..") {
            return Err(Failure::server(format!("Blocked request to {path}.")));
        }
        let session = self.session()?;
        let mut response = self
            .send(self.request(&session, Method::GET, path).query(query), &session.server)
            .await?;

        // Servers before 10.9 only have the older resume route.
        if response.status() == StatusCode::NOT_FOUND && path == "/UserItems/Resume" {
            let legacy = format!("/Users/{}/Items/Resume", session.user_id);
            response = self
                .send(self.request(&session, Method::GET, &legacy).query(query), &session.server)
                .await?;
        }
        if response.status() == StatusCode::NOT_FOUND {
            return Err(Failure::server("Jellyfin couldn't find that item."));
        }
        response
            .json()
            .await
            .map_err(|_| Failure::server("Jellyfin sent an unreadable response."))
    }

    pub async fn set_played(&self, item_id: &str, played: bool) -> Result<(), Failure> {
        if !is_item_id(item_id) {
            return Err(Failure::server("Invalid episode."));
        }
        let session = self.session()?;
        let method = if played { Method::POST } else { Method::DELETE };
        let path = format!("/UserPlayedItems/{item_id}");
        let response = self
            .send(
                self.request(&session, method.clone(), &path)
                    .query(&[("userId", session.user_id.as_str())]),
                &session.server,
            )
            .await?;
        if response.status() == StatusCode::NOT_FOUND {
            // Servers before 10.9 use the older route.
            let legacy = format!("/Users/{}/PlayedItems/{item_id}", session.user_id);
            let response = self
                .send(self.request(&session, method, &legacy), &session.server)
                .await?;
            if response.status() == StatusCode::NOT_FOUND {
                return Err(Failure::server("Jellyfin couldn't find that episode."));
            }
        }
        Ok(())
    }

    pub fn details_url(&self, item_id: &str) -> Result<String, Failure> {
        if !is_item_id(item_id) {
            return Err(Failure::server("Invalid item."));
        }
        let session = self.session()?;
        Ok(format!("{}/web/#/details?id={item_id}", session.server))
    }

    /// `path` is `/{itemId}/{imageType}`; only `maxHeight` or `maxWidth` pass through.
    pub async fn image(&self, path: &str, query: &str) -> Result<(String, Vec<u8>), Failure> {
        let mut parts = path.trim_start_matches('/').split('/');
        let (Some(id), Some(kind), None) = (parts.next(), parts.next(), parts.next()) else {
            return Err(Failure::server("Bad image path."));
        };
        if !is_item_id(id) || !IMAGE_TYPES.contains(&kind) {
            return Err(Failure::server("Bad image path."));
        }
        let size: Vec<(&str, &str)> = query
            .split('&')
            .filter_map(|pair| pair.split_once('='))
            .filter(|(k, v)| matches!(*k, "maxHeight" | "maxWidth") && v.chars().all(|c| c.is_ascii_digit()))
            .collect();

        let session = self.session()?;
        let route = format!("/Items/{id}/Images/{kind}");
        let response = self
            .send(self.request(&session, Method::GET, &route).query(&size), &session.server)
            .await?;
        if !response.status().is_success() {
            return Err(Failure::server("No image."));
        }
        let content_type = response
            .headers()
            .get("content-type")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("image/jpeg")
            .to_string();
        let bytes = response
            .bytes()
            .await
            .map_err(|_| Failure::network("Image download failed."))?;
        Ok((content_type, bytes.to_vec()))
    }
}

#[cfg(test)]
mod tests {
    use super::is_item_route;

    #[test]
    fn item_routes() {
        let id = "0123456789abcdef0123456789abcdef";
        assert!(is_item_route(&format!("/Items/{id}")));
        assert!(is_item_route(&format!("/Items/{id}/Similar")));
        assert!(!is_item_route(&format!("/Items/{id}/Download")));
        assert!(!is_item_route(&format!("/Items/{id}/Similar/x")));
        assert!(!is_item_route("/Items/../System"));
        assert!(!is_item_route("/Library/Items"));
    }
}
