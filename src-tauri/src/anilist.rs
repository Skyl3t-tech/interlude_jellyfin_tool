//! Anime episode counts and broadcast times from AniList. AniList counts episodes
//! per entry (usually one per season or cour), the way anime metadata plugins
//! number them in Jellyfin, so anime that TMDB can't match can still be checked.
//! Public data needs no account; anonymous use allows about 30 requests a minute.

use crate::jellyfin::Failure;
use reqwest::{Client, StatusCode};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const CACHE_FOR: Duration = Duration::from_secs(60 * 60);
const SPACING: Duration = Duration::from_millis(2_100);
const BATCH: usize = 50;
const MAX_PAGES: i64 = 10;
/// Schedule window: recent episodes (for the grace period) and the coming weeks.
const LOOK_BACK_SECS: u64 = 2 * 86_400;
const LOOK_AHEAD_SECS: u64 = 30 * 86_400;

const QUERY: &str = r#"query ($ids: [Int], $since: Int, $until: Int, $page: Int) {
  entries: Page(perPage: 50) {
    media(id_in: $ids, type: ANIME) { id status episodes nextAiringEpisode { episode airingAt } }
  }
  schedule: Page(page: $page, perPage: 50) {
    pageInfo { hasNextPage }
    airingSchedules(mediaId_in: $ids, airingAt_greater: $since, airingAt_lesser: $until, sort: TIME) {
      mediaId episode airingAt
    }
  }
}"#;

const DETAILS_QUERY: &str = r#"query ($id: Int) {
  Media(id: $id, type: ANIME) {
    id siteUrl format season seasonYear episodes duration status averageScore genres
    title { romaji english native }
    description(asHtml: false)
    studios(isMain: true) { nodes { name } }
    characters(sort: [ROLE, RELEVANCE, ID], perPage: 16) {
      edges {
        role
        node { name { full } image { medium } }
        japanese: voiceActors(language: JAPANESE, sort: [RELEVANCE, ID]) { name { full } image { medium } }
        english: voiceActors(language: ENGLISH, sort: [RELEVANCE, ID]) { name { full } image { medium } }
      }
    }
  }
}"#;
const DETAILS_CACHE_FOR: Duration = Duration::from_secs(24 * 60 * 60);

pub struct AniList {
    client: Client,
    url: String,
    last: tokio::sync::Mutex<Option<Instant>>,
    cache: Mutex<HashMap<Vec<u64>, (Instant, Value)>>,
    details: Mutex<HashMap<u64, (Instant, Value)>>,
}

impl AniList {
    pub fn new() -> Self {
        let url = if cfg!(debug_assertions) {
            std::env::var("INTERLUDE_ANILIST_URL").unwrap_or_else(|_| "https://graphql.anilist.co".into())
        } else {
            "https://graphql.anilist.co".into()
        };
        Self {
            client: Client::builder().timeout(Duration::from_secs(20)).build().expect("HTTP client"),
            url,
            last: tokio::sync::Mutex::new(None),
            cache: Mutex::new(HashMap::new()),
            details: Mutex::new(HashMap::new()),
        }
    }

    async fn post(&self, variables: Value) -> Result<Value, Failure> {
        self.send(QUERY, variables).await
    }

    async fn send(&self, query: &str, variables: Value) -> Result<Value, Failure> {
        let mut last = self.last.lock().await;
        if let Some(at) = *last {
            let wait = SPACING.saturating_sub(at.elapsed());
            if !wait.is_zero() {
                tokio::time::sleep(wait).await;
            }
        }
        let response = self
            .client
            .post(&self.url)
            .json(&json!({ "query": query, "variables": variables }))
            .send()
            .await;
        *last = Some(Instant::now());
        let response = response.map_err(|_| Failure::network("Can't reach AniList. Check your internet connection."))?;
        match response.status() {
            StatusCode::TOO_MANY_REQUESTS => {
                return Err(Failure::network("AniList is rate-limiting requests. Anime data will refresh shortly."))
            }
            status if status.is_server_error() => {
                return Err(Failure::network(format!("AniList returned an error ({status}).")))
            }
            _ => {}
        }
        let body: Value = response
            .json()
            .await
            .map_err(|_| Failure::server("AniList sent an unreadable response."))?;
        if let Some(message) = body["errors"][0]["message"].as_str() {
            return Err(Failure::server(format!("AniList: {message}")));
        }
        Ok(body["data"].clone())
    }

    /// Status and episode counts for each entry, plus its airing times in a window around now.
    pub async fn entries(&self, mut ids: Vec<u64>) -> Result<Value, Failure> {
        ids.sort_unstable();
        ids.dedup();
        if let Some((at, value)) = self.cache.lock().unwrap().get(&ids) {
            if at.elapsed() < CACHE_FOR {
                return Ok(value.clone());
            }
        }
        let now = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0);
        let mut media = Vec::new();
        let mut schedule = Vec::new();
        for batch in ids.chunks(BATCH) {
            for page in 1..=MAX_PAGES {
                let data = self
                    .post(json!({
                        "ids": batch,
                        "since": now.saturating_sub(LOOK_BACK_SECS),
                        "until": now + LOOK_AHEAD_SECS,
                        "page": page,
                    }))
                    .await?;
                if page == 1 {
                    media.extend(data["entries"]["media"].as_array().cloned().unwrap_or_default());
                }
                schedule.extend(data["schedule"]["airingSchedules"].as_array().cloned().unwrap_or_default());
                if data["schedule"]["pageInfo"]["hasNextPage"].as_bool() != Some(true) {
                    break;
                }
            }
        }
        let value = json!({ "media": media, "schedule": schedule });
        self.cache.lock().unwrap().insert(ids, (Instant::now(), value.clone()));
        Ok(value)
    }

    /// Description, studio, score and characters with their voice actors, for the info card.
    pub async fn details(&self, id: u64) -> Result<Value, Failure> {
        if let Some((at, value)) = self.details.lock().unwrap().get(&id) {
            if at.elapsed() < DETAILS_CACHE_FOR {
                return Ok(value.clone());
            }
        }
        let data = self.send(DETAILS_QUERY, json!({ "id": id })).await?;
        let media = data["Media"].clone();
        if media.is_null() {
            return Err(Failure::server("AniList has no anime with this ID."));
        }
        self.details.lock().unwrap().insert(id, (Instant::now(), media.clone()));
        Ok(media)
    }
}
