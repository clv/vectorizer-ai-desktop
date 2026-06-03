use std::{
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
    time::Duration,
};

use directories::{ProjectDirs, UserDirs};
use reqwest::{header::HeaderMap, multipart, StatusCode};
use serde::{Deserialize, Serialize};

const DEFAULT_API_URL: &str = "https://api.vectorizer.ai/api/v1";
const DEFAULT_WEB_URL: &str = "https://vectorizer.ai";
const KEYRING_SERVICE: &str = "Vectorizer.AI Desktop";
const KEYRING_ACCOUNT: &str = "api-secret";
const IMAGE_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "gif", "bmp", "tif", "tiff"];
static KEYRING_INIT: OnceLock<Result<(), String>> = OnceLock::new();

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtraParam {
    key: String,
    value: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AppSettings {
    api_url: String,
    api_id: String,
    output_dir: Option<String>,
    output_format: String,
    mode: String,
    retain_for_review: bool,
    retention_days: u32,
    max_pixels: Option<u32>,
    overwrite: bool,
    extra_params: Vec<ExtraParam>,
}

impl Default for AppSettings {
    fn default() -> Self {
        Self {
            api_url: DEFAULT_API_URL.to_string(),
            api_id: String::new(),
            output_dir: default_output_dir_inner(),
            output_format: "svg".to_string(),
            mode: "production".to_string(),
            retain_for_review: true,
            retention_days: 1,
            max_pixels: None,
            overwrite: false,
            extra_params: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct SavedCredentialStatus {
    api_id: String,
    has_secret: bool,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct FileEntry {
    path: String,
    name: String,
    size: u64,
    extension: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiAuth {
    api_id: String,
    api_secret: Option<String>,
    use_saved_secret: bool,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AccountStatusRequest {
    auth: ApiAuth,
    api_url: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountStatusResponse {
    raw_json: serde_json::Value,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VectorizeRequest {
    auth: ApiAuth,
    api_url: String,
    input_path: String,
    output_dir: String,
    output_format: String,
    mode: String,
    retain_for_review: bool,
    retention_days: u32,
    max_pixels: Option<u32>,
    overwrite: bool,
    extra_params: Vec<ExtraParam>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VectorizeResult {
    output_path: String,
    image_token: Option<String>,
    receipt: Option<String>,
    credits_charged: Option<String>,
    credits_calculated: Option<String>,
    review_url: Option<String>,
}

fn project_dirs() -> Result<ProjectDirs, String> {
    ProjectDirs::from("ai", "Vectorizer", "Vectorizer.AI Desktop")
        .ok_or_else(|| "Could not determine the application settings directory.".to_string())
}

fn settings_path() -> Result<PathBuf, String> {
    Ok(project_dirs()?.config_dir().join("settings.json"))
}

fn default_output_dir_inner() -> Option<String> {
    UserDirs::new()
        .and_then(|dirs| dirs.download_dir().map(Path::to_path_buf))
        .map(path_to_string)
}

fn path_to_string(path: PathBuf) -> String {
    path.to_string_lossy().to_string()
}

fn ensure_keyring_store() -> Result<(), String> {
    KEYRING_INIT
        .get_or_init(|| {
            keyring::use_native_store(true)
                .map_err(|err| format!("Could not initialize the OS credential store: {err}"))
        })
        .clone()
}

fn keyring_entry() -> Result<keyring_core::Entry, String> {
    ensure_keyring_store()?;
    keyring_core::Entry::new(KEYRING_SERVICE, KEYRING_ACCOUNT)
        .map_err(|err| format!("Could not access the OS credential store: {err}"))
}

fn saved_secret_exists() -> bool {
    keyring_entry()
        .and_then(|entry| entry.get_password().map_err(|err| err.to_string()))
        .map(|secret| !secret.trim().is_empty())
        .unwrap_or(false)
}

fn load_saved_secret() -> Result<String, String> {
    let secret = keyring_entry()?
        .get_password()
        .map_err(|err| format!("No saved API Secret is available: {err}"))?;
    if secret.trim().is_empty() {
        Err("The saved API Secret is empty.".to_string())
    } else {
        Ok(secret)
    }
}

fn resolve_secret(auth: &ApiAuth) -> Result<String, String> {
    if let Some(secret) = auth.api_secret.as_ref().map(|value| value.trim()).filter(|value| !value.is_empty()) {
        Ok(secret.to_string())
    } else if auth.use_saved_secret {
        load_saved_secret()
    } else {
        Err("Enter an API Secret or enable the saved API Secret.".to_string())
    }
}

fn require_api_id(auth: &ApiAuth) -> Result<String, String> {
    let api_id = auth.api_id.trim();
    if api_id.is_empty() {
        Err("Enter your Vectorizer.AI API Id.".to_string())
    } else {
        Ok(api_id.to_string())
    }
}

fn normalize_api_url(api_url: &str) -> String {
    let trimmed = api_url.trim().trim_end_matches('/');
    if trimmed.is_empty() {
        DEFAULT_API_URL.to_string()
    } else {
        trimmed.to_string()
    }
}

fn is_image_file(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| IMAGE_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn describe_file(path: &Path) -> Result<FileEntry, String> {
    let metadata = fs::metadata(path).map_err(|err| format!("Could not read {}: {err}", path.display()))?;
    if !metadata.is_file() {
        return Err(format!("{} is not a file.", path.display()));
    }
    Ok(FileEntry {
        path: path_to_string(path.to_path_buf()),
        name: path.file_name().and_then(|name| name.to_str()).unwrap_or("image").to_string(),
        size: metadata.len(),
        extension: path.extension().and_then(|ext| ext.to_str()).unwrap_or("").to_ascii_lowercase(),
    })
}

fn collect_images_inner(path: &Path, out: &mut Vec<FileEntry>) -> Result<(), String> {
    let metadata = fs::metadata(path).map_err(|err| format!("Could not inspect {}: {err}", path.display()))?;
    if metadata.is_file() {
        if is_image_file(path) {
            out.push(describe_file(path)?);
        }
        return Ok(());
    }
    if metadata.is_dir() {
        let mut entries: Vec<PathBuf> = fs::read_dir(path)
            .map_err(|err| format!("Could not read directory {}: {err}", path.display()))?
            .filter_map(|entry| entry.ok().map(|entry| entry.path()))
            .collect();
        entries.sort();
        for entry in entries {
            collect_images_inner(&entry, out)?;
        }
    }
    Ok(())
}

fn build_output_path(input_path: &Path, output_dir: &Path, output_format: &str, overwrite: bool) -> PathBuf {
    let stem = input_path.file_stem().and_then(|stem| stem.to_str()).unwrap_or("vectorized");
    let extension = output_format.trim().trim_start_matches('.').to_ascii_lowercase();
    let mut candidate = output_dir.join(format!("{stem}.{extension}"));
    if overwrite || !candidate.exists() {
        return candidate;
    }
    for index in 2..10_000 {
        candidate = output_dir.join(format!("{stem}-{index}.{extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    output_dir.join(format!("{stem}-{}.{}", unix_timestamp(), extension))
}

fn unix_timestamp() -> String {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs().to_string())
        .unwrap_or_else(|_| "now".to_string())
}

fn header_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .filter(|value| !value.trim().is_empty())
        .map(|value| value.to_string())
}

fn error_body(status: StatusCode, body: &[u8]) -> String {
    let text = String::from_utf8_lossy(body);
    if let Ok(json) = serde_json::from_slice::<serde_json::Value>(body) {
        format!("Vectorizer.AI returned HTTP {status}: {json}")
    } else {
        format!("Vectorizer.AI returned HTTP {status}: {text}")
    }
}

#[tauri::command]
fn load_settings() -> Result<AppSettings, String> {
    let path = settings_path()?;
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let text = fs::read_to_string(&path)
        .map_err(|err| format!("Could not read settings from {}: {err}", path.display()))?;
    serde_json::from_str(&text)
        .map_err(|err| format!("Could not parse settings from {}: {err}", path.display()))
}

#[tauri::command]
fn save_settings(settings: AppSettings) -> Result<(), String> {
    let path = settings_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|err| format!("Could not create settings directory {}: {err}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(&settings).map_err(|err| err.to_string())?;
    fs::write(&path, text).map_err(|err| format!("Could not write settings to {}: {err}", path.display()))
}

#[tauri::command]
fn default_output_dir() -> Option<String> {
    default_output_dir_inner()
}

#[tauri::command]
fn saved_credentials_status() -> Result<SavedCredentialStatus, String> {
    let settings = load_settings().unwrap_or_default();
    Ok(SavedCredentialStatus {
        api_id: settings.api_id,
        has_secret: saved_secret_exists(),
    })
}

#[tauri::command]
fn save_credentials(api_id: String, api_secret: String) -> Result<SavedCredentialStatus, String> {
    let api_id = api_id.trim().to_string();
    let api_secret = api_secret.trim().to_string();
    if api_id.is_empty() {
        return Err("Enter your Vectorizer.AI API Id before saving credentials.".to_string());
    }
    if api_secret.is_empty() {
        return Err("Enter your Vectorizer.AI API Secret before saving credentials.".to_string());
    }
    keyring_entry()?
        .set_password(&api_secret)
        .map_err(|err| format!("Could not save API Secret in the OS credential store: {err}"))?;
    let mut settings = load_settings().unwrap_or_default();
    settings.api_id = api_id.clone();
    save_settings(settings)?;
    Ok(SavedCredentialStatus {
        api_id,
        has_secret: true,
    })
}

#[tauri::command]
fn clear_saved_credentials() -> Result<SavedCredentialStatus, String> {
    if let Ok(entry) = keyring_entry() {
        let _ = entry.delete_credential();
    }
    let mut settings = load_settings().unwrap_or_default();
    settings.api_id.clear();
    save_settings(settings)?;
    Ok(SavedCredentialStatus {
        api_id: String::new(),
        has_secret: false,
    })
}

#[tauri::command]
fn collect_images(paths: Vec<String>) -> Result<Vec<FileEntry>, String> {
    let mut files = Vec::new();
    for path in paths {
        collect_images_inner(Path::new(&path), &mut files)?;
    }
    files.sort_by(|a, b| a.path.cmp(&b.path));
    files.dedup_by(|a, b| a.path == b.path);
    Ok(files)
}

#[tauri::command]
async fn account_status(request: AccountStatusRequest) -> Result<AccountStatusResponse, String> {
    let api_id = require_api_id(&request.auth)?;
    let api_secret = resolve_secret(&request.auth)?;
    let url = format!("{}/account", normalize_api_url(&request.api_url));
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(60))
        .build()
        .map_err(|err| err.to_string())?;
    let response = client
        .get(url)
        .basic_auth(api_id, Some(api_secret))
        .send()
        .await
        .map_err(|err| format!("Could not contact Vectorizer.AI: {err}"))?;
    let status = response.status();
    let body = response.bytes().await.map_err(|err| err.to_string())?;
    if !status.is_success() {
        return Err(error_body(status, &body));
    }
    let raw_json = serde_json::from_slice::<serde_json::Value>(&body)
        .map_err(|err| format!("Account response was not valid JSON: {err}"))?;
    Ok(AccountStatusResponse { raw_json })
}

#[tauri::command]
async fn vectorize_file(request: VectorizeRequest) -> Result<VectorizeResult, String> {
    let api_id = require_api_id(&request.auth)?;
    let api_secret = resolve_secret(&request.auth)?;
    let input_path = PathBuf::from(&request.input_path);
    let output_dir = PathBuf::from(&request.output_dir);
    if !input_path.is_file() {
        return Err(format!("Input file does not exist: {}", input_path.display()));
    }
    if !output_dir.is_dir() {
        return Err(format!("Output folder does not exist: {}", output_dir.display()));
    }
    let output_format = request.output_format.trim().trim_start_matches('.').to_ascii_lowercase();
    if output_format.is_empty() {
        return Err("Choose an output format.".to_string());
    }

    let bytes = fs::read(&input_path)
        .map_err(|err| format!("Could not read input file {}: {err}", input_path.display()))?;
    let file_name = input_path.file_name().and_then(|name| name.to_str()).unwrap_or("image").to_string();
    let mime = mime_guess::from_path(&input_path).first_or_octet_stream().to_string();
    let image_part = multipart::Part::bytes(bytes)
        .file_name(file_name)
        .mime_str(&mime)
        .map_err(|err| err.to_string())?;
    let mut form = multipart::Form::new()
        .part("image", image_part)
        .text("output.file_format", output_format.clone());

    if !request.mode.trim().is_empty() {
        form = form.text("mode", request.mode.trim().to_string());
    }
    if request.retain_for_review {
        form = form.text("policy.retention_days", request.retention_days.max(1).to_string());
    }
    if let Some(max_pixels) = request.max_pixels {
        if max_pixels > 0 {
            form = form.text("input.max_pixels", max_pixels.to_string());
        }
    }
    for param in request.extra_params {
        let key = param.key.trim();
        if !key.is_empty() {
            form = form.text(key.to_string(), param.value);
        }
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|err| err.to_string())?;
    let response = client
        .post(format!("{}/vectorize", normalize_api_url(&request.api_url)))
        .basic_auth(api_id, Some(api_secret))
        .multipart(form)
        .send()
        .await
        .map_err(|err| format!("Could not contact Vectorizer.AI: {err}"))?;
    let status = response.status();
    let headers = response.headers().clone();
    let body = response.bytes().await.map_err(|err| err.to_string())?;
    if !status.is_success() {
        return Err(error_body(status, &body));
    }

    let output_path = build_output_path(&input_path, &output_dir, &output_format, request.overwrite);
    fs::write(&output_path, &body)
        .map_err(|err| format!("Could not write output file {}: {err}", output_path.display()))?;

    let image_token = header_value(&headers, "x-image-token");
    let review_url = image_token
        .as_ref()
        .map(|token| format!("{DEFAULT_WEB_URL}/images/{token}"));

    Ok(VectorizeResult {
        output_path: path_to_string(output_path),
        image_token,
        receipt: header_value(&headers, "x-receipt"),
        credits_charged: header_value(&headers, "x-credits-charged"),
        credits_calculated: header_value(&headers, "x-credits-calculated"),
        review_url,
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            load_settings,
            save_settings,
            default_output_dir,
            saved_credentials_status,
            save_credentials,
            clear_saved_credentials,
            collect_images,
            account_status,
            vectorize_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
