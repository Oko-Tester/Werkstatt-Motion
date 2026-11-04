//! Die Aufrufe bei Google: Token-Adresse (OAuth) und Kalender-Schnittstelle (REST, v3).
//!
//! `GoogleApi` ist die Naht für Tests: Die App benutzt `ReqwestApi`, die Tests ein
//! nachgebildetes Google im Speicher. Die Aufrufe selbst werden in den Tests gegen einen
//! kleinen HTTP-Server auf diesem Rechner geprüft.

use std::fmt;
use std::future::Future;
use std::time::Duration;

use reqwest::header::CONTENT_TYPE;
use reqwest::{Client, RequestBuilder, Response, Url};
use serde_json::{json, Value};

use super::events::{parse_remote_events, DesiredEvent, RemoteEvent, TIME_ZONE};
use super::oauth::email_from_id_token;
use super::{ClientCredentials, GoogleError, CALENDAR_DESCRIPTION, CALENDAR_NAME};

/// Antwort der Token-Adresse nach der Anmeldung.
pub struct TokenGrant {
    pub access_token: String,
    pub refresh_token: Option<String>,
    /// Die tatsächlich erteilten Berechtigungen, durch Leerzeichen getrennt.
    pub scope: String,
    pub email: Option<String>,
}

impl fmt::Debug for TokenGrant {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Tokens dürfen in keiner Ausgabe landen.
        f.debug_struct("TokenGrant")
            .field("scope", &self.scope)
            .field("email", &self.email)
            .finish_non_exhaustive()
    }
}

pub trait GoogleApi: Send + Sync {
    fn exchange_code(
        &self,
        creds: &ClientCredentials,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> impl Future<Output = Result<TokenGrant, GoogleError>> + Send;

    /// Holt mit dem Refresh-Token ein frisches Zugriffstoken.
    fn refresh_access_token(
        &self,
        creds: &ClientCredentials,
        refresh_token: &str,
    ) -> impl Future<Output = Result<String, GoogleError>> + Send;

    /// Widerruft den Zugang bei Google. Scheitert das, bleibt es ohne Folgen.
    fn revoke(&self, token: &str) -> impl Future<Output = ()> + Send;

    /// Legt den Kalender „Werkstatt Motion“ an und liefert seine Kennung.
    fn create_calendar(
        &self,
        access: &str,
    ) -> impl Future<Output = Result<String, GoogleError>> + Send;

    fn delete_calendar(
        &self,
        access: &str,
        calendar_id: &str,
    ) -> impl Future<Output = Result<(), GoogleError>> + Send;

    /// Alle Termine dieser App im Kalender (über alle Seiten der Antwort).
    fn list_events(
        &self,
        access: &str,
        calendar_id: &str,
    ) -> impl Future<Output = Result<Vec<RemoteEvent>, GoogleError>> + Send;

    fn insert_event(
        &self,
        access: &str,
        calendar_id: &str,
        event: &DesiredEvent,
    ) -> impl Future<Output = Result<(), GoogleError>> + Send;

    fn update_event(
        &self,
        access: &str,
        calendar_id: &str,
        event_id: &str,
        event: &DesiredEvent,
    ) -> impl Future<Output = Result<(), GoogleError>> + Send;

    fn delete_event(
        &self,
        access: &str,
        calendar_id: &str,
        event_id: &str,
    ) -> impl Future<Output = Result<(), GoogleError>> + Send;
}

/// Adressen bei Google. In Tests zeigen sie auf einen Server auf diesem Rechner.
#[derive(Debug, Clone)]
pub struct Urls {
    pub token: String,
    pub revoke: String,
    pub calendar: String,
}

impl Urls {
    pub fn google() -> Self {
        Urls {
            token: "https://oauth2.googleapis.com/token".to_string(),
            revoke: "https://oauth2.googleapis.com/revoke".to_string(),
            calendar: "https://www.googleapis.com/calendar/v3".to_string(),
        }
    }
}

pub struct ReqwestApi {
    client: Client,
    urls: Urls,
    /// Wartezeiten vor einem neuen Versuch, wenn Google bremst oder einen Serverfehler meldet.
    retry_delays: Vec<Duration>,
    /// Kleine Pause nach jedem Schreiben, damit Google beim ersten Abgleich nicht bremst.
    write_pause: Duration,
}

/// Die TLS-Bibliothek braucht einen Kryptoanbieter. Wie das Update-Plugin: `ring`, falls
/// noch keiner gesetzt ist.
pub(super) fn ensure_tls_provider() {
    if rustls::crypto::CryptoProvider::get_default().is_none() {
        let _ = rustls::crypto::ring::default_provider().install_default();
    }
}

impl ReqwestApi {
    pub fn new(urls: Urls) -> Result<Self, GoogleError> {
        ensure_tls_provider();
        let client = Client::builder()
            .user_agent(concat!("Werkstatt-Motion/", env!("CARGO_PKG_VERSION")))
            .connect_timeout(Duration::from_secs(10))
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|_| GoogleError::Network)?;
        Ok(ReqwestApi {
            client,
            urls,
            retry_delays: vec![Duration::from_secs(1), Duration::from_secs(3)],
            write_pause: Duration::from_millis(100),
        })
    }

    #[cfg(test)]
    pub fn without_waiting(mut self) -> Self {
        self.retry_delays = vec![Duration::ZERO, Duration::ZERO];
        self.write_pause = Duration::ZERO;
        self
    }

    fn calendar_url(&self, segments: &[&str]) -> Result<Url, GoogleError> {
        let mut url = Url::parse(&self.urls.calendar).map_err(|_| GoogleError::Local)?;
        url.path_segments_mut()
            .map_err(|_| GoogleError::Local)?
            .pop_if_empty()
            .extend(segments);
        Ok(url)
    }

    /// Schickt die Anfrage; bremst Google oder meldet einen Serverfehler, folgt nach einer
    /// Pause ein neuer Versuch.
    async fn execute(
        &self,
        build: impl Fn() -> RequestBuilder + Send + Sync,
        classify: fn(u16, &str) -> GoogleError,
    ) -> Result<Response, GoogleError> {
        let mut delays = self.retry_delays.iter();
        loop {
            let error = match build().send().await {
                Ok(response) if response.status().is_success() => return Ok(response),
                Ok(response) => {
                    let status = response.status().as_u16();
                    let body = response.text().await.unwrap_or_default();
                    classify(status, &body)
                }
                Err(_) => GoogleError::Network,
            };
            let worth_retrying = matches!(error, GoogleError::RateLimited | GoogleError::Server(_));
            match delays.next() {
                Some(delay) if worth_retrying => tokio::time::sleep(*delay).await,
                _ => return Err(error),
            }
        }
    }

    async fn post_form(&self, pairs: &[(&str, &str)]) -> Result<Value, GoogleError> {
        let body = form_body(pairs);
        let response = self
            .execute(
                || {
                    self.client
                        .post(self.urls.token.as_str())
                        .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
                        .body(body.clone())
                },
                classify_token_error,
            )
            .await?;
        json_body(response).await
    }

    async fn pause_after_write(&self) {
        if !self.write_pause.is_zero() {
            tokio::time::sleep(self.write_pause).await;
        }
    }
}

fn form_body(pairs: &[(&str, &str)]) -> String {
    let mut url = Url::parse("http://formular.invalid/").expect("feste, gültige Adresse");
    url.query_pairs_mut().extend_pairs(pairs);
    url.query().unwrap_or_default().to_string()
}

async fn json_body(response: Response) -> Result<Value, GoogleError> {
    response
        .json::<Value>()
        .await
        .map_err(|_| GoogleError::Network)
}

fn text_field(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_string)
}

/// Ordnet einen Fehler der Kalender-Schnittstelle ein. Nur der Status und bekannte Gründe
/// zählen; der Antworttext selbst erscheint nie in einer Meldung.
pub(super) fn classify_api_error(status: u16, body: &str) -> GoogleError {
    let text = body.to_ascii_lowercase();
    let mentions = |needles: &[&str]| needles.iter().any(|needle| text.contains(needle));
    let rate_limited = mentions(&[
        "ratelimitexceeded",
        "userratelimitexceeded",
        "rate_limit_exceeded",
        "quotaexceeded",
    ]);
    let disabled = mentions(&[
        "accessnotconfigured",
        "service_disabled",
        "has not been used in project",
    ]);
    match status {
        401 => GoogleError::InvalidGrant,
        429 => GoogleError::RateLimited,
        403 if rate_limited => GoogleError::RateLimited,
        403 if disabled => GoogleError::ApiDisabled,
        404 | 410 => GoogleError::NotFound,
        500..=599 => GoogleError::Server(status),
        _ => GoogleError::Rejected(status),
    }
}

/// Ordnet einen Fehler der Token-Adresse ein.
pub(super) fn classify_token_error(status: u16, body: &str) -> GoogleError {
    let error = serde_json::from_str::<Value>(body)
        .ok()
        .and_then(|value| text_field(&value, "error"))
        .unwrap_or_default();
    match error.as_str() {
        "invalid_grant" => GoogleError::InvalidGrant,
        "invalid_client" | "unauthorized_client" => GoogleError::InvalidClient,
        _ if status == 401 => GoogleError::InvalidClient,
        _ if status == 429 => GoogleError::RateLimited,
        _ if (500..=599).contains(&status) => GoogleError::Server(status),
        _ => GoogleError::Rejected(status),
    }
}

impl GoogleApi for ReqwestApi {
    async fn exchange_code(
        &self,
        creds: &ClientCredentials,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> Result<TokenGrant, GoogleError> {
        let mut pairs = vec![
            ("grant_type", "authorization_code"),
            ("code", code),
            ("client_id", creds.id.as_str()),
            ("redirect_uri", redirect_uri),
            ("code_verifier", verifier),
        ];
        if !creds.secret.is_empty() {
            pairs.push(("client_secret", creds.secret.as_str()));
        }
        let value = self.post_form(&pairs).await?;
        let access_token = text_field(&value, "access_token").ok_or(GoogleError::Rejected(200))?;
        Ok(TokenGrant {
            access_token,
            refresh_token: text_field(&value, "refresh_token"),
            scope: text_field(&value, "scope").unwrap_or_default(),
            email: text_field(&value, "id_token")
                .as_deref()
                .and_then(email_from_id_token),
        })
    }

    async fn refresh_access_token(
        &self,
        creds: &ClientCredentials,
        refresh_token: &str,
    ) -> Result<String, GoogleError> {
        let mut pairs = vec![
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
            ("client_id", creds.id.as_str()),
        ];
        if !creds.secret.is_empty() {
            pairs.push(("client_secret", creds.secret.as_str()));
        }
        let value = self.post_form(&pairs).await?;
        text_field(&value, "access_token").ok_or(GoogleError::Rejected(200))
    }

    async fn revoke(&self, token: &str) {
        let _ = self
            .client
            .post(self.urls.revoke.as_str())
            .header(CONTENT_TYPE, "application/x-www-form-urlencoded")
            .body(form_body(&[("token", token)]))
            .send()
            .await;
    }

    async fn create_calendar(&self, access: &str) -> Result<String, GoogleError> {
        let url = self.calendar_url(&["calendars"])?;
        let body = json!({
            "summary": CALENDAR_NAME,
            "description": CALENDAR_DESCRIPTION,
            "timeZone": TIME_ZONE,
        });
        let response = self
            .execute(
                || {
                    self.client
                        .post(url.clone())
                        .bearer_auth(access)
                        .json(&body)
                },
                classify_api_error,
            )
            .await?;
        let value = json_body(response).await?;
        text_field(&value, "id").ok_or(GoogleError::Rejected(200))
    }

    async fn delete_calendar(&self, access: &str, calendar_id: &str) -> Result<(), GoogleError> {
        let url = self.calendar_url(&["calendars", calendar_id])?;
        self.execute(
            || self.client.delete(url.clone()).bearer_auth(access),
            classify_api_error,
        )
        .await?;
        Ok(())
    }

    async fn list_events(
        &self,
        access: &str,
        calendar_id: &str,
    ) -> Result<Vec<RemoteEvent>, GoogleError> {
        let mut events = Vec::new();
        let mut page_token: Option<String> = None;
        loop {
            let mut url = self.calendar_url(&["calendars", calendar_id, "events"])?;
            {
                let mut query = url.query_pairs_mut();
                query
                    .append_pair("maxResults", "2500")
                    .append_pair("privateExtendedProperty", "wm=1")
                    .append_pair(
                        "fields",
                        "nextPageToken,items(id,extendedProperties/private)",
                    );
                if let Some(token) = &page_token {
                    query.append_pair("pageToken", token);
                }
            }
            let response = self
                .execute(
                    || self.client.get(url.clone()).bearer_auth(access),
                    classify_api_error,
                )
                .await?;
            let page = json_body(response).await?;
            events.extend(parse_remote_events(&page));
            page_token = text_field(&page, "nextPageToken").filter(|token| !token.is_empty());
            if page_token.is_none() {
                return Ok(events);
            }
        }
    }

    async fn insert_event(
        &self,
        access: &str,
        calendar_id: &str,
        event: &DesiredEvent,
    ) -> Result<(), GoogleError> {
        let url = self.calendar_url(&["calendars", calendar_id, "events"])?;
        let body = event.to_json();
        self.execute(
            || {
                self.client
                    .post(url.clone())
                    .bearer_auth(access)
                    .json(&body)
            },
            classify_api_error,
        )
        .await?;
        self.pause_after_write().await;
        Ok(())
    }

    async fn update_event(
        &self,
        access: &str,
        calendar_id: &str,
        event_id: &str,
        event: &DesiredEvent,
    ) -> Result<(), GoogleError> {
        let url = self.calendar_url(&["calendars", calendar_id, "events", event_id])?;
        let body = event.to_json();
        self.execute(
            || self.client.put(url.clone()).bearer_auth(access).json(&body),
            classify_api_error,
        )
        .await?;
        self.pause_after_write().await;
        Ok(())
    }

    async fn delete_event(
        &self,
        access: &str,
        calendar_id: &str,
        event_id: &str,
    ) -> Result<(), GoogleError> {
        let url = self.calendar_url(&["calendars", calendar_id, "events", event_id])?;
        self.execute(
            || self.client.delete(url.clone()).bearer_auth(access),
            classify_api_error,
        )
        .await?;
        self.pause_after_write().await;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::google::events::build_event;
    use crate::google::testing::{vehicle, MiniServer};
    use crate::google::Content;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

    fn creds() -> ClientCredentials {
        ClientCredentials {
            id: "client-1".to_string(),
            secret: "secret-1".to_string(),
        }
    }

    fn api(server: &MiniServer) -> ReqwestApi {
        ReqwestApi::new(Urls {
            token: format!("{}/token", server.base),
            revoke: format!("{}/revoke", server.base),
            calendar: format!("{}/calendar/v3", server.base),
        })
        .unwrap()
        .without_waiting()
    }

    fn block<F: Future>(future: F) -> F::Output {
        tauri::async_runtime::block_on(future)
    }

    #[test]
    fn code_wird_mit_pkce_gegen_zugang_getauscht() {
        let id_token = format!(
            "x.{}.y",
            base64::Engine::encode(
                &base64::engine::general_purpose::URL_SAFE_NO_PAD,
                br#"{"email":"kollege@gmail.com"}"#
            )
        );
        let answer = json!({
            "access_token": "zugang",
            "refresh_token": "dauer",
            "scope": "openid https://www.googleapis.com/auth/calendar.app.created email",
            "id_token": id_token,
        })
        .to_string();
        let server = MiniServer::start(move |_| (200, answer.clone()));
        let grant = block(api(&server).exchange_code(
            &creds(),
            "4/code",
            "verifier-123",
            "http://127.0.0.1:5000/",
        ))
        .unwrap();
        assert_eq!(grant.access_token, "zugang");
        assert_eq!(grant.refresh_token.as_deref(), Some("dauer"));
        assert_eq!(grant.email.as_deref(), Some("kollege@gmail.com"));
        assert!(grant.scope.contains("calendar.app.created"));
        assert!(
            !format!("{grant:?}").contains("zugang"),
            "Debug zeigt keine Tokens"
        );

        let request = &server.requests()[0];
        assert_eq!(request.method, "POST");
        assert_eq!(request.path(), "/token");
        assert_eq!(
            request.header("content-type"),
            Some("application/x-www-form-urlencoded")
        );
        let form = request.form();
        assert_eq!(form["grant_type"], "authorization_code");
        assert_eq!(form["code"], "4/code");
        assert_eq!(form["code_verifier"], "verifier-123");
        assert_eq!(form["redirect_uri"], "http://127.0.0.1:5000/");
        assert_eq!(form["client_id"], "client-1");
        assert_eq!(form["client_secret"], "secret-1");
    }

    #[test]
    fn ohne_secret_geht_kein_leeres_feld_mit() {
        let server = MiniServer::start(|_| (200, json!({ "access_token": "a" }).to_string()));
        let creds = ClientCredentials {
            id: "client-1".to_string(),
            secret: String::new(),
        };
        let access = block(api(&server).refresh_access_token(&creds, "dauer")).unwrap();
        assert_eq!(access, "a");
        let form = server.requests()[0].form();
        assert_eq!(form["grant_type"], "refresh_token");
        assert_eq!(form["refresh_token"], "dauer");
        assert!(!form.contains_key("client_secret"));
    }

    #[test]
    fn token_fehler_werden_richtig_eingeordnet() {
        let cases = [
            (
                400,
                r#"{"error":"invalid_grant","error_description":"Token has been expired or revoked."}"#,
                GoogleError::InvalidGrant,
            ),
            (
                401,
                r#"{"error":"invalid_client"}"#,
                GoogleError::InvalidClient,
            ),
            (
                400,
                r#"{"error":"unauthorized_client"}"#,
                GoogleError::InvalidClient,
            ),
            (
                400,
                r#"{"error":"invalid_request"}"#,
                GoogleError::Rejected(400),
            ),
            (503, "kein json", GoogleError::Server(503)),
        ];
        for (status, body, expected) in cases {
            let body = body.to_string();
            let server = MiniServer::start(move |_| (status, body.clone()));
            let result = block(api(&server).refresh_access_token(&creds(), "dauer"));
            assert_eq!(result, Err(expected), "{status}");
        }
    }

    #[test]
    fn kalender_wird_mit_name_und_zeitzone_angelegt() {
        let server = MiniServer::start(|_| {
            (
                200,
                json!({ "id": "abc123@group.calendar.google.com" }).to_string(),
            )
        });
        let id = block(api(&server).create_calendar("zugang")).unwrap();
        assert_eq!(id, "abc123@group.calendar.google.com");
        let request = &server.requests()[0];
        assert_eq!(request.method, "POST");
        assert_eq!(request.path(), "/calendar/v3/calendars");
        assert_eq!(request.header("authorization"), Some("Bearer zugang"));
        let body: Value = serde_json::from_str(&request.body).unwrap();
        assert_eq!(body["summary"], CALENDAR_NAME);
        assert_eq!(body["timeZone"], TIME_ZONE);
    }

    #[test]
    fn termine_werden_ueber_alle_seiten_gelesen() {
        let server = MiniServer::start(|request| {
            let query = request.query();
            if query.get("pageToken").map(String::as_str) == Some("seite2") {
                (200, json!({ "items": [
                    { "id": "e2", "extendedProperties": { "private": { "wm": "1", "vehicle": "v2", "fp": "f2" } } }
                ] })
                .to_string())
            } else {
                (200, json!({ "nextPageToken": "seite2", "items": [
                    { "id": "e1", "extendedProperties": { "private": { "wm": "1", "vehicle": "v1", "fp": "f1" } } },
                    { "id": "fremd", "summary": "Privat" }
                ] })
                .to_string())
            }
        });
        let events =
            block(api(&server).list_events("zugang", "abc@group.calendar.google.com")).unwrap();
        let ids: Vec<_> = events.iter().map(|event| event.id.as_str()).collect();
        assert_eq!(ids, vec!["e1", "e2"]);

        let requests = server.requests();
        assert_eq!(requests.len(), 2);
        assert!(
            requests[0]
                .path()
                .ends_with("/calendars/abc@group.calendar.google.com/events")
                || requests[0]
                    .path()
                    .ends_with("/calendars/abc%40group.calendar.google.com/events")
        );
        let query = requests[0].query();
        assert_eq!(query["privateExtendedProperty"], "wm=1");
        assert_eq!(query["maxResults"], "2500");
        assert!(!query.contains_key("pageToken"));
        assert_eq!(requests[1].query()["pageToken"], "seite2");
    }

    #[test]
    fn termine_schreiben_aendern_und_loeschen() {
        let server = MiniServer::start(|request| match request.method.as_str() {
            "DELETE" => (204, String::new()),
            _ => (200, json!({ "id": "neu" }).to_string()),
        });
        let api = api(&server);
        let event = build_event(&vehicle("v1", Some("2026-11-05T14:00")), Content::Short).unwrap();
        block(api.insert_event("zugang", "kal", &event)).unwrap();
        block(api.update_event("zugang", "kal", "e1", &event)).unwrap();
        block(api.delete_event("zugang", "kal", "e1")).unwrap();
        block(api.delete_calendar("zugang", "kal")).unwrap();

        let requests = server.requests();
        let summary: Vec<_> = requests
            .iter()
            .map(|request| format!("{} {}", request.method, request.path()))
            .collect();
        assert_eq!(
            summary,
            vec![
                "POST /calendar/v3/calendars/kal/events",
                "PUT /calendar/v3/calendars/kal/events/e1",
                "DELETE /calendar/v3/calendars/kal/events/e1",
                "DELETE /calendar/v3/calendars/kal",
            ]
        );
        let body: Value = serde_json::from_str(&requests[0].body).unwrap();
        assert_eq!(body, event.to_json());
        assert!(requests
            .iter()
            .all(|request| request.header("authorization") == Some("Bearer zugang")));
    }

    #[test]
    fn kennungen_mit_sonderzeichen_werden_im_pfad_maskiert() {
        let server = MiniServer::start(|_| (204, String::new()));
        block(api(&server).delete_event("zugang", "kal", "a/b?c#d")).unwrap();
        let path = server.requests()[0].path().to_string();
        assert!(path.ends_with("/events/a%2Fb%3Fc%23d"), "{path}");
    }

    #[test]
    fn kalender_fehler_werden_richtig_eingeordnet() {
        let rate = r#"{"error":{"code":403,"errors":[{"reason":"rateLimitExceeded"}]}}"#;
        let disabled = r#"{"error":{"code":403,"message":"Google Calendar API has not been used in project 1 before or it is disabled.","errors":[{"reason":"accessNotConfigured"}]}}"#;
        assert_eq!(classify_api_error(401, ""), GoogleError::InvalidGrant);
        assert_eq!(classify_api_error(403, rate), GoogleError::RateLimited);
        assert_eq!(classify_api_error(429, ""), GoogleError::RateLimited);
        assert_eq!(classify_api_error(403, disabled), GoogleError::ApiDisabled);
        assert_eq!(classify_api_error(403, "{}"), GoogleError::Rejected(403));
        assert_eq!(classify_api_error(404, ""), GoogleError::NotFound);
        assert_eq!(classify_api_error(410, ""), GoogleError::NotFound);
        assert_eq!(classify_api_error(500, ""), GoogleError::Server(500));
        assert_eq!(classify_api_error(400, ""), GoogleError::Rejected(400));
    }

    #[test]
    fn gebremste_anfragen_werden_wiederholt() {
        let attempts = Arc::new(AtomicUsize::new(0));
        let counter = Arc::clone(&attempts);
        let server = MiniServer::start(move |_| {
            if counter.fetch_add(1, Ordering::SeqCst) < 2 {
                (429, r#"{"error":{"code":429}}"#.to_string())
            } else {
                (200, json!({ "id": "kal" }).to_string())
            }
        });
        assert_eq!(
            block(api(&server).create_calendar("zugang")).unwrap(),
            "kal"
        );
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
    }

    #[test]
    fn dauerhaft_gebremst_gibt_nach_drei_versuchen_auf() {
        let server = MiniServer::start(|_| (503, String::new()));
        assert_eq!(
            block(api(&server).create_calendar("zugang")),
            Err(GoogleError::Server(503))
        );
        assert_eq!(server.requests().len(), 3);
    }

    #[test]
    fn andere_fehler_werden_nicht_wiederholt() {
        let server = MiniServer::start(|_| (404, String::new()));
        assert_eq!(
            block(api(&server).list_events("zugang", "kal")),
            Err(GoogleError::NotFound)
        );
        assert_eq!(server.requests().len(), 1);
    }

    #[test]
    fn ohne_server_meldet_die_app_keine_verbindung() {
        let port = {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            listener.local_addr().unwrap().port()
        };
        let api = ReqwestApi::new(Urls {
            token: format!("http://127.0.0.1:{port}/token"),
            revoke: format!("http://127.0.0.1:{port}/revoke"),
            calendar: format!("http://127.0.0.1:{port}/calendar/v3"),
        })
        .unwrap()
        .without_waiting();
        assert_eq!(
            block(api.create_calendar("zugang")),
            Err(GoogleError::Network)
        );
        assert_eq!(
            block(api.refresh_access_token(&creds(), "dauer")),
            Err(GoogleError::Network)
        );
        block(api.revoke("dauer"));
    }

    #[test]
    fn widerrufen_schickt_das_token_an_google() {
        let server = MiniServer::start(|_| (200, "{}".to_string()));
        block(api(&server).revoke("dauer"));
        let request = &server.requests()[0];
        assert_eq!(request.path(), "/revoke");
        assert_eq!(request.form()["token"], "dauer");
    }

    #[test]
    fn google_adressen_sind_https() {
        let urls = Urls::google();
        for url in [&urls.token, &urls.revoke, &urls.calendar] {
            assert!(url.starts_with("https://"), "{url}");
        }
    }

    /// Von Hand gegen das echte Google (braucht Internet, sendet keine Daten von Nutzern):
    /// Die TLS-Verbindung steht, und Googles Antworten auf eine unbekannte Zugangs-ID und
    /// ein ungültiges Zugriffstoken werden richtig eingeordnet.
    /// `cargo test echtes_google -- --ignored`
    #[test]
    #[ignore = "braucht Internet"]
    fn echtes_google_erkennt_unbekannte_zugangs_id_und_ungueltiges_token() {
        let api = ReqwestApi::new(Urls::google()).unwrap();
        let unknown = ClientCredentials {
            id: "werkstatt-motion-test.apps.googleusercontent.com".to_string(),
            secret: String::new(),
        };
        assert_eq!(
            block(api.refresh_access_token(&unknown, "kein-gueltiges-token")),
            Err(GoogleError::InvalidClient)
        );
        assert_eq!(
            block(api.list_events("kein-gueltiges-token", "primary")),
            Err(GoogleError::InvalidGrant)
        );
    }
}
