# Interlude

A Windows app that shows where you are in every show on your Jellyfin server.

## Install and update

Releases are built by GitHub Actions (`.github/workflows/release.yml`) when the version in `src-tauri/tauri.conf.json` changes on `main`, or when you run the workflow from the Actions tab. Download the file ending in `-setup.exe` from the latest release and run it. It installs for your Windows account only, with no admin prompt. Installed copies check for updates every 6 hours and show a "Restart to update" banner.

To publish a new version: set the same version in `src-tauri/tauri.conf.json` and `src-tauri/Cargo.toml`, commit and push to `main`. The workflow tags the release `v<version>`.

The repository needs two Actions secrets (Settings > Secrets and variables > Actions):

- `TAURI_SIGNING_PRIVATE_KEY`: the contents of `interlude.key`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: its password

Updates are checked against the public key in `tauri.conf.json`, so only releases signed with that key install. Keep the private key safe: without it you can't publish updates.

`build.cmd` still builds a local `Interlude.exe` for testing. Local builds don't update themselves.

## Views

- Watching: shows in progress. Watching now means you watched an episode in the last 30 days; older ones are On hold. Caught up lists fully watched shows that are still airing. "New" marks episodes added to Jellyfin since you last watched the show.
- Upcoming: the next episodes, with exact times in your time zone: AniList for anime, TVmaze for other shows, otherwise TMDB's air date.
- Missing: aired episodes that aren't in Jellyfin. An episode with an exact time gets a day to reach your server before it counts. Shows that Jellyfin numbers differently from TMDB (common with anime) are listed under Couldn't check. Episodes from before the first one on your server are ignored automatically (a setting), and Ignore hides the rest of a show's current gaps.

## Data

Watch progress comes only from Jellyfin, which pushes changes over its WebSocket as they happen. Air dates and episode lists come from TMDB, and air times from TVmaze, cached for 6 hours.

Anime with an AniList ID in Jellyfin (set by the AniList metadata plugin, on the show or on each season) uses AniList instead: its episode counts per season or cour match how anime plugins number episodes, and it has exact broadcast times. AniList needs no account and is cached for an hour. A show with several seasons but only a show-level AniList ID falls back to TMDB, since it can't tell which season the ID belongs to. Your Jellyfin token and TMDB key are stored in Windows Credential Manager; ignored episodes in `ignored.json` in the app's settings folder.

## Test

`node --test tests/` checks the progress, TMDB and ignore logic. `cargo test` in `src-tauri` checks date matching. `node tests/mock-jellyfin.mjs` runs a fake Jellyfin (with live updates), TMDB, TVmaze and update feed on port 8096; see the top of that file for the variables a debug build reads.
