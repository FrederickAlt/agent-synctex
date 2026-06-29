use serde::Deserialize;
use std::env;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Debug, Deserialize)]
struct ReadyLine {
    #[serde(rename = "type")]
    kind: String,
    app_url: String,
}

struct HostProcess {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
}

impl HostProcess {
    fn request_shutdown(&self) {
        if let Ok(mut stdin) = self.stdin.lock() {
            if let Some(mut handle) = stdin.take() {
                let _ = handle.write_all(b"shutdown\n");
                let _ = handle.flush();
            }
        }
    }
}

impl Drop for HostProcess {
    fn drop(&mut self) {
        self.request_shutdown();
        if let Ok(mut child) = self.child.lock() {
            if let Some(child) = child.as_mut() {
                for _ in 0..20 {
                    if !matches!(child.try_wait(), Ok(None)) {
                        return;
                    }
                    thread::sleep(Duration::from_millis(50));
                }
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    }
}

struct HostCommandConfig {
    command: String,
    args: Vec<String>,
}

fn host_args_from_env() -> Vec<String> {
    env::var("PDF_PREVIEW_VIEWER_HOST_ARGS")
        .map(|value| value.split_whitespace().map(str::to_string).collect())
        .unwrap_or_default()
}

fn host_command_config() -> Result<HostCommandConfig, String> {
    if let Ok(command) = env::var("PDF_PREVIEW_VIEWER_HOST_COMMAND") {
        if command.trim().is_empty() {
            return Err("PDF_PREVIEW_VIEWER_HOST_COMMAND must not be empty".to_string());
        }
        return Ok(HostCommandConfig {
            command,
            args: host_args_from_env(),
        });
    }

    if cfg!(debug_assertions) {
        return Ok(HostCommandConfig {
            command: "node".to_string(),
            args: vec!["../../../scripts/viewer-host-server.ts".to_string()],
        });
    }

    Err("PDF_PREVIEW_VIEWER_HOST_COMMAND is required for packaged builds; set it to an installed Viewer Host Server executable and optionally set PDF_PREVIEW_VIEWER_HOST_ARGS".to_string())
}

fn spawn_host_process() -> Result<(HostProcess, String), String> {
    let host = host_command_config()?;
    let mut child = Command::new(&host.command)
        .args(&host.args)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("failed to start Viewer Host Server: {error}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Viewer Host Server stdin was not available".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Viewer Host Server stdout was not available".to_string())?;

    let (sender, receiver) = mpsc::channel::<Result<ReadyLine, String>>();
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        let mut reported_startup = false;
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) => {
                    if !reported_startup {
                        let _ = sender.send(Err("Viewer Host Server exited before reporting ready".to_string()));
                    }
                    break;
                }
                Ok(_) if reported_startup => {}
                Ok(_) => {
                    reported_startup = true;
                    match serde_json::from_str::<ReadyLine>(&line) {
                        Ok(ready) if ready.kind == "ready" => {
                            let _ = sender.send(Ok(ready));
                        }
                        Ok(other) => {
                            let _ = sender.send(Err(format!("unexpected Viewer Host Server startup message: {}", other.kind)));
                        }
                        Err(error) => {
                            let _ = sender.send(Err(format!("invalid Viewer Host Server startup message: {error}")));
                        }
                    }
                }
                Err(error) => {
                    if !reported_startup {
                        let _ = sender.send(Err(format!("failed reading Viewer Host Server startup message: {error}")));
                    }
                    break;
                }
            }
        }
    });

    let ready = match receiver.recv_timeout(Duration::from_secs(10)) {
        Ok(Ok(ready)) => ready,
        Ok(Err(error)) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        Err(_) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err("timed out waiting for Viewer Host Server startup".to_string());
        }
    };

    Ok((
        HostProcess {
            child: Mutex::new(Some(child)),
            stdin: Mutex::new(Some(stdin)),
        },
        ready.app_url,
    ))
}

fn setup_error(message: impl Into<String>) -> Box<dyn std::error::Error> {
    std::io::Error::new(std::io::ErrorKind::Other, message.into()).into()
}

fn validate_host_app_url(app_url: &str) -> Result<tauri::Url, String> {
    let url = tauri::Url::parse(app_url)
        .map_err(|error| format!("Viewer Host Server reported invalid app_url: {error}"))?;
    if url.scheme() != "http" {
        return Err("Viewer Host Server app_url must use http".to_string());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("Viewer Host Server app_url must not include userinfo".to_string());
    }
    if url.host_str() != Some("127.0.0.1") {
        return Err("Viewer Host Server app_url must use 127.0.0.1".to_string());
    }
    if url.port().is_none() || url.port() == Some(0) {
        return Err("Viewer Host Server app_url must include a non-zero port".to_string());
    }
    if url.path() != "/app" {
        return Err("Viewer Host Server app_url path must be /app".to_string());
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err("Viewer Host Server app_url must not include query or fragment components".to_string());
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::validate_host_app_url;

    #[test]
    fn validate_host_app_url_accepts_strict_loopback_http_app_url() {
        let url = validate_host_app_url("http://127.0.0.1:1234/app").expect("strict loopback /app URL should be accepted");
        assert_eq!(url.as_str(), "http://127.0.0.1:1234/app");
    }

    #[test]
    fn validate_host_app_url_rejects_non_strict_urls() {
        for app_url in [
            "https://127.0.0.1:1234/app",
            "http://example.com:1234/app",
            "http://localhost:1234/app",
            "http://[::1]:1234/app",
            "http://127.0.0.1/app",
            "http://127.0.0.1:0/app",
            "http://127.0.0.1:1234/viewer",
            "http://127.0.0.1:1234/app?x=1",
            "http://127.0.0.1:1234/app#fragment",
            "http://user@127.0.0.1:1234/app",
            "http://user:pass@127.0.0.1:1234/app",
            "http://:pass@127.0.0.1:1234/app",
        ] {
            assert!(validate_host_app_url(app_url).is_err(), "{app_url} should be rejected");
        }
    }
}

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let (host_process, app_url) = spawn_host_process().map_err(setup_error)?;
            let url = validate_host_app_url(&app_url).map_err(setup_error)?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("PDF Preview Viewer")
                .build()?;
            app.manage(host_process);
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::CloseRequested { .. }) {
                if let Some(host) = window.app_handle().try_state::<HostProcess>() {
                    host.request_shutdown();
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build PDF Preview Viewer Tauri app")
        .run(|app_handle, event| {
            if matches!(event, tauri::RunEvent::ExitRequested { .. }) {
                if let Some(host) = app_handle.try_state::<HostProcess>() {
                    host.request_shutdown();
                }
            }
        });
}
