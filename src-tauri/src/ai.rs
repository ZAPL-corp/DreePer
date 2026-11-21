use serde::Deserialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};

#[derive(Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct AiConfig {
    pub provider: String,
    #[serde(default)]
    pub ollama_url: String,
    #[serde(default)]
    pub ollama_model: String,
    #[serde(default)]
    pub gigachat_key: String,
    #[serde(default)]
    pub allow_generated: bool,
}

impl AiConfig {
    pub fn enabled(&self) -> bool {
        match self.provider.as_str() {
            "ollama" => !self.ollama_url.trim().is_empty() && !self.ollama_model.trim().is_empty(),
            "gigachat" => !self.gigachat_key.trim().is_empty(),
            _ => false,
        }
    }

    fn client(&self, secs: u64) -> Result<reqwest::Client, String> {
        reqwest::Client::builder()
            .timeout(Duration::from_secs(secs))
            .build()
            .map_err(|e| e.to_string())
    }
}

static GIGA_TOKEN: Mutex<Option<(String, Instant)>> = Mutex::new(None);

fn pseudo_uuid() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let a = (nanos >> 64) as u32 ^ 0x6f31_7c1d;
    let b = (nanos >> 32) as u32;
    let c = nanos as u32;
    format!(
        "{:08x}-{:04x}-4{:03x}-8{:03x}-{:012x}",
        a,
        b >> 16,
        b & 0x0fff,
        c >> 20,
        (nanos as u64) & 0xffff_ffff_ffff
    )
}

async fn gigachat_token(cfg: &AiConfig) -> Result<String, String> {
    if let Ok(guard) = GIGA_TOKEN.lock() {
        if let Some((token, until)) = guard.as_ref() {
            if *until > Instant::now() {
                return Ok(token.clone());
            }
        }
    }

    let client = cfg.client(30)?;
    let resp = client
        .post("https://ngw.devices.sberbank.ru:9443/api/v2/oauth")
        .header("Authorization", format!("Basic {}", cfg.gigachat_key.trim()))
        .header("RqUID", pseudo_uuid())
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Accept", "application/json")
        .body("scope=GIGACHAT_API_PERS")
        .send()
        .await
        .map_err(|e| format!("GigaChat: нет связи с сервером авторизации ({e})"))?;

    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!(
            "GigaChat отклонил ключ авторизации (HTTP {status}). Проверьте «Ключ авторизации» в настройках."
        ));
    }

    #[derive(Deserialize)]
    struct TokenResp {
        access_token: String,
        #[serde(default)]
        expires_at: i64,
    }
    let parsed: TokenResp = serde_json::from_str(&body)
        .map_err(|_| "GigaChat: не удалось разобрать ответ авторизации".to_string())?;

    let ttl = parsed.expires_at
        - chrono_like_now_ms() as i64;
    let _ = ttl;
    if let Ok(mut guard) = GIGA_TOKEN.lock() {
        *guard = Some((parsed.access_token.clone(), Instant::now() + Duration::from_secs(25 * 60)));
    }
    Ok(parsed.access_token)
}

fn chrono_like_now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0)
}

async fn ollama_chat(cfg: &AiConfig, system: &str, prompt: &str) -> Result<String, String> {
    let url = format!("{}/api/chat", cfg.ollama_url.trim().trim_end_matches('/'));
    let body = serde_json::json!({
        "model": cfg.ollama_model.trim(),
        "stream": false,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt}
        ],
        "options": {"temperature": 0.2}
    });
    let resp = cfg
        .client(90)?
        .post(url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Ollama недоступна по адресу {}: {e}", cfg.ollama_url))?;
    if !resp.status().is_success() {
        return Err(format!(
            "Ollama ответила HTTP {}. Проверьте, что модель «{}» загружена (ollama pull {}).",
            resp.status(),
            cfg.ollama_model,
            cfg.ollama_model
        ));
    }
    let value: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    value["message"]["content"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "Ollama вернула пустой ответ".to_string())
}

async fn gigachat_chat(cfg: &AiConfig, system: &str, prompt: &str) -> Result<String, String> {
    let token = gigachat_token(cfg).await?;
    let body = serde_json::json!({
        "model": "GigaChat",
        "temperature": 0.2,
        "stream": false,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": prompt}
        ]
    });
    let resp = cfg
        .client(90)?
        .post("https://gigachat.devices.sberbank.ru/api/v1/chat/completions")
        .bearer_auth(token)
        .header("Accept", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("GigaChat: ошибка запроса ({e})"))?;
    if !resp.status().is_success() {
        return Err(format!("GigaChat вернул HTTP {}", resp.status()));
    }
    let value: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    value["choices"][0]["message"]["content"]
        .as_str()
        .map(|s| s.to_string())
        .ok_or_else(|| "GigaChat вернул пустой ответ".to_string())
}

pub async fn chat(cfg: &AiConfig, system: &str, prompt: &str) -> Result<String, String> {
    match cfg.provider.as_str() {
        "ollama" => ollama_chat(cfg, system, prompt).await,
        "gigachat" => gigachat_chat(cfg, system, prompt).await,
        _ => Err("ИИ-провайдер не выбран".to_string()),
    }
}

/// Проверка доступности провайдера для окна настроек.
pub async fn probe(cfg: &AiConfig) -> serde_json::Value {
    if !cfg.enabled() {
        return serde_json::json!({"ok": false, "detail": "Провайдер не настроен"});
    }
    let result = chat(
        cfg,
        "Отвечай одним словом.",
        "Ответь словом: работает",
    )
    .await;
    match result {
        Ok(text) => serde_json::json!({"ok": true, "detail": text.trim().chars().take(160).collect::<String>()}),
        Err(e) => serde_json::json!({"ok": false, "detail": e}),
    }
}

/// Просим модель угадать чистые исполнителя и название по «грязному» имени файла.
pub async fn identify(cfg: &AiConfig, raw_title: &str, raw_artist: &str) -> Option<(String, String)> {
    let system = "Ты помощник музыкального плеера. Ты определяешь исполнителя и название трека по имени файла. Отвечай строго JSON без пояснений.";
    let prompt = format!(
        "Имя файла/тег: название = \"{raw_title}\", исполнитель = \"{raw_artist}\".\n\
         Верни JSON вида {{\"artist\": \"...\", \"title\": \"...\"}} — каноническое название песни и исполнителя. \
         Если не знаешь трек, верни пустые строки."
    );
    let text = chat(cfg, system, &prompt).await.ok()?;
    let start = text.find('{')?;
    let end = text.rfind('}')?;
    let value: serde_json::Value = serde_json::from_str(text.get(start..=end)?).ok()?;
    let artist = value["artist"].as_str().unwrap_or("").trim().to_string();
    let title = value["title"].as_str().unwrap_or("").trim().to_string();
    if title.is_empty() {
        None
    } else {
        Some((artist, title))
    }
}

/// Когда точного текста нет в базах — ИИ даёт контекст трека (не дословный текст).
pub async fn context(cfg: &AiConfig, title: &str, artist: &str) -> Option<String> {
    let system = "Ты музыкальный редактор. Пишешь кратко, по делу, без воды и без дословного воспроизведения текста песни.";
    let prompt = format!(
        "Трек: «{title}» — {artist}.\n\
         Если знаешь этот трек, напиши по-русски:\n\
         1) одна строка: жанр, год, альбом;\n\
         2) «О чём песня» — 3–5 предложений о теме и настроении;\n\
         3) «Ключевые образы» — 2–3 короткие фразы-образа (не цитаты целиком).\n\
         Если трек тебе неизвестен, честно напиши: «Трек мне неизвестен»."
    );
    chat(cfg, system, &prompt).await.ok()
}
