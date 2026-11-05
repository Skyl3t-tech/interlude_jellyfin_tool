//! Air dates and full episode lists from TMDB. Jellyfin's own data can't say
//! what has aired but isn't in the library, so this fills that gap.
//! TMDB only has dates, so exact air times come from TVmaze when it knows the show.

use crate::jellyfin::{secrets, Failure};
use reqwest::{Client, RequestBuilder, StatusCode};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{Mutex, RwLock},
    time::{Duration, Instant},
};

const SECRET_NAME: &str = "tmdb-key";
const CACHE_FOR: Duration = Duration::from_secs(6 * 60 * 60);
/// TMDB allows at most 20 appended sub-requests per call.
const APPEND_LIMIT: usize = 20;
/// TVmaze allows about 20 calls per 10 seconds.
const TVMAZE_SPACING: Duration = Duration::from_millis(600);
/// A TVmaze time is only used when its date is this close to TMDB's,
/// so a show numbered differently on the two sites can't get the wrong time.
const MAX_DATE_GAP_DAYS: i64 = 2;

pub struct Tmdb {
    client: Client,
    base: String,
    tvmaze_base: String,
    tvmaze_last: tokio::sync::Mutex<Option<Instant>>,
    dir: PathBuf,
    key: RwLock<Option<String>>,
    cache: Mutex<HashMap<u64, (Instant, Value)>>,
}

impl Tmdb {
    pub fn load(dir: PathBuf) -> Self {
        // Tests point this at a stand-in server; release builds always use TMDB.
        let base = if cfg!(debug_assertions) {
            std::env::var("INTERLUDE_TMDB_URL").unwrap_or_else(|_| "https://api.themoviedb.org/3".into())
        } else {
            "https://api.themoviedb.org/3".into()
        };
        let tvmaze_base = if cfg!(debug_assertions) {
            std::env::var("INTERLUDE_TVMAZE_URL").unwrap_or_else(|_| "https://api.tvmaze.com".into())
        } else {
            "https://api.tvmaze.com".into()
        };
        Self {
            client: Client::builder().timeout(Duration::from_secs(15)).build().expect("HTTP client"),
            base,
            tvmaze_base,
            tvmaze_last: tokio::sync::Mutex::new(None),
            key: RwLock::new(secrets::load(&dir, SECRET_NAME)),
            dir,
            cache: Mutex::new(HashMap::new()),
        }
    }

    pub fn has_key(&self) -> bool {
        self.key.read().unwrap().is_some()
    }

    /// Accepts either the short API key or the long read access token.
    fn request(&self, key: &str, path: &str) -> RequestBuilder {
        let request = self.client.get(format!("{}{path}", self.base));
        if key.starts_with("eyJ") {
            request.bearer_auth(key)
        } else {
            request.query(&[("api_key", key)])
        }
    }

    async fn fetch(&self, key: &str, path: &str, query: &[(&str, &str)]) -> Result<Value, Failure> {
        let response = self
            .request(key, path)
            .query(query)
            .send()
            .await
            .map_err(|_| Failure::network("Can't reach TMDB. Check your internet connection."))?;
        match response.status() {
            StatusCode::UNAUTHORIZED => Err(Failure::tmdb_auth("TMDB didn't accept your API key. Check it in Settings.")),
            StatusCode::NOT_FOUND => Err(Failure::server("TMDB has no show with this ID.")),
            StatusCode::TOO_MANY_REQUESTS => Err(Failure::network("TMDB is rate-limiting requests. Try again in a minute.")),
            status if !status.is_success() => Err(Failure::server(format!("TMDB returned an error ({status})."))),
            _ => response
                .json()
                .await
                .map_err(|_| Failure::server("TMDB sent an unreadable response.")),
        }
    }

    pub async fn set_key(&self, key: &str) -> Result<(), Failure> {
        let key = key.trim();
        if key.is_empty() {
            return Err(Failure::tmdb_auth("Paste your TMDB API key first."));
        }
        self.fetch(key, "/configuration", &[]).await.map_err(|e| match e.kind {
            "tmdbauth" => Failure::tmdb_auth("TMDB didn't accept this key. Copy the API key from your TMDB account settings."),
            _ => e,
        })?;
        let _ = secrets::save(&self.dir, SECRET_NAME, key);
        *self.key.write().unwrap() = Some(key.to_string());
        self.cache.lock().unwrap().clear();
        Ok(())
    }

    pub fn clear_key(&self) {
        secrets::clear(&self.dir, SECRET_NAME);
        *self.key.write().unwrap() = None;
        self.cache.lock().unwrap().clear();
    }

    /// Status, next episode and every regular episode with its air date.
    pub async fn show(&self, id: u64) -> Result<Value, Failure> {
        if let Some((at, value)) = self.cache.lock().unwrap().get(&id) {
            if at.elapsed() < CACHE_FOR {
                return Ok(value.clone());
            }
        }
        let key = self
            .key
            .read()
            .unwrap()
            .clone()
            .ok_or_else(|| Failure::tmdb_auth("Add your TMDB API key in Settings."))?;

        let path = format!("/tv/{id}");
        let details = self.fetch(&key, &path, &[("append_to_response", "external_ids")]).await?;
        let times = self.air_times(&details["external_ids"]).await;
        let stamp = |season: &Value, number: &Value, date: &Value| -> Value {
            let (Some(s), Some(n)) = (season.as_u64(), number.as_u64()) else { return Value::Null };
            match times.get(&(s, n)) {
                Some((airstamp, airdate)) if dates_close(date.as_str(), airdate) => json!(airstamp),
                _ => Value::Null,
            }
        };
        let seasons: Vec<u64> = details["seasons"]
            .as_array()
            .map(|list| {
                list.iter()
                    .filter_map(|s| s["season_number"].as_u64())
                    .filter(|n| *n > 0)
                    .collect()
            })
            .unwrap_or_default();

        let mut episodes = Vec::new();
        for chunk in seasons.chunks(APPEND_LIMIT) {
            let append = chunk.iter().map(|n| format!("season/{n}")).collect::<Vec<_>>().join(",");
            let body = self.fetch(&key, &path, &[("append_to_response", &append)]).await?;
            for n in chunk {
                for ep in body[format!("season/{n}")]["episodes"].as_array().into_iter().flatten() {
                    episodes.push(json!({
                        "season": ep["season_number"],
                        "number": ep["episode_number"],
                        "name": ep["name"],
                        "airDate": ep["air_date"],
                        "airstamp": stamp(&ep["season_number"], &ep["episode_number"], &ep["air_date"]),
                    }));
                }
            }
        }

        let next = &details["next_episode_to_air"];
        let value = json!({
            "id": id,
            "name": details["name"],
            "status": details["status"],
            "next": if next.is_object() {
                json!({
                    "season": next["season_number"],
                    "number": next["episode_number"],
                    "name": next["name"],
                    "airDate": next["air_date"],
                    "airstamp": stamp(&next["season_number"], &next["episode_number"], &next["air_date"]),
                })
            } else {
                Value::Null
            },
            "episodes": episodes,
        });
        self.cache.lock().unwrap().insert(id, (Instant::now(), value.clone()));
        Ok(value)
    }

    async fn tvmaze_get(&self, path: &str, query: &[(&str, &str)]) -> Option<Value> {
        let mut last = self.tvmaze_last.lock().await;
        if let Some(at) = *last {
            let wait = TVMAZE_SPACING.saturating_sub(at.elapsed());
            if !wait.is_zero() {
                tokio::time::sleep(wait).await;
            }
        }
        let response = self.client.get(format!("{}{path}", self.tvmaze_base)).query(query).send().await;
        *last = Some(Instant::now());
        let response = response.ok()?;
        if !response.status().is_success() {
            return None;
        }
        response.json().await.ok()
    }

    /// (season, episode) to (UTC air time, air date) from TVmaze, matched by TVDB or IMDb ID.
    /// Empty when TVmaze doesn't know the show; dates alone are used then.
    async fn air_times(&self, ids: &Value) -> HashMap<(u64, u64), (String, String)> {
        let mut show = None;
        if let Some(tvdb) = ids["tvdb_id"].as_u64() {
            show = self.tvmaze_get("/lookup/shows", &[("thetvdb", &tvdb.to_string())]).await;
        }
        if show.is_none() {
            if let Some(imdb) = ids["imdb_id"].as_str().filter(|s| !s.is_empty()) {
                show = self.tvmaze_get("/lookup/shows", &[("imdb", imdb)]).await;
            }
        }
        let Some(id) = show.and_then(|s| s["id"].as_u64()) else {
            return HashMap::new();
        };
        let episodes = self.tvmaze_get(&format!("/shows/{id}/episodes"), &[]).await.unwrap_or_default();
        episodes
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|ep| {
                let stamp = ep["airstamp"].as_str().filter(|s| !s.is_empty())?;
                Some((
                    (ep["season"].as_u64()?, ep["number"].as_u64()?),
                    (stamp.to_string(), ep["airdate"].as_str().unwrap_or_default().to_string()),
                ))
            })
            .collect()
    }
}

/// Days since 1970-01-01 for a "YYYY-MM-DD" date.
fn day_number(date: &str) -> Option<i64> {
    let mut parts = date.split('-').map(|p| p.parse::<i64>().ok());
    let (y, m, d) = (parts.next()??, parts.next()??, parts.next()??);
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    Some(era * 146_097 + doe - 719_468)
}

fn dates_close(tmdb: Option<&str>, tvmaze: &str) -> bool {
    match (tmdb.and_then(day_number), day_number(tvmaze)) {
        (Some(a), Some(b)) => (a - b).abs() <= MAX_DATE_GAP_DAYS,
        (None, _) => true,
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates() {
        assert_eq!(day_number("1970-01-01"), Some(0));
        assert_eq!(day_number("2026-11-05"), Some(20_762));
        assert!(dates_close(Some("2026-11-05"), "2026-11-06"));
        assert!(!dates_close(Some("2026-11-05"), "2026-11-09"));
        assert!(dates_close(None, "2026-11-09"));
    }
}
