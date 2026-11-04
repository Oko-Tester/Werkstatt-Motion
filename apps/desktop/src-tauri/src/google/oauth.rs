//! Anmeldung bei Google im Browser (OAuth 2.0 für Desktop-Apps).
//!
//! Google empfiehlt für Desktop-Apps die Rückleitung an eine Adresse auf dem
//! eigenen Rechner (`http://127.0.0.1:<Port>/`) zusammen mit PKCE. Die App öffnet
//! den Browser, wartet auf dieser Adresse auf die Rückleitung und tauscht den Code
//! danach gegen den Zugang. Das Passwort sieht sie nie.

use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use reqwest::Url;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use zeroize::Zeroizing;

use super::{ClientCredentials, GoogleError, CALENDAR_SCOPE};
use crate::crypto;

const AUTH_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const MAX_REQUEST_BYTES: usize = 16 * 1024;
const REQUEST_READ_TIMEOUT: Duration = Duration::from_secs(5);
const POLL_INTERVAL: Duration = Duration::from_millis(200);

/// Eine begonnene Anmeldung: Der Anschluss auf dem eigenen Rechner ist offen, die
/// Adresse für den Browser steht fest.
pub struct AuthSession {
    pub listener: TcpListener,
    pub redirect_uri: String,
    pub url: String,
    pub verifier: Zeroizing<String>,
    pub state: String,
}

pub async fn begin(creds: &ClientCredentials) -> Result<AuthSession, GoogleError> {
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .await
        .map_err(|_| GoogleError::Local)?;
    let port = listener
        .local_addr()
        .map_err(|_| GoogleError::Local)?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/");
    let verifier = Zeroizing::new(URL_SAFE_NO_PAD.encode(crypto::random_bytes(48)));
    let state = URL_SAFE_NO_PAD.encode(crypto::random_bytes(24));
    let url = auth_url(creds, &redirect_uri, &pkce_challenge(&verifier), &state);
    Ok(AuthSession {
        listener,
        redirect_uri,
        url,
        verifier,
        state,
    })
}

/// PKCE nach RFC 7636, Verfahren S256.
pub fn pkce_challenge(verifier: &str) -> String {
    URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()))
}

pub fn auth_url(
    creds: &ClientCredentials,
    redirect_uri: &str,
    challenge: &str,
    state: &str,
) -> String {
    let mut url = Url::parse(AUTH_URL).expect("feste, gültige Adresse");
    url.query_pairs_mut()
        .append_pair("client_id", &creds.id)
        .append_pair("redirect_uri", redirect_uri)
        .append_pair("response_type", "code")
        .append_pair("scope", &format!("openid email {CALENDAR_SCOPE}"))
        .append_pair("code_challenge", challenge)
        .append_pair("code_challenge_method", "S256")
        .append_pair("state", state)
        // Dauerhafter Zugang (Refresh-Token), auch bei einer erneuten Anmeldung.
        .append_pair("access_type", "offline")
        .append_pair("prompt", "consent")
        .append_pair("hl", "de");
    url.to_string()
}

/// Was eine Anfrage an den Anschluss bedeutet.
#[derive(Debug, PartialEq, Eq)]
pub enum Callback {
    /// Rückleitung mit Code.
    Code(String),
    /// Rückleitung ohne Erlaubnis.
    Denied,
    /// Alles andere (falsche Adresse, fremder Aufruf, falscher `state`); Antwort mit diesem Status.
    NotForUs(u16),
}

pub fn evaluate_request(head: &str, expected_state: &str) -> Callback {
    let mut parts = head.lines().next().unwrap_or_default().split_whitespace();
    let (Some(method), Some(target)) = (parts.next(), parts.next()) else {
        return Callback::NotForUs(400);
    };
    if method != "GET" {
        return Callback::NotForUs(405);
    }
    if !target.starts_with('/') {
        return Callback::NotForUs(400);
    }
    let Ok(url) = Url::parse(&format!("http://127.0.0.1{target}")) else {
        return Callback::NotForUs(400);
    };
    if url.path() != "/" {
        return Callback::NotForUs(404);
    }
    let (mut code, mut state, mut error) = (None, None, false);
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "code" => code = Some(value.into_owned()),
            "state" => state = Some(value.into_owned()),
            "error" => error = true,
            _ => {}
        }
    }
    if state.as_deref() != Some(expected_state) {
        return Callback::NotForUs(400);
    }
    if error {
        return Callback::Denied;
    }
    match code {
        Some(code) if !code.is_empty() => Callback::Code(code),
        _ => Callback::NotForUs(400),
    }
}

/// Wartet auf die Rückleitung aus dem Browser. Andere Aufrufe des Anschlusses (etwa nach
/// einem Symbol der Seite) bekommen eine kurze Antwort und ändern nichts.
pub async fn await_callback(
    listener: &TcpListener,
    expected_state: &str,
    cancel: &AtomicBool,
    timeout: Duration,
) -> Result<String, GoogleError> {
    let deadline = Instant::now() + timeout;
    loop {
        if cancel.load(Ordering::SeqCst) {
            return Err(GoogleError::Cancelled);
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(GoogleError::Timeout);
        }
        let wait = (deadline - now).min(POLL_INTERVAL);
        match tokio::time::timeout(wait, listener.accept()).await {
            Err(_) => continue,
            Ok(Err(_)) => tokio::time::sleep(POLL_INTERVAL).await,
            Ok(Ok((mut stream, _))) => match answer(&mut stream, expected_state).await {
                Callback::Code(code) => return Ok(code),
                Callback::Denied => return Err(GoogleError::Denied),
                Callback::NotForUs(_) => continue,
            },
        }
    }
}

async fn answer(stream: &mut TcpStream, expected_state: &str) -> Callback {
    let head = read_head(stream).await.unwrap_or_default();
    let callback = evaluate_request(&head, expected_state);
    let response = match &callback {
        Callback::Code(_) => page(
            200,
            "Verbunden",
            "Werkstatt Motion ist jetzt mit Google Kalender verbunden. Du kannst dieses Fenster schließen.",
        ),
        Callback::Denied => page(
            200,
            "Nicht verbunden",
            "Der Zugriff wurde nicht erlaubt. Du kannst dieses Fenster schließen und es in \
             Werkstatt Motion noch einmal versuchen.",
        ),
        Callback::NotForUs(status) => page(
            *status,
            "Werkstatt Motion",
            "Diese Adresse gehört zur Anmeldung von Werkstatt Motion.",
        ),
    };
    let _ = stream.write_all(&response).await;
    let _ = stream.shutdown().await;
    callback
}

async fn read_head(stream: &mut TcpStream) -> Option<String> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 2048];
    let reading = async {
        loop {
            let read = stream.read(&mut chunk).await.ok()?;
            if read == 0 {
                return Some(());
            }
            buffer.extend_from_slice(&chunk[..read]);
            if buffer.windows(4).any(|window| window == b"\r\n\r\n")
                || buffer.len() >= MAX_REQUEST_BYTES
            {
                return Some(());
            }
        }
    };
    tokio::time::timeout(REQUEST_READ_TIMEOUT, reading)
        .await
        .ok()??;
    Some(String::from_utf8_lossy(&buffer).into_owned())
}

/// Kleine Seite für den Browser. Sie enthält nur feste Texte, nie etwas aus der Anfrage.
fn page(status: u16, title: &str, text: &str) -> Vec<u8> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        404 => "Not Found",
        405 => "Method Not Allowed",
        _ => "Error",
    };
    let body = format!(
        "<!doctype html><html lang=\"de\"><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\
         <title>{title}</title><style>\
         body{{margin:0;min-height:100vh;display:grid;place-items:center;\
         font-family:system-ui,sans-serif;background:#f3f4f6;color:#1f2937}}\
         main{{max-width:28rem;margin:1rem;padding:2rem;background:#fff;\
         border:1px solid #e5e7eb;border-radius:10px}}\
         h1{{margin:0 0 .5rem;font-size:1.25rem}}p{{margin:0;line-height:1.5}}\
         </style></head><body><main><h1>{title}</h1><p>{text}</p></main></body></html>"
    );
    format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: text/html; charset=utf-8\r\n\
         Content-Length: {}\r\n\
         Cache-Control: no-store\r\n\
         Connection: close\r\n\
         X-Content-Type-Options: nosniff\r\n\
         Referrer-Policy: no-referrer\r\n\
         Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'\r\n\
         \r\n{body}",
        body.len()
    )
    .into_bytes()
}

/// Liest die E-Mail-Adresse aus dem ID-Token. Das Token kommt direkt von Googles
/// Token-Adresse über HTTPS; seine Signatur muss dann nicht geprüft werden (OpenID Connect,
/// Abschnitt 3.1.3.7). Die Adresse dient nur der Anzeige.
pub fn email_from_id_token(id_token: &str) -> Option<String> {
    let payload = id_token.split('.').nth(1)?;
    let bytes = URL_SAFE_NO_PAD.decode(payload.trim_end_matches('=')).ok()?;
    let claims: serde_json::Value = serde_json::from_slice(&bytes).ok()?;
    let email = claims.get("email")?.as_str()?.trim();
    let usable = !email.is_empty() && email.len() <= 254 && !email.chars().any(char::is_control);
    usable.then(|| email.to_string())
}

/// Öffnet die Adresse im Standardbrowser. Scheitert das, bleibt die Adresse in der
/// Oberfläche zum Kopieren.
pub fn open_in_browser(url: &str) -> Result<(), GoogleError> {
    let mut command = browser_command(url);
    command
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut child = command.spawn().map_err(|_| GoogleError::Local)?;
    // Das Hilfsprogramm endet sofort; abholen, damit kein Zombie-Prozess bleibt.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(target_os = "windows")]
fn browser_command(url: &str) -> Command {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    let mut command = Command::new("rundll32.exe");
    command
        .arg("url.dll,FileProtocolHandler")
        .arg(url)
        .creation_flags(CREATE_NO_WINDOW);
    command
}

#[cfg(target_os = "macos")]
fn browser_command(url: &str) -> Command {
    let mut command = Command::new("open");
    command.arg(url);
    command
}

#[cfg(all(unix, not(target_os = "macos")))]
fn browser_command(url: &str) -> Command {
    let mut command = Command::new("xdg-open");
    command.arg(url);
    // Ein AppImage biegt die Bibliothekspfade auf seine eigenen Bibliotheken um; der
    // Browser soll mit denen des Systems starten.
    if std::env::var_os("APPIMAGE").is_some() {
        command.env_remove("LD_LIBRARY_PATH");
    }
    command
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::Arc;

    fn creds() -> ClientCredentials {
        ClientCredentials {
            id: "123-abc.apps.googleusercontent.com".to_string(),
            secret: "geheim".to_string(),
        }
    }

    #[test]
    fn pkce_entspricht_dem_beispiel_aus_rfc_7636() {
        assert_eq!(
            pkce_challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn anmeldeadresse_enthaelt_alles_noetige_und_nichts_geheimes() {
        let url = auth_url(&creds(), "http://127.0.0.1:5000/", "CHALLENGE", "STATE");
        let parsed = Url::parse(&url).unwrap();
        assert_eq!(parsed.host_str(), Some("accounts.google.com"));
        let pairs: std::collections::HashMap<String, String> =
            parsed.query_pairs().into_owned().collect();
        assert_eq!(pairs["client_id"], creds().id);
        assert_eq!(pairs["redirect_uri"], "http://127.0.0.1:5000/");
        assert_eq!(pairs["response_type"], "code");
        assert_eq!(
            pairs["scope"],
            "openid email https://www.googleapis.com/auth/calendar.app.created"
        );
        assert_eq!(pairs["code_challenge"], "CHALLENGE");
        assert_eq!(pairs["code_challenge_method"], "S256");
        assert_eq!(pairs["state"], "STATE");
        assert_eq!(pairs["access_type"], "offline");
        assert_eq!(pairs["prompt"], "consent");
        assert!(
            !url.contains("geheim"),
            "Das Client-Secret gehört nicht in die Adresse"
        );
    }

    #[test]
    fn beginn_oeffnet_einen_anschluss_nur_auf_diesem_rechner() {
        tauri::async_runtime::block_on(async {
            let session = begin(&creds()).await.unwrap();
            let address = session.listener.local_addr().unwrap();
            assert!(address.ip().is_loopback());
            assert_eq!(
                session.redirect_uri,
                format!("http://127.0.0.1:{}/", address.port())
            );
            assert!(session.verifier.len() >= 43 && session.verifier.len() <= 128);
            assert!(session.url.contains(&format!(
                "code_challenge={}",
                pkce_challenge(&session.verifier)
            )));
            let other = begin(&creds()).await.unwrap();
            assert_ne!(session.state, other.state);
            assert_ne!(*session.verifier, *other.verifier);
        });
    }

    #[test]
    fn rueckleitung_wird_streng_geprueft() {
        let request = |line: &str| format!("{line}\r\nHost: 127.0.0.1\r\n\r\n");
        assert_eq!(
            evaluate_request(&request("GET /?state=S&code=4%2F0Ab HTTP/1.1"), "S"),
            Callback::Code("4/0Ab".to_string())
        );
        assert_eq!(
            evaluate_request(&request("GET /?error=access_denied&state=S HTTP/1.1"), "S"),
            Callback::Denied
        );
        assert_eq!(
            evaluate_request(&request("GET /?state=FALSCH&code=x HTTP/1.1"), "S"),
            Callback::NotForUs(400)
        );
        assert_eq!(
            evaluate_request(&request("GET /?code=x HTTP/1.1"), "S"),
            Callback::NotForUs(400)
        );
        assert_eq!(
            evaluate_request(&request("GET /?error=access_denied HTTP/1.1"), "S"),
            Callback::NotForUs(400),
            "Ohne passenden state darf niemand die Anmeldung abbrechen"
        );
        assert_eq!(
            evaluate_request(&request("GET /?state=S&code= HTTP/1.1"), "S"),
            Callback::NotForUs(400)
        );
        assert_eq!(
            evaluate_request(&request("GET /favicon.ico HTTP/1.1"), "S"),
            Callback::NotForUs(404)
        );
        assert_eq!(
            evaluate_request(
                &request("GET //boese.example/?state=S&code=x HTTP/1.1"),
                "S"
            ),
            Callback::NotForUs(404)
        );
        assert_eq!(
            evaluate_request(&request("POST /?state=S&code=x HTTP/1.1"), "S"),
            Callback::NotForUs(405)
        );
        assert_eq!(
            evaluate_request(
                &request("GET http://boese.example/?state=S&code=x HTTP/1.1"),
                "S"
            ),
            Callback::NotForUs(400)
        );
        assert_eq!(evaluate_request("", "S"), Callback::NotForUs(400));
        assert_eq!(evaluate_request("Unsinn", "S"), Callback::NotForUs(400));
    }

    fn send(port: u16, request: &str) -> String {
        let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        stream.write_all(request.as_bytes()).unwrap();
        let mut response = String::new();
        let _ = stream.read_to_string(&mut response);
        response
    }

    #[test]
    fn wartet_auf_die_richtige_rueckleitung_und_antwortet_dem_browser() {
        tauri::async_runtime::block_on(async {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let browser = std::thread::spawn(move || {
                let favicon = send(port, "GET /favicon.ico HTTP/1.1\r\n\r\n");
                let fremd = send(port, "GET /?state=X&code=fremd HTTP/1.1\r\n\r\n");
                let richtig = send(port, "GET /?state=S&code=echt HTTP/1.1\r\n\r\n");
                (favicon, fremd, richtig)
            });
            let cancel = AtomicBool::new(false);
            let code = await_callback(&listener, "S", &cancel, Duration::from_secs(10))
                .await
                .unwrap();
            assert_eq!(code, "echt");
            let (favicon, fremd, richtig) = browser.join().unwrap();
            assert!(favicon.starts_with("HTTP/1.1 404"));
            assert!(fremd.starts_with("HTTP/1.1 400"));
            assert!(richtig.starts_with("HTTP/1.1 200"));
            assert!(richtig.contains("Verbunden"));
            assert!(
                !richtig.contains("echt"),
                "Der Code erscheint nie auf der Seite"
            );
            assert!(richtig.contains("Content-Security-Policy: default-src 'none'"));
        });
    }

    #[test]
    fn verweigerte_erlaubnis_beendet_das_warten() {
        tauri::async_runtime::block_on(async {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let browser = std::thread::spawn(move || {
                send(port, "GET /?error=access_denied&state=S HTTP/1.1\r\n\r\n")
            });
            let cancel = AtomicBool::new(false);
            let result = await_callback(&listener, "S", &cancel, Duration::from_secs(10)).await;
            assert_eq!(result, Err(GoogleError::Denied));
            assert!(browser.join().unwrap().contains("Nicht verbunden"));
        });
    }

    #[test]
    fn abbrechen_und_zeitueberschreitung_beenden_das_warten() {
        tauri::async_runtime::block_on(async {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let cancel = Arc::new(AtomicBool::new(false));
            let trigger = Arc::clone(&cancel);
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(300));
                trigger.store(true, Ordering::SeqCst);
            });
            let started = Instant::now();
            let result = await_callback(&listener, "S", &cancel, Duration::from_secs(30)).await;
            assert_eq!(result, Err(GoogleError::Cancelled));
            assert!(started.elapsed() < Duration::from_secs(5));

            let not_cancelled = AtomicBool::new(false);
            let result =
                await_callback(&listener, "S", &not_cancelled, Duration::from_millis(300)).await;
            assert_eq!(result, Err(GoogleError::Timeout));
        });
    }

    #[test]
    fn stummer_aufruf_blockiert_die_anmeldung_nicht() {
        tauri::async_runtime::block_on(async {
            let listener = TcpListener::bind(("127.0.0.1", 0)).await.unwrap();
            let port = listener.local_addr().unwrap().port();
            let browser = std::thread::spawn(move || {
                // Eine Verbindung, die nie etwas schickt (wie eine Vorab-Verbindung des
                // Browsers), und danach die echte Rückleitung.
                let _stumm = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
                std::thread::sleep(Duration::from_millis(100));
                send(port, "GET /?state=S&code=echt HTTP/1.1\r\n\r\n")
            });
            let cancel = AtomicBool::new(false);
            let code = await_callback(&listener, "S", &cancel, Duration::from_secs(20))
                .await
                .unwrap();
            assert_eq!(code, "echt");
            assert!(browser.join().unwrap().starts_with("HTTP/1.1 200"));
        });
    }

    fn id_token(claims: &str) -> String {
        format!(
            "{}.{}.signatur",
            URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256"}"#),
            URL_SAFE_NO_PAD.encode(claims.as_bytes())
        )
    }

    #[test]
    fn e_mail_adresse_kommt_aus_dem_id_token() {
        assert_eq!(
            email_from_id_token(&id_token(
                r#"{"email":"kollege@gmail.com","email_verified":true}"#
            ))
            .as_deref(),
            Some("kollege@gmail.com")
        );
        assert_eq!(email_from_id_token(&id_token(r#"{"sub":"1"}"#)), None);
        assert_eq!(email_from_id_token(&id_token(r#"{"email":""}"#)), None);
        assert_eq!(
            email_from_id_token(&id_token("{\"email\":\"a\\nb@c.de\"}")),
            None
        );
        assert_eq!(email_from_id_token("kein-token"), None);
        assert_eq!(email_from_id_token("a.%%%.c"), None);
    }
}
