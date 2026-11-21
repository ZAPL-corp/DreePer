use serde::{Deserialize, Serialize};
use std::path::Path;
use walkdir::WalkDir;

const AUDIO_EXT: &[&str] = &[
    "mp3", "flac", "wav", "m4a", "aac", "ogg", "opus", "wma", "aiff", "aif", "alac", "m4b",
];

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub path: String,
    pub file: String,
    pub title: String,
    pub artist: String,
    pub album: String,
    pub duration: f64,
    pub track_no: u32,
    pub disc_no: u32,
    pub year: u32,
    pub ext: String,
    pub size: u64,
}

fn ext_of(path: &Path) -> Option<String> {
    path.extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase())
        .filter(|e| AUDIO_EXT.contains(&e.as_str()))
}

/// «01 - Artist - Title» / «Artist_-_Title» -> (artist, title)
fn split_name(stem: &str) -> (String, String) {
    let cleaned = stem.replace('_', " ");
    let cleaned = cleaned.trim().trim_start_matches(|c: char| c.is_ascii_digit());
    let cleaned = cleaned.trim_start_matches(|c: char| c == ' ' || c == '-' || c == '.');
    if let Some((a, t)) = cleaned.split_once(" - ") {
        let a = a.trim();
        let t = t.trim();
        if !a.is_empty() && !t.is_empty() {
            return (a.to_string(), t.to_string());
        }
    }
    (String::new(), cleaned.trim().to_string())
}

pub fn read_track(path: &Path) -> Track {
    use lofty::file::TaggedFileExt;
    use lofty::tag::Accessor;

    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();
    let stem = path
        .file_stem()
        .and_then(|n| n.to_str())
        .unwrap_or_default()
        .to_string();
    let ext = ext_of(path).unwrap_or_default();
    let (file_artist, file_title) = split_name(&stem);

    let mut t = Track {
        id: path.to_string_lossy().to_string(),
        path: path.to_string_lossy().to_string(),
        file: file_name,
        title: file_title,
        artist: file_artist,
        album: String::new(),
        duration: 0.0,
        track_no: 0,
        disc_no: 0,
        year: 0,
        ext,
        size: std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
    };

    if let Ok(tagged) = lofty::read_from_path(path) {
        t.duration = tagged.properties().duration().as_secs_f64();
        if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
            if let Some(v) = tag.title().map(|v| v.to_string()).filter(|v| !v.trim().is_empty()) {
                t.title = v;
            }
            if let Some(v) = tag.artist().map(|v| v.to_string()).filter(|v| !v.trim().is_empty()) {
                t.artist = v;
            }
            if let Some(v) = tag.album().map(|v| v.to_string()).filter(|v| !v.trim().is_empty()) {
                t.album = v;
            }
            t.track_no = tag.track().unwrap_or(0);
            t.disc_no = tag.disk().unwrap_or(0);
            t.year = tag.year().unwrap_or(0);
        }
    }

    t
}

pub fn scan_folder(root: &str) -> Vec<Track> {
    let mut out = Vec::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .max_depth(12)
        .into_iter()
        .filter_entry(|e| {
            let name = e.file_name().to_string_lossy().to_lowercase();
            !(e.file_type().is_dir()
                && (name.starts_with('.') || name == "system volume information" || name == "$recycle.bin"))
        })
        .flatten()
    {
        if !entry.file_type().is_file() {
            continue;
        }
        if ext_of(entry.path()).is_some() {
            out.push(read_track(entry.path()));
        }
    }
    out.sort_by(|a, b| {
        a.album
            .to_lowercase()
            .cmp(&b.album.to_lowercase())
            .then(a.disc_no.cmp(&b.disc_no))
            .then(a.track_no.cmp(&b.track_no))
            .then(a.title.to_lowercase().cmp(&b.title.to_lowercase()))
    });
    out
}

/// Обложка трека как data-URL (jpg/png из тега).
pub fn cover_data_url(path: &str) -> Option<String> {
    use base64::Engine;
    use lofty::file::TaggedFileExt;

    let tagged = lofty::read_from_path(path).ok()?;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag())?;
    let pic = tag.pictures().first()?;
    let mime = pic
        .mime_type()
        .map(|m| m.to_string())
        .unwrap_or_else(|| "image/jpeg".to_string());
    let b64 = base64::engine::general_purpose::STANDARD.encode(pic.data());
    Some(format!("data:{mime};base64,{b64}"))
}
