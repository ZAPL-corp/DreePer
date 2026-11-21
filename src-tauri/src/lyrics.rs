use crate::ai::{self, AiConfig};
use serde::{Deserialize, Serialize};
use std::time::Duration;

const UA: &str = "Dreeper/0.1 (music player; lyrics lookup)";

#[derive(Deserialize, Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct LyricsQuery {
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub album: String,
    #[serde(default)]
    pub duration: f64,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Lyrics {
    /// ok | notfound | error
    pub status: String,
    /// lrclib | lyricsovh | ai | ""
    pub source: String,
    pub plain: String,
    pub synced: String,
    pub matched: String,
    pub note: String,
    pub instrumental: bool,
    pub provider: String,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(UA)
        .build()
        .map_err(|e| e.to_string())
}

fn enc(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.as_bytes() {
        match *b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn norm(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_bracket = false;
    for ch in s.to_lowercase().chars() {
        match ch {
            '(' | '[' => in_bracket = true,
            ')' | ']' => {
                in_bracket = false;
                out.push(' ')
            }
            _ if in_bracket => {}
            c if c.is_alphanumeric() => out.push(c),
            _ => out.push(' '),
        }
    }
    let joined = out.split_whitespace().collect::<Vec<_>>().join(" ");
    // «песня feat xyz» -> «песня»
    joined
        .replace(" feat ", " ")
        .replace(" ft ", " ")
        .replace(" remaster", "")
        .replace(" remastered", "")
        .trim()
        .to_string()
}

#[derive(Deserialize, Debug, Default)]
#[serde(rename_all = "camelCase")]
struct LrcEntry {
    #[serde(default)]
    track_name: String,
    #[serde(default)]
    artist_name: String,
    #[serde(default)]
    album_name: String,
    #[serde(default)]
    duration: f64,
    #[serde(default)]
    instrumental: bool,
    #[serde(default)]
    plain_lyrics: Option<String>,
    #[serde(default)]
    synced_lyrics: Option<String>,
}

fn score(entry: &LrcEntry, q: &LyricsQuery) -> i32 {
    let mut s = 0;
    let want_t = norm(&q.title);
    let got_t = norm(&entry.track_name);
    if !want_t.is_empty() {
        if want_t == got_t {
            s += 100;
        } else if got_t.contains(&want_t) || want_t.contains(&got_t) {
            s += 45;
        }
    }
    let want_a = norm(&q.artist);
    let got_a = norm(&entry.artist_name);
    if !want_a.is_empty() && !got_a.is_empty() {
        if want_a == got_a {
            s += 60;
        } else if got_a.contains(&want_a) || want_a.contains(&got_a) {
            s += 30;
        }
    }
    if q.duration > 1.0 && entry.duration > 1.0 {
        let diff = (q.duration - entry.duration).abs();
        if diff < 2.0 {
            s += 35;
        } else if diff < 6.0 {
            s += 18;
        } else if diff > 40.0 {
            s -= 25;
        }
    }
    if !q.album.is_empty() && norm(&q.album) == norm(&entry.album_name) {
        s += 10;
    }
    if entry.synced_lyrics.as_deref().map(|v| !v.trim().is_empty()).unwrap_or(false) {
        s += 8;
    }
    s
}

fn from_entry(entry: &LrcEntry) -> Option<Lyrics> {
    let plain = entry.plain_lyrics.clone().unwrap_or_default();
    let synced = entry.synced_lyrics.clone().unwrap_or_default();
    if plain.trim().is_empty() && synced.trim().is_empty() {
        return None;
    }
    Some(Lyrics {
        status: "ok".into(),
        source: "lrclib".into(),
        plain,
        synced,
        matched: format!("{} — {}", entry.artist_name.trim(), entry.track_name.trim()),
        note: String::new(),
        instrumental: entry.instrumental,
        provider: String::new(),
    })
}

async fn lrclib(q: &LyricsQuery) -> Option<Lyrics> {
    let c = client().ok()?;

    // 1. точный запрос
    if !q.artist.trim().is_empty() && !q.title.trim().is_empty() {
        let mut url = format!(
            "https://lrclib.net/api/get?artist_name={}&track_name={}",
            enc(q.artist.trim()),
            enc(q.title.trim())
        );
        if !q.album.trim().is_empty() {
            url.push_str(&format!("&album_name={}", enc(q.album.trim())));
        }
        if q.duration > 1.0 {
            url.push_str(&format!("&duration={}", q.duration.round() as i64));
        }
        if let Ok(resp) = c.get(&url).send().await {
            if resp.status().is_success() {
                if let Ok(entry) = resp.json::<LrcEntry>().await {
                    if let Some(l) = from_entry(&entry) {
                        return Some(l);
                    }
                }
            }
        }
    }

    // 2. поиск с выбором лучшего совпадения
    let needle = format!("{} {}", q.artist.trim(), q.title.trim());
    let needle = needle.trim();
    if needle.is_empty() {
        return None;
    }
    let url = format!("https://lrclib.net/api/search?q={}", enc(needle));
    let resp = c.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let list: Vec<LrcEntry> = resp.json().await.ok()?;
    let best = list
        .iter()
        .map(|e| (score(e, q), e))
        .filter(|(s, e)| {
            *s >= 40
                && (e.plain_lyrics.as_deref().map(|v| !v.trim().is_empty()).unwrap_or(false)
                    || e.synced_lyrics.as_deref().map(|v| !v.trim().is_empty()).unwrap_or(false))
        })
        .max_by_key(|(s, _)| *s)
        .map(|(_, e)| e)?;
    from_entry(best)
}

async fn lyrics_ovh(q: &LyricsQuery) -> Option<Lyrics> {
    if q.artist.trim().is_empty() || q.title.trim().is_empty() {
        return None;
    }
    let url = format!(
        "https://api.lyrics.ovh/v1/{}/{}",
        enc(q.artist.trim()),
        enc(q.title.trim())
    );
    let resp = client().ok()?.get(&url).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let value: serde_json::Value = resp.json().await.ok()?;
    let text = value["lyrics"].as_str()?.trim().to_string();
    if text.is_empty() {
        return None;
    }
    Some(Lyrics {
        status: "ok".into(),
        source: "lyricsovh".into(),
        plain: text,
        synced: String::new(),
        matched: format!("{} — {}", q.artist.trim(), q.title.trim()),
        note: String::new(),
        instrumental: false,
        provider: String::new(),
    })
}

pub async fn lookup(q: LyricsQuery, cfg: AiConfig, force: bool) -> Lyrics {
    let _ = force;

    if let Some(l) = lrclib(&q).await {
        return l;
    }
    if let Some(mut l) = lyrics_ovh(&q).await {
        l.note = "Точный текст найден в открытой базе Lyrics.ovh (без синхронизации).".into();
        return l;
    }

    // агент: уточняем название и пробуем ещё раз
    if cfg.enabled() {
        if let Some((artist, title)) = ai::identify(&cfg, &q.title, &q.artist).await {
            let better = LyricsQuery {
                title: title.clone(),
                artist: if artist.trim().is_empty() { q.artist.clone() } else { artist.clone() },
                album: String::new(),
                duration: q.duration,
            };
            let changed = norm(&better.title) != norm(&q.title) || norm(&better.artist) != norm(&q.artist);
            if let Some(mut l) = lrclib(&better).await {
                l.note = format!(
                    "{} уточнил поиск: «{} — {}».",
                    provider_name(&cfg),
                    better.artist.trim(),
                    better.title.trim()
                );
                return l;
            }
            if changed {
                if let Some(mut l) = lyrics_ovh(&better).await {
                    l.note = format!(
                        "{} уточнил поиск: «{} — {}».",
                        provider_name(&cfg),
                        better.artist.trim(),
                        better.title.trim()
                    );
                    return l;
                }
            }
        }

        if cfg.allow_generated {
            if let Some(text) = ai::context(&cfg, &q.title, &q.artist).await {
                if !text.trim().is_empty() {
                    return Lyrics {
                        status: "ok".into(),
                        source: "ai".into(),
                        plain: text,
                        synced: String::new(),
                        matched: format!("{} — {}", q.artist.trim(), q.title.trim()),
                        note: "Точного текста нет в открытых базах. Ниже — справка от ИИ (не дословный текст песни).".into(),
                        instrumental: false,
                        provider: provider_name(&cfg),
                    };
                }
            }
        }
    }

    Lyrics {
        status: "notfound".into(),
        source: String::new(),
        plain: String::new(),
        synced: String::new(),
        matched: String::new(),
        note: if cfg.enabled() {
            "Текст не найден. Можно включить ИИ-справку в настройках.".into()
        } else {
            "Текст не найден в открытых базах. Подключите ИИ-агента в настройках, чтобы он попробовал уточнить трек.".into()
        },
        instrumental: false,
        provider: String::new(),
    }
}

fn provider_name(cfg: &AiConfig) -> String {
    match cfg.provider.as_str() {
        "ollama" => format!("Ollama · {}", cfg.ollama_model.trim()),
        "gigachat" => "GigaChat".to_string(),
        _ => "ИИ".to_string(),
    }
}
