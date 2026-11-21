use serde_json::Value;
use std::path::PathBuf;
use tauri::Manager;

fn state_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Не найден каталог данных: {e}"))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("Не удалось создать каталог: {e}"))?;
    Ok(dir.join("state.json"))
}

pub fn load(app: &tauri::AppHandle) -> Value {
    let Ok(path) = state_path(app) else {
        return Value::Object(Default::default());
    };
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_else(|| Value::Object(Default::default()))
}

pub fn save(app: &tauri::AppHandle, state: &Value) -> Result<(), String> {
    let path = state_path(app)?;
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_vec_pretty(state).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, body).map_err(|e| format!("Не удалось записать состояние: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("Не удалось сохранить состояние: {e}"))?;
    Ok(())
}
