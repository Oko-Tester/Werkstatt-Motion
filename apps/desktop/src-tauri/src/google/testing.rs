//! Hilfen für die Tests: ein nachgebildetes Google im Speicher, ein Token-Speicher im
//! Speicher und ein kleiner HTTP-Server auf diesem Rechner.

use std::collections::{BTreeMap, HashMap};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use zeroize::Zeroizing;

use super::api::{GoogleApi, TokenGrant};
use super::events::{DesiredEvent, RemoteEvent};
use super::{ClientCredentials, GoogleError, TokenStore, CALENDAR_SCOPE};
use crate::error::ApiError;
use crate::models::Vehicle;

pub fn vehicle(id: &str, appointment: Option<&str>) -> Vehicle {
    Vehicle {
        id: id.to_string(),
        customer_name: format!("Kunde {id}"),
        vehicle_name: format!("Auto {id}"),
        license_plate: format!("AB-{id} 1"),
        note: "Notiz bleibt in der App".to_string(),
        tuv_required: false,
        parts_ordered: false,
        parts_arrived: false,
        is_done: false,
        appointment_at: appointment.map(str::to_string),
        position: 0,
        created_at: "2026-11-01T08:00:00Z".to_string(),
        updated_at: "2026-11-01T08:00:00Z".to_string(),
        archived_at: None,
    }
}

pub fn credentials() -> ClientCredentials {
    ClientCredentials {
        id: "client-1".to_string(),
        secret: "secret-1".to_string(),
    }
}

// ---------- Token-Speicher ----------

#[derive(Default)]
pub struct MemoryTokens {
    token: Mutex<Option<String>>,
    pub unavailable: AtomicBool,
}

impl MemoryTokens {
    pub fn current(&self) -> Option<String> {
        self.token.lock().unwrap().clone()
    }

    fn check(&self) -> Result<(), ApiError> {
        if self.unavailable.load(Ordering::SeqCst) {
            Err(ApiError::keystore_unavailable())
        } else {
            Ok(())
        }
    }
}

impl TokenStore for MemoryTokens {
    fn load(&self) -> Result<Option<Zeroizing<String>>, ApiError> {
        self.check()?;
        Ok(self.current().map(Zeroizing::new))
    }

    fn save(&self, token: &str) -> Result<(), ApiError> {
        self.check()?;
        *self.token.lock().unwrap() = Some(token.to_string());
        Ok(())
    }

    fn clear(&self) -> Result<(), ApiError> {
        self.check()?;
        *self.token.lock().unwrap() = None;
        Ok(())
    }
}

// ---------- Nachgebildetes Google ----------

/// Zugriffstoken, das das nachgebildete Google ausgibt und verlangt.
pub const ACCESS: &str = "zugang";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FakeEvent {
    pub id: String,
    /// Von der App angelegt (trägt das Kennzeichen `wm`).
    pub managed: bool,
    pub vehicle: Option<String>,
    pub fingerprint: Option<String>,
    pub summary: String,
}

pub struct FakeState {
    pub calendars: BTreeMap<String, Vec<FakeEvent>>,
    counter: u32,
    pub calls: Vec<String>,
    failures: Vec<(&'static str, GoogleError)>,
    pub refresh_error: Option<GoogleError>,
    pub grant_scope: String,
    pub grant_refresh: Option<String>,
    pub grant_email: Option<String>,
    /// (Code, Verifier, Rückleitungsadresse) jedes Tauschs.
    pub exchanged: Vec<(String, String, String)>,
    pub revoked: Vec<String>,
}

pub struct FakeGoogle {
    pub state: Mutex<FakeState>,
}

impl Default for FakeGoogle {
    fn default() -> Self {
        FakeGoogle {
            state: Mutex::new(FakeState {
                calendars: BTreeMap::new(),
                counter: 0,
                calls: Vec::new(),
                failures: Vec::new(),
                refresh_error: None,
                grant_scope: format!("openid email {CALENDAR_SCOPE}"),
                grant_refresh: Some("dauer-1".to_string()),
                grant_email: Some("kollege@gmail.com".to_string()),
                exchanged: Vec::new(),
                revoked: Vec::new(),
            }),
        }
    }
}

impl FakeGoogle {
    /// Der nächste Aufruf dieser Art scheitert mit `error`.
    pub fn fail(&self, method: &'static str, error: GoogleError) {
        self.state.lock().unwrap().failures.push((method, error));
    }

    pub fn calls(&self) -> Vec<String> {
        self.state.lock().unwrap().calls.clone()
    }

    pub fn clear_calls(&self) {
        self.state.lock().unwrap().calls.clear();
    }

    pub fn calendar_ids(&self) -> Vec<String> {
        self.state
            .lock()
            .unwrap()
            .calendars
            .keys()
            .cloned()
            .collect()
    }

    pub fn events(&self, calendar_id: &str) -> Vec<FakeEvent> {
        self.state
            .lock()
            .unwrap()
            .calendars
            .get(calendar_id)
            .cloned()
            .unwrap_or_default()
    }

    /// Ein Termin, den jemand von Hand in den Kalender gelegt hat.
    pub fn add_foreign_event(&self, calendar_id: &str, summary: &str) {
        let mut state = self.state.lock().unwrap();
        state.counter += 1;
        let id = format!("hand-{}", state.counter);
        state
            .calendars
            .get_mut(calendar_id)
            .expect("Kalender vorhanden")
            .push(FakeEvent {
                id,
                managed: false,
                vehicle: None,
                fingerprint: None,
                summary: summary.to_string(),
            });
    }

    /// Ein Termin dieser App, wie ihn ein früherer Lauf hinterlassen hat.
    pub fn add_managed_event(&self, calendar_id: &str, vehicle_id: &str, fingerprint: &str) {
        let mut state = self.state.lock().unwrap();
        state.counter += 1;
        let id = format!("alt-{}", state.counter);
        state
            .calendars
            .get_mut(calendar_id)
            .expect("Kalender vorhanden")
            .push(FakeEvent {
                id,
                managed: true,
                vehicle: Some(vehicle_id.to_string()),
                fingerprint: Some(fingerprint.to_string()),
                summary: "alt".to_string(),
            });
    }

    pub fn delete_calendar_by_hand(&self, calendar_id: &str) {
        self.state.lock().unwrap().calendars.remove(calendar_id);
    }
}

fn take_failure(state: &mut FakeState, method: &str) -> Option<GoogleError> {
    let index = state
        .failures
        .iter()
        .position(|(name, _)| *name == method)?;
    Some(state.failures.remove(index).1)
}

fn begin(
    state: &mut FakeState,
    call: String,
    method: &str,
    access: &str,
) -> Result<(), GoogleError> {
    state.calls.push(call);
    if access != ACCESS {
        return Err(GoogleError::InvalidGrant);
    }
    match take_failure(state, method) {
        Some(error) => Err(error),
        None => Ok(()),
    }
}

impl GoogleApi for FakeGoogle {
    async fn exchange_code(
        &self,
        _creds: &ClientCredentials,
        code: &str,
        verifier: &str,
        redirect_uri: &str,
    ) -> Result<TokenGrant, GoogleError> {
        let mut state = self.state.lock().unwrap();
        state.calls.push("exchange_code".to_string());
        state.exchanged.push((
            code.to_string(),
            verifier.to_string(),
            redirect_uri.to_string(),
        ));
        if let Some(error) = take_failure(&mut state, "exchange_code") {
            return Err(error);
        }
        Ok(TokenGrant {
            access_token: ACCESS.to_string(),
            refresh_token: state.grant_refresh.clone(),
            scope: state.grant_scope.clone(),
            email: state.grant_email.clone(),
        })
    }

    async fn refresh_access_token(
        &self,
        _creds: &ClientCredentials,
        refresh_token: &str,
    ) -> Result<String, GoogleError> {
        let mut state = self.state.lock().unwrap();
        state.calls.push(format!("refresh:{refresh_token}"));
        if let Some(error) = state.refresh_error.clone() {
            return Err(error);
        }
        if let Some(error) = take_failure(&mut state, "refresh") {
            return Err(error);
        }
        Ok(ACCESS.to_string())
    }

    async fn revoke(&self, token: &str) {
        let mut state = self.state.lock().unwrap();
        state.calls.push("revoke".to_string());
        state.revoked.push(token.to_string());
    }

    async fn create_calendar(&self, access: &str) -> Result<String, GoogleError> {
        let mut state = self.state.lock().unwrap();
        begin(
            &mut state,
            "create_calendar".to_string(),
            "create_calendar",
            access,
        )?;
        state.counter += 1;
        let id = format!("kal-{}@group.calendar.google.com", state.counter);
        state.calendars.insert(id.clone(), Vec::new());
        Ok(id)
    }

    async fn delete_calendar(&self, access: &str, calendar_id: &str) -> Result<(), GoogleError> {
        let mut state = self.state.lock().unwrap();
        begin(
            &mut state,
            format!("delete_calendar:{calendar_id}"),
            "delete_calendar",
            access,
        )?;
        state
            .calendars
            .remove(calendar_id)
            .map(|_| ())
            .ok_or(GoogleError::NotFound)
    }

    async fn list_events(
        &self,
        access: &str,
        calendar_id: &str,
    ) -> Result<Vec<RemoteEvent>, GoogleError> {
        let mut state = self.state.lock().unwrap();
        begin(&mut state, "list".to_string(), "list", access)?;
        let events = state
            .calendars
            .get(calendar_id)
            .ok_or(GoogleError::NotFound)?;
        Ok(events
            .iter()
            .filter(|event| event.managed)
            .map(|event| RemoteEvent {
                id: event.id.clone(),
                vehicle_id: event.vehicle.clone(),
                fingerprint: event.fingerprint.clone(),
            })
            .collect())
    }

    async fn insert_event(
        &self,
        access: &str,
        calendar_id: &str,
        event: &DesiredEvent,
    ) -> Result<(), GoogleError> {
        let mut state = self.state.lock().unwrap();
        begin(
            &mut state,
            format!("insert:{}", event.vehicle_id),
            "insert",
            access,
        )?;
        state.counter += 1;
        let id = format!("e-{}", state.counter);
        state
            .calendars
            .get_mut(calendar_id)
            .ok_or(GoogleError::NotFound)?
            .push(FakeEvent {
                id,
                managed: true,
                vehicle: Some(event.vehicle_id.clone()),
                fingerprint: Some(event.fingerprint.clone()),
                summary: event.summary.clone(),
            });
        Ok(())
    }

    async fn update_event(
        &self,
        access: &str,
        calendar_id: &str,
        event_id: &str,
        event: &DesiredEvent,
    ) -> Result<(), GoogleError> {
        let mut state = self.state.lock().unwrap();
        begin(
            &mut state,
            format!("update:{}", event.vehicle_id),
            "update",
            access,
        )?;
        let existing = state
            .calendars
            .get_mut(calendar_id)
            .ok_or(GoogleError::NotFound)?
            .iter_mut()
            .find(|candidate| candidate.id == event_id)
            .ok_or(GoogleError::NotFound)?;
        existing.vehicle = Some(event.vehicle_id.clone());
        existing.fingerprint = Some(event.fingerprint.clone());
        existing.summary = event.summary.clone();
        Ok(())
    }

    async fn delete_event(
        &self,
        access: &str,
        calendar_id: &str,
        event_id: &str,
    ) -> Result<(), GoogleError> {
        let mut state = self.state.lock().unwrap();
        begin(&mut state, format!("delete:{event_id}"), "delete", access)?;
        let events = state
            .calendars
            .get_mut(calendar_id)
            .ok_or(GoogleError::NotFound)?;
        let before = events.len();
        events.retain(|candidate| candidate.id != event_id);
        if events.len() == before {
            Err(GoogleError::NotFound)
        } else {
            Ok(())
        }
    }
}

// ---------- Kleiner HTTP-Server ----------

#[derive(Debug, Clone)]
pub struct Recorded {
    pub method: String,
    pub target: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
}

fn parse_pairs(text: &str) -> HashMap<String, String> {
    reqwest::Url::parse(&format!("http://test.invalid/?{text}"))
        .expect("gültige Testadresse")
        .query_pairs()
        .into_owned()
        .collect()
}

impl Recorded {
    pub fn path(&self) -> &str {
        self.target.split('?').next().unwrap_or_default()
    }

    pub fn query(&self) -> HashMap<String, String> {
        parse_pairs(
            self.target
                .split_once('?')
                .map(|(_, query)| query)
                .unwrap_or_default(),
        )
    }

    pub fn form(&self) -> HashMap<String, String> {
        parse_pairs(&self.body)
    }

    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(key, _)| key.eq_ignore_ascii_case(name))
            .map(|(_, value)| value.as_str())
    }
}

/// Beantwortet jede Anfrage mit dem, was `handler` liefert (Status, JSON-Text), und
/// merkt sich die Anfragen.
pub struct MiniServer {
    pub base: String,
    requests: Arc<Mutex<Vec<Recorded>>>,
    stop: Arc<AtomicBool>,
    port: u16,
}

impl MiniServer {
    pub fn start<H>(handler: H) -> Self
    where
        H: Fn(&Recorded) -> (u16, String) + Send + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let (log, halt) = (Arc::clone(&requests), Arc::clone(&stop));
        thread::spawn(move || {
            for stream in listener.incoming() {
                if halt.load(Ordering::SeqCst) {
                    break;
                }
                let Ok(mut stream) = stream else { continue };
                let Some(request) = read_request(&mut stream) else {
                    continue;
                };
                let (status, body) = handler(&request);
                log.lock().unwrap().push(request);
                let response = format!(
                    "HTTP/1.1 {status} Test\r\nContent-Type: application/json\r\n\
                     Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(response.as_bytes());
                let _ = stream.flush();
            }
        });
        MiniServer {
            base: format!("http://127.0.0.1:{port}"),
            requests,
            stop,
            port,
        }
    }

    pub fn requests(&self) -> Vec<Recorded> {
        self.requests.lock().unwrap().clone()
    }
}

impl Drop for MiniServer {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        let _ = TcpStream::connect(("127.0.0.1", self.port));
    }
}

fn read_request(stream: &mut TcpStream) -> Option<Recorded> {
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    let mut reader = BufReader::new(stream.try_clone().ok()?);
    let mut line = String::new();
    reader.read_line(&mut line).ok()?;
    let mut parts = line.split_whitespace();
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();
    let mut headers = Vec::new();
    loop {
        let mut header = String::new();
        reader.read_line(&mut header).ok()?;
        let header = header.trim_end();
        if header.is_empty() {
            break;
        }
        if let Some((key, value)) = header.split_once(':') {
            headers.push((key.trim().to_ascii_lowercase(), value.trim().to_string()));
        }
    }
    let length = headers
        .iter()
        .find(|(key, _)| key == "content-length")
        .and_then(|(_, value)| value.parse::<usize>().ok())
        .unwrap_or(0);
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).ok()?;
    Some(Recorded {
        method,
        target,
        headers,
        body: String::from_utf8_lossy(&body).into_owned(),
    })
}
