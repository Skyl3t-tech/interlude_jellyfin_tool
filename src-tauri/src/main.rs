#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ignored;
mod jellyfin;
mod live;
mod tmdb;

use jellyfin::{Failure, Jellyfin, ServerInfo, SessionView, Settings};
use serde::Serialize;
use serde_json::Value;
use tauri::http::{header, Response, StatusCode};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, State, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_notification::NotificationExt;
use ignored::Ignored;
use live::Live;
use std::collections::HashMap;
use tauri_plugin_opener::OpenerExt;
use tauri_plugin_updater::UpdaterExt;
use tmdb::Tmdb;

const STARTED_BY_WINDOWS: &str = "--minimized";
const TMDB_KEY_PAGE: &str = "https://www.themoviedb.org/settings/api";

fn show_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SettingsView {
    #[serde(flatten)]
    settings: Settings,
    autostart: bool,
    tmdb: bool,
}

#[tauri::command]
fn get_settings(app: AppHandle, jf: State<'_, Jellyfin>, tmdb: State<'_, Tmdb>) -> SettingsView {
    SettingsView {
        settings: jf.settings(),
        autostart: app.autolaunch().is_enabled().unwrap_or(false),
        tmdb: tmdb.has_key(),
    }
}

#[tauri::command]
fn set_settings(
    settings: Settings,
    autostart: bool,
    app: AppHandle,
    jf: State<'_, Jellyfin>,
) -> Result<(), Failure> {
    jf.set_settings(settings);
    let launcher = app.autolaunch();
    let result = if autostart { launcher.enable() } else { launcher.disable() };
    result.map_err(|e| Failure::server(format!("Couldn't change the Windows startup setting: {e}")))
}

#[tauri::command]
async fn set_tmdb_key(key: String, tmdb: State<'_, Tmdb>) -> Result<(), Failure> {
    tmdb.set_key(&key).await
}

#[tauri::command]
fn clear_tmdb_key(tmdb: State<'_, Tmdb>) {
    tmdb.clear_key();
}

#[tauri::command]
async fn tmdb_show(id: u64, tmdb: State<'_, Tmdb>) -> Result<Value, Failure> {
    tmdb.show(id).await
}

#[tauri::command]
fn open_tmdb_key_page(app: AppHandle) -> Result<(), Failure> {
    app.opener()
        .open_url(TMDB_KEY_PAGE, None::<&str>)
        .map_err(|e| Failure::server(format!("Can't open your browser: {e}")))
}

#[tauri::command]
fn notify(title: String, body: String, app: AppHandle) -> Result<(), Failure> {
    app.notification()
        .builder()
        .title(title)
        .body(body)
        .show()
        .map_err(|e| Failure::server(format!("Couldn't show a notification: {e}")))
}

#[tauri::command]
fn get_ignored(ignored: State<'_, Ignored>) -> HashMap<String, Vec<String>> {
    ignored.all()
}

#[tauri::command]
fn set_ignored(series_id: String, episodes: Vec<String>, ignored: State<'_, Ignored>) -> Result<(), Failure> {
    if ignored.set(series_id, episodes) {
        Ok(())
    } else {
        Err(Failure::server("Couldn't save the ignored episodes."))
    }
}

#[tauri::command]
fn live_connected(live: State<'_, Live>) -> bool {
    live.is_connected()
}

fn start_live(app: &AppHandle) {
    if let Some((server, token)) = app.state::<Jellyfin>().live_target() {
        app.state::<Live>().start(app.clone(), server, token);
    }
}

#[derive(Serialize)]
struct UpdateInfo {
    version: String,
    notes: Option<String>,
}

fn update_failure(error: tauri_plugin_updater::Error) -> Failure {
    match error {
        // Local builds have no update address; only GitHub release builds do.
        tauri_plugin_updater::Error::EmptyEndpoints => Failure {
            kind: "noupdates",
            message: "This copy was built on your PC, so it doesn't update itself.".into(),
        },
        other => Failure::network(format!("Couldn't check for updates: {other}")),
    }
}

fn updater(app: &AppHandle) -> Result<tauri_plugin_updater::Updater, Failure> {
    // Tests point debug builds at a stand-in update feed.
    if cfg!(debug_assertions) {
        if let Some(url) = std::env::var("INTERLUDE_UPDATE_URL").ok().and_then(|u| u.parse().ok()) {
            return app
                .updater_builder()
                .endpoints(vec![url])
                .and_then(|b| b.build())
                .map_err(update_failure);
        }
    }
    app.updater().map_err(update_failure)
}

#[tauri::command]
async fn check_update(app: AppHandle) -> Result<Option<UpdateInfo>, Failure> {
    let updater = updater(&app)?;
    let update = updater.check().await.map_err(update_failure)?;
    Ok(update.map(|u| UpdateInfo { version: u.version, notes: u.body }))
}

#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), Failure> {
    let updater = updater(&app)?;
    let update = updater
        .check()
        .await
        .map_err(update_failure)?
        .ok_or_else(|| Failure::server("There's no update to install."))?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|e| Failure::network(format!("The update didn't install: {e}")))?;
    app.restart();
}

#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

#[tauri::command]
async fn server_info(url: String, jf: State<'_, Jellyfin>) -> Result<ServerInfo, Failure> {
    jf.server_info(&url).await
}

#[tauri::command]
async fn sign_in(
    url: String,
    username: String,
    password: String,
    jf: State<'_, Jellyfin>,
    app: AppHandle,
) -> Result<SessionView, Failure> {
    let session = jf.sign_in(&url, &username, &password).await?;
    start_live(&app);
    Ok(session)
}

#[tauri::command]
fn current_session(jf: State<'_, Jellyfin>) -> Option<SessionView> {
    jf.session_view()
}

#[tauri::command]
fn last_server(jf: State<'_, Jellyfin>) -> Option<String> {
    jf.last_server()
}

#[tauri::command]
async fn sign_out(jf: State<'_, Jellyfin>, live: State<'_, Live>) -> Result<(), Failure> {
    live.stop();
    jf.sign_out().await;
    Ok(())
}

#[tauri::command]
async fn jf_get(
    path: String,
    query: Vec<(String, String)>,
    jf: State<'_, Jellyfin>,
) -> Result<Value, Failure> {
    jf.get(&path, &query).await
}

#[tauri::command]
async fn set_played(
    item_id: String,
    played: bool,
    jf: State<'_, Jellyfin>,
) -> Result<(), Failure> {
    jf.set_played(&item_id, played).await
}

#[tauri::command]
fn open_in_jellyfin(
    item_id: String,
    jf: State<'_, Jellyfin>,
    app: tauri::AppHandle,
) -> Result<(), Failure> {
    let url = jf.details_url(&item_id)?;
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| Failure::server(format!("Can't open your browser: {e}")))
}

fn main() {
    tauri::Builder::default()
        // A second launch (say, from the Start menu while in the tray) shows the open window.
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_window(app)))
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![STARTED_BY_WINDOWS]),
        ))
        .setup(|app| {
            let dir = app.path().app_config_dir()?;
            app.manage(Jellyfin::load(dir.clone()));
            app.manage(Tmdb::load(dir.clone()));
            app.manage(Ignored::load(dir));
            app.manage(Live::new());
            start_live(app.handle());

            let open = MenuItem::with_id(app, "open", "Open Interlude", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit Interlude", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().expect("app icon").clone())
                .tooltip("Interlude")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_window(tray.app_handle());
                    }
                })
                .build(app)?;

            // Started with Windows: stay in the tray. Otherwise open the window.
            if !std::env::args().any(|a| a == STARTED_BY_WINDOWS) {
                show_window(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.state::<Jellyfin>().settings().tray {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        // Posters go through Rust so the token never reaches the page.
        .register_asynchronous_uri_scheme_protocol("jfimg", |ctx, request, responder| {
            let app = ctx.app_handle().clone();
            let path = request.uri().path().to_string();
            let query = request.uri().query().unwrap_or("").to_string();
            tauri::async_runtime::spawn(async move {
                let jf = app.state::<Jellyfin>();
                let response = match jf.image(&path, &query).await {
                    Ok((kind, bytes)) => Response::builder()
                        .header(header::CONTENT_TYPE, kind)
                        .header(header::CACHE_CONTROL, "max-age=86400")
                        .body(bytes),
                    Err(_) => Response::builder()
                        .status(StatusCode::NOT_FOUND)
                        .body(Vec::new()),
                };
                if let Ok(response) = response {
                    responder.respond(response);
                }
            });
        })
        .invoke_handler(tauri::generate_handler![
            server_info,
            sign_in,
            current_session,
            last_server,
            sign_out,
            jf_get,
            set_played,
            open_in_jellyfin,
            get_settings,
            set_settings,
            set_tmdb_key,
            clear_tmdb_key,
            tmdb_show,
            open_tmdb_key_page,
            notify,
            get_ignored,
            set_ignored,
            live_connected,
            check_update,
            install_update,
            app_version
        ])
        .run(tauri::generate_context!())
        .expect("Interlude failed to start");
}
