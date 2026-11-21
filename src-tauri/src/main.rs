#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod lyrics;
mod scan;
mod store;

use lyrics::{Lyrics, LyricsQuery};
use serde_json::Value;
use tauri::Manager;

#[tauri::command]
fn load_state(app: tauri::AppHandle) -> Value {
    store::load(&app)
}

#[tauri::command]
fn save_state(app: tauri::AppHandle, state: Value) -> Result<(), String> {
    store::save(&app, &state)
}

#[tauri::command]
async fn scan_folder(path: String) -> Result<Vec<scan::Track>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let dir = std::path::Path::new(&path);
        if !dir.is_dir() {
            return Err(format!("Папка не найдена: {path}"));
        }
        Ok(scan::scan_folder(&path))
    })
    .await
    .map_err(|e| format!("Ошибка сканирования: {e}"))?
}

#[tauri::command]
async fn scan_files(paths: Vec<String>) -> Vec<scan::Track> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut out: Vec<scan::Track> = paths
            .iter()
            .map(std::path::Path::new)
            .filter(|p| p.is_file())
            .map(scan::read_track)
            .collect();
        out.sort_by(|a, b| a.track_no.cmp(&b.track_no).then(a.title.cmp(&b.title)));
        out
    })
    .await
    .unwrap_or_default()
}

#[tauri::command]
async fn cover(path: String) -> Option<String> {
    tauri::async_runtime::spawn_blocking(move || scan::cover_data_url(&path))
        .await
        .ok()
        .flatten()
}

#[tauri::command]
async fn lyrics_lookup(query: LyricsQuery, ai: ai::AiConfig, force: bool) -> Lyrics {
    lyrics::lookup(query, ai, force).await
}

#[tauri::command]
async fn ai_probe(ai: ai::AiConfig) -> Value {
    ai::probe(&ai).await
}

#[tauri::command]
fn state_dir(app: tauri::AppHandle) -> String {
    app.path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            load_state,
            save_state,
            scan_folder,
            scan_files,
            cover,
            lyrics_lookup,
            ai_probe,
            state_dir
        ])
        .run(tauri::generate_context!())
        .expect("Dreeper не смог запуститься");
}
