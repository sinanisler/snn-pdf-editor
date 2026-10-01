// SNN PDF Editor desktop shell. The editor itself is the web page in ../src; this side only does what a
// page cannot: read and write files by path, and hand over the system fonts for embedding.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::Path;
use tauri::ipc::{InvokeBody, Request, Response};

#[tauri::command]
fn read_file(path: String) -> Result<Response, String> {
    std::fs::read(&path).map(Response::new).map_err(|e| e.to_string())
}

fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

// The PDF arrives as the raw request body and the target path as a percent-encoded header.
// Written to a temporary file first so a failed save can never leave a half-written PDF behind.
#[tauri::command]
fn write_file(request: Request<'_>) -> Result<(), String> {
    let path = request.headers().get("x-path").and_then(|v| v.to_str().ok()).map(percent_decode).ok_or("missing path")?;
    let InvokeBody::Raw(bytes) = request.body() else { return Err("expected file bytes".into()) };
    let tmp = format!("{path}.snn-tmp");
    std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        e.to_string()
    })
}

// A file passed on the command line, e.g. through "Open with".
#[tauri::command]
fn launch_file() -> Option<String> {
    std::env::args().nth(1).filter(|a| !a.starts_with('-') && Path::new(a).is_file())
}

// Arial, Times New Roman and Courier New (or their metric-compatible Liberation twins) so that
// text added in the editor is saved as real text in any language.
// Any other family name is looked up among the installed fonts, so edited text can keep the
// document's own typeface.
#[tauri::command(async)]
fn system_font(family: String, bold: bool, italic: bool) -> Result<Response, String> {
    let v = bold as usize + 2 * italic as usize;
    if !matches!(family.as_str(), "Helvetica" | "Times" | "Courier") {
        let path = installed_font(&family, v).ok_or("font not found")?.0;
        return std::fs::read(path).map(Response::new).map_err(|e| e.to_string());
    }
    let (win, mac, lin) = match family.as_str() {
        "Times" => (["times", "timesbd", "timesi", "timesbi"], "Times New Roman", "LiberationSerif"),
        "Courier" => (["cour", "courbd", "couri", "courbi"], "Courier New", "LiberationMono"),
        _ => (["arial", "arialbd", "ariali", "arialbi"], "Arial", "LiberationSans"),
    };
    let mac_style = ["", " Bold", " Italic", " Bold Italic"][v];
    let lin_style = ["Regular", "Bold", "Italic", "BoldItalic"][v];
    let windir = std::env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".into());
    let candidates = [
        format!("{windir}\\Fonts\\{}.ttf", win[v]),
        format!("/System/Library/Fonts/Supplemental/{mac}{mac_style}.ttf"),
        format!("/Library/Fonts/{mac}{mac_style}.ttf"),
        format!("/usr/share/fonts/truetype/liberation/{lin}-{lin_style}.ttf"),
        format!("/usr/share/fonts/liberation/{lin}-{lin_style}.ttf"),
    ];
    candidates.iter().find_map(|p| std::fs::read(p).ok()).map(Response::new).ok_or_else(|| "font not found".into())
}

// The installed font matching a PDF font name, as the family name to use for it.
// Runs off the main thread because the first call reads every installed font's names.
#[tauri::command(async)]
fn has_font(family: String) -> Option<String> {
    installed_font(&family, 0).map(|f| f.1)
}

struct FontEntry {
    keys: Vec<String>, // every name this font answers to, normalised
    family: String,    // the family name the system knows it by
    path: std::path::PathBuf,
}

// names are compared without spaces, hyphens or case: "EtihadAltis-Book" equals "Etihad Altis Book"
fn norm(s: &str) -> String {
    s.chars().filter(|c| c.is_alphanumeric()).flat_map(char::to_lowercase).collect()
}

// Reads a font file's own names: [family, style, full name, PostScript name].
fn font_names(path: &Path) -> Option<[String; 4]> {
    use std::io::{Read, Seek, SeekFrom};
    let mut f = std::fs::File::open(path).ok()?;
    let mut head = [0u8; 12];
    f.read_exact(&mut head).ok()?;
    let mut dir = vec![0u8; u16::from_be_bytes([head[4], head[5]]) as usize * 16];
    f.read_exact(&mut dir).ok()?;
    let rec = dir.chunks(16).find(|r| &r[0..4] == b"name")?;
    let len = u32::from_be_bytes(rec[12..16].try_into().ok()?) as usize;
    if len > 1 << 20 {
        return None;
    }
    let mut t = vec![0u8; len];
    f.seek(SeekFrom::Start(u32::from_be_bytes(rec[8..12].try_into().ok()?) as u64)).ok()?;
    f.read_exact(&mut t).ok()?;
    let be = |i: usize| -> Option<usize> { Some(u16::from_be_bytes([*t.get(i)?, *t.get(i + 1)?]) as usize) };
    let (count, strings) = (be(2)?, be(4)?);
    let mut out: [String; 4] = Default::default();
    let mut rank = [0u8; 4];
    for i in 0..count {
        let r = 6 + i * 12;
        let (platform, lang, id, l, o) = (be(r)?, be(r + 4)?, be(r + 6)?, be(r + 8)?, be(r + 10)?);
        let slot = match id {
            1 => 0,
            2 => 1,
            4 => 2,
            6 => 3,
            _ => continue,
        };
        let Some(raw) = t.get(strings + o..strings + o + l) else { continue };
        // prefer the Unicode English record, then any Unicode one, then the old Mac one
        let (text, score) = if platform == 3 || platform == 0 {
            let units: Vec<u16> = raw.chunks_exact(2).map(|c| u16::from_be_bytes([c[0], c[1]])).collect();
            (String::from_utf16_lossy(&units), if lang == 0x409 { 3 } else { 2 })
        } else {
            (raw.iter().map(|&b| b as char).collect(), 1)
        };
        if score > rank[slot] {
            rank[slot] = score;
            out[slot] = text;
        }
    }
    Some(out)
}

// Every installed .ttf/.otf, read once per run. Windows lists them in the registry, but its labels
// are unreliable ("Etihad Altis Book Book"), so each font is also indexed by the names inside the
// file. The PostScript name matters most: it is the name PDFs refer to fonts by.
// Collections (.ttc) are skipped because they can't be embedded as a single font.
#[cfg(windows)]
fn font_index() -> &'static Vec<FontEntry> {
    use winreg::{enums::*, RegKey};
    static INDEX: std::sync::OnceLock<Vec<FontEntry>> = std::sync::OnceLock::new();
    INDEX.get_or_init(|| {
        let mut index = Vec::new();
        let fonts_dir = Path::new(&std::env::var("WINDIR").unwrap_or_else(|_| "C:\\Windows".into())).join("Fonts");
        for hive in [HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE] {
            let Ok(key) = RegKey::predef(hive).open_subkey("SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Fonts") else { continue };
            for (name, _) in key.enum_values().flatten() {
                let Ok(file) = key.get_value::<String, _>(&name) else { continue };
                let lower = file.to_lowercase();
                if !(lower.ends_with(".ttf") || lower.ends_with(".otf")) {
                    continue;
                }
                let path = if Path::new(&file).is_absolute() { file.into() } else { fonts_dir.join(file) };
                let label = name.split(" (").next().unwrap_or("").trim().to_string();
                let [family, style, full, postscript] = font_names(&path).unwrap_or_default();
                let stem = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
                let mut keys: Vec<String> = [postscript, full, format!("{family}{style}"), label.clone(), stem].iter().map(|s| norm(s)).filter(|k| !k.is_empty()).collect();
                keys.dedup();
                index.push(FontEntry { keys, family: if family.is_empty() { label } else { family }, path });
            }
        }
        index
    })
}

#[cfg(not(windows))]
fn font_index() -> &'static Vec<FontEntry> {
    static INDEX: Vec<FontEntry> = Vec::new();
    &INDEX
}

// style: 0 regular, 1 bold, 2 italic, 3 bold italic
fn installed_font(family: &str, style: usize) -> Option<(std::path::PathBuf, String)> {
    let styles: &[&str] = [&["", "regular", "roman", "book", "normal"][..], &["bold"], &["italic", "oblique"], &["bolditalic", "boldoblique"]][style];
    let family = norm(family);
    if family.is_empty() {
        return None;
    }
    let wanted: Vec<String> = styles.iter().map(|s| format!("{family}{s}")).collect();
    font_index().iter().find(|f| f.keys.iter().any(|k| wanted.contains(k))).map(|f| (f.path.clone(), f.family.clone()))
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![read_file, write_file, launch_file, system_font, has_font])
        .setup(|app| {
            let config = app.config().app.windows[0].clone();
            let mut window = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?;
            // SNN_DEBUG_PORT=9333 lets the end-to-end test (test/app.e2e.mjs) attach to the window
            if let Some(port) = std::env::var("SNN_DEBUG_PORT").ok().and_then(|p| p.parse::<u16>().ok()) {
                window = window.additional_browser_args(&format!(
                    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port={port}"
                ));
            }
            window.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running SNN PDF Editor");
}
