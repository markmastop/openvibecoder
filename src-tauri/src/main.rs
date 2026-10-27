#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    fs,
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    sync::{mpsc, Mutex},
    time::Duration,
};
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

struct Backend {
    child: Mutex<Child>,
    endpoint: String,
    authorization: String,
    client: reqwest::Client,
}

#[derive(Deserialize)]
struct ClientRequest {
    path: String,
    method: String,
    body: Option<Value>,
}

#[derive(Serialize)]
struct ClientReply {
    status: u16,
    body: String,
}

fn allowed_request(method: &str, path: &str) -> bool {
    if path.contains(['\\', '#', '\r', '\n']) {
        return false;
    }
    if method == "GET" && ["/api/status", "/api/usage", "/api/models"].contains(&path) {
        return true;
    }
    if method == "POST" && ["/api/config", "/api/connection", "/api/runs", "/api/workspace-plan"].contains(&path) {
        return true;
    }
    let Some(rest) = path.strip_prefix("/api/runs/") else { return false };
    let (route, query) = rest.split_once('?').map_or((rest, None), |(r, q)| (r, Some(q)));
    let parts: Vec<_> = route.split('/').collect();
    let id = parts[0];
    if id.is_empty() || id.starts_with('.') || !id.bytes().all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c)) {
        return false;
    }
    match (method, parts.as_slice(), query) {
        ("GET", [_], None) => true,
        ("GET", [_, "file"], Some(q)) => q.starts_with("path="),
        ("POST", [_, "stop"], None) => true,
        ("GET", [_, "preview"], None) => true,
        ("GET", [_, "settings"], None) => true,
        ("POST", [_, "file" | "build" | "improve" | "settings" | "schema"], None) => true,
        _ => false,
    }
}

#[tauri::command]
async fn client_request(
    window: tauri::WebviewWindow,
    backend: tauri::State<'_, Backend>,
    request: ClientRequest,
) -> Result<ClientReply, String> {
    if window.label() != "main" || !allowed_request(&request.method, &request.path) {
        return Err("This action is not available in Open Vibe Coder.".into());
    }
    if request.body.as_ref().is_some_and(|b| b.to_string().len() > 120_000) {
        return Err("Request too large.".into());
    }
    let method = if request.method == "POST" { reqwest::Method::POST } else { reqwest::Method::GET };
    let mut call = backend.client.request(method, format!("{}{}", backend.endpoint, request.path))
        .header("Authorization", &backend.authorization);
    if let Some(body) = request.body { call = call.json(&body); }
    let response = call.send().await.map_err(|_| "The local build service is unreachable. Restart Open Vibe Coder.")?;
    let status = response.status().as_u16();
    let body = response.text().await.map_err(|_| "The local response could not be read.")?;
    Ok(ClientReply { status, body })
}

async fn run_preview_url(window: &tauri::WebviewWindow, backend: &Backend, id: &str) -> Result<tauri::Url, String> {
    let path = format!("/api/runs/{}/preview", id);
    if window.label() != "main" || !allowed_request("GET", &path) {
        return Err("Invalid preview.".into());
    }
    let response = backend.client.get(format!("{}{}", backend.endpoint, path))
        .header("Authorization", &backend.authorization).send().await.map_err(|_| "Preview unreachable")?;
    if !response.status().is_success() { return Err("No built app is available.".into()); }
    let data: Value = response.json().await.map_err(|_| "Invalid preview")?;
    let url: tauri::Url = data.get("url").and_then(Value::as_str).ok_or("Preview is missing")?
        .parse().map_err(|_| "Invalid preview URL")?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.port().is_none() {
        return Err("The preview must be local.".into());
    }
    Ok(url)
}

#[tauri::command]
async fn open_run_browser(window: tauri::WebviewWindow, app: tauri::AppHandle, backend: tauri::State<'_, Backend>, id: String) -> Result<(), String> {
    let url = run_preview_url(&window, &backend, &id).await?;
    app.opener().open_url(url.to_string(), None::<&str>).map_err(|_| "The browser could not be opened.".into())
}

#[tauri::command]
async fn open_run_preview(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    backend: tauri::State<'_, Backend>,
    id: String,
) -> Result<(), String> {
    let url = run_preview_url(&window, &backend, &id).await?;
    let label = format!("preview-{}", id);
    if let Some(existing) = app.get_webview_window(&label) { existing.navigate(url).map_err(|e| e.to_string())?; let _ = existing.set_focus(); return Ok(()); }
    let allowed = url.clone();
    tauri::WebviewWindowBuilder::new(&app, label, tauri::WebviewUrl::External(url))
        .title("Open Vibe Coder · app preview").inner_size(1200.0, 850.0)
        .on_navigation(move |next| next.scheme() == allowed.scheme() && next.host_str() == allowed.host_str() && next.port() == allowed.port() && next.path() == allowed.path())
        .build().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
async fn choose_project_folder(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    backend: tauri::State<'_, Backend>,
    suggested_name: String,
) -> Result<Option<Value>, String> {
    if window.label() != "main" { return Err("Directory selection is only available in Open Vibe Coder.".into()); }
    if suggested_name.is_empty() || suggested_name.len() > 60 || !suggested_name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-') { return Err("Enter a project name first.".into()); }
    let picked = tauri::async_runtime::spawn_blocking(move || app.dialog().file()
        .set_title("Choose the full location of your project directory")
        .set_file_name(suggested_name)
        .set_can_create_directories(false)
        .blocking_save_file()).await.map_err(|_| "Could not open the directory picker.")?;
    let Some(picked) = picked else { return Ok(None) };
    let path = picked.into_path().map_err(|_| "Invalid local directory.")?;
    let response = backend.client.post(format!("{}/internal/folder", backend.endpoint))
        .header("Authorization", &backend.authorization)
        .json(&serde_json::json!({"path":path})).send().await.map_err(|_| "Could not register the directory.")?;
    if !response.status().is_success() { return Err("This directory is unavailable.".into()); }
    Ok(Some(response.json().await.map_err(|_| "Invalid directory selection response.")?))
}

impl Backend {
    fn start(app: &tauri::App) -> Result<Self, Box<dyn std::error::Error>> {
        let resources = app.path().resource_dir()?;
        let data = app.path().app_local_data_dir()?;
        fs::create_dir_all(&data)?;
        #[cfg(unix)] {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&data, fs::Permissions::from_mode(0o700))?;
        }
        let runtime = if cfg!(debug_assertions) {
            let triple = if cfg!(target_os = "macos") {
                if cfg!(target_arch = "aarch64") { "aarch64-apple-darwin" } else { "x86_64-apple-darwin" }
            } else { "x86_64-pc-windows-msvc" };
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("binaries").join(format!("bim-node-{}{}", triple, if cfg!(windows) { ".exe" } else { "" }))
        } else {
            std::env::current_exe()?.parent().ok_or("App directory is missing")?.join(if cfg!(windows) { "bim-node.exe" } else { "bim-node" })
        };
        let backend_dir = if cfg!(debug_assertions) {
            std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.desktop-backend")
        } else { resources.join("backend") };
        let token = format!("{}{}", uuid::Uuid::new_v4(), uuid::Uuid::new_v4());
        let mut command = Command::new(runtime);
        command.arg(backend_dir.join("src/server/ui-server.mjs")).arg("--desktop")
            .current_dir(&backend_dir).env_clear()
            .env("BIM_DESKTOP_TOKEN", &token).env("BIM_CLIENT_DATA_DIR", &data)
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit());
        for key in ["PATH", "LANG", "LC_ALL", "SystemRoot", "WINDIR", "TEMP", "TMP"] {
            if let Some(value) = std::env::var_os(key) { command.env(key, value); }
        }
        #[cfg(windows)] {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000); // Geen apart consolevenster.
        }
        let mut child = command.spawn()?;
        let stdout = child.stdout.take().ok_or("Startup channel is missing")?;
        let (send, receive) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines().map_while(Result::ok) {
                if let Some(json) = line.strip_prefix("BIM_STUDIO_READY ") { let _ = send.send(json.to_owned()); }
            }
        });
        let ready = receive.recv_timeout(Duration::from_secs(15));
        let port = ready.ok().and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.get("port").and_then(Value::as_u64))
            .filter(|p| *p > 0 && *p <= 65535);
        let Some(port) = port else {
            let _ = child.kill();
            let _ = child.wait();
            return Err("The bundled build service could not start.".into());
        };
        Ok(Self {
            child: Mutex::new(child), endpoint: format!("http://127.0.0.1:{}", port),
            authorization: format!("Bearer {}", token),
            client: reqwest::Client::builder().no_proxy().timeout(Duration::from_secs(15)).build()?,
        })
    }

    fn stop(&self) {
        if let Ok(mut child) = self.child.lock() {
            drop(child.stdin.take()); // EOF laat Node de lopende proef stoppen en rapporten afronden.
            for _ in 0..50 {
                if child.try_wait().ok().flatten().is_some() { return; }
                std::thread::sleep(Duration::from_millis(50));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| { app.manage(Backend::start(app)?); Ok(()) })
        .invoke_handler(tauri::generate_handler![client_request, open_run_preview, open_run_browser, choose_project_folder])
        .build(tauri::generate_context!())
        .expect("Open Vibe Coder could not start");
    app.run(|handle, event| {
        if matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit) {
            handle.state::<Backend>().stop();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::allowed_request;
    #[test]
    fn bridge_only_accepts_pilot_actions() {
        assert!(allowed_request("GET", "/api/status"));
        assert!(allowed_request("GET", "/api/usage"));
        assert!(!allowed_request("POST", "/api/usage"));
        assert!(!allowed_request("POST", "/internal/folder"));
        assert!(allowed_request("POST", "/api/config"));
        assert!(allowed_request("GET", "/api/runs/project-a/settings"));
        assert!(allowed_request("GET", "/api/models"));
        assert!(allowed_request("POST", "/api/connection"));
        assert!(!allowed_request("GET", "/api/connection"));
        assert!(allowed_request("POST", "/api/runs/project-a/settings"));
        assert!(allowed_request("GET", "/api/runs/2026-10-18-a/file?path=basis-0%2Fapp.mjs"));
        assert!(allowed_request("POST", "/api/runs/2026-10-18-a/stop"));
        assert!(allowed_request("GET", "/api/runs/2026-10-18-a/preview"));
        assert!(!allowed_request("POST", "/api/runs/2026-10-18-a/preview"));
        assert!(allowed_request("POST", "/api/runs/2026-10-18-a/file"));
        assert!(allowed_request("POST", "/api/runs/2026-10-18-a/build"));
        assert!(allowed_request("POST", "/api/runs/2026-10-18-a/improve"));
        for (method, path) in [("GET", "https://example.com"), ("POST", "/api/status"), ("GET", "/.env.local"), ("GET", "/api/runs/../file?path=x"), ("DELETE", "/api/config")] {
            assert!(!allowed_request(method, path));
        }
    }
}
