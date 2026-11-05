//! Missing episodes the user chose to ignore, per Jellyfin series ID.
//! Stored as "season:episode" keys in ignored.json next to the settings.

use std::{collections::HashMap, fs, path::PathBuf, sync::RwLock};

pub struct Ignored {
    path: PathBuf,
    map: RwLock<HashMap<String, Vec<String>>>,
}

impl Ignored {
    pub fn load(dir: PathBuf) -> Self {
        let path = dir.join("ignored.json");
        let map = fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self { path, map: RwLock::new(map) }
    }

    pub fn all(&self) -> HashMap<String, Vec<String>> {
        self.map.read().unwrap().clone()
    }

    /// An empty list removes the show.
    pub fn set(&self, series_id: String, episodes: Vec<String>) -> bool {
        let mut map = self.map.write().unwrap();
        if episodes.is_empty() {
            map.remove(&series_id);
        } else {
            map.insert(series_id, episodes);
        }
        serde_json::to_vec_pretty(&*map)
            .map(|bytes| fs::write(&self.path, bytes).is_ok())
            .unwrap_or(false)
    }
}
