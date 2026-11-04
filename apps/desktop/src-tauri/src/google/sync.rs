//! Die Abläufe: anmelden, abgleichen, trennen.

use std::path::Path;
use std::time::Duration;

use zeroize::Zeroizing;

use super::api::{GoogleApi, TokenGrant};
use super::events::{build_events, plan, DesiredEvent};
use super::oauth;
use super::{
    load_settings, save_settings, ClientCredentials, GoogleError, GoogleSettings, GoogleState,
    TokenStore, CALENDAR_SCOPE,
};
use crate::error::ApiError;
use crate::models::Vehicle;

/// Was jeder Ablauf braucht.
pub struct Context<'a, A: GoogleApi, T: TokenStore> {
    pub api: &'a A,
    pub creds: &'a ClientCredentials,
    pub tokens: &'a T,
    pub settings_path: &'a Path,
}

/// Was ein Abgleich bei Google geändert hat.
#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
#[cfg_attr(not(test), allow(dead_code))]
pub struct Report {
    pub inserted: usize,
    pub updated: usize,
    pub deleted: usize,
}

enum Failure {
    Google(GoogleError),
    Local(ApiError),
}

impl Failure {
    fn message(&self) -> String {
        match self {
            Failure::Google(error) => error.message(),
            Failure::Local(error) => error.message.clone(),
        }
    }

    fn needs_reconnect(&self) -> bool {
        matches!(self, Failure::Google(error) if error.needs_reconnect())
    }
}

/// Bringt den Kalender bei Google auf den Stand von `desired`. Fehlt der Kalender (noch nie
/// angelegt oder bei Google gelöscht), legt der Abgleich ihn an und trägt `calendar_id` ein –
/// auch dann, wenn danach etwas scheitert, damit kein zweiter Kalender entsteht.
pub async fn reconcile<A: GoogleApi>(
    api: &A,
    access: &str,
    calendar_id: &mut Option<String>,
    desired: &[DesiredEvent],
) -> Result<Report, GoogleError> {
    let mut id = match calendar_id.clone() {
        Some(id) => id,
        None => new_calendar(api, access, calendar_id).await?,
    };
    let remote = match api.list_events(access, &id).await {
        Ok(remote) => remote,
        Err(GoogleError::NotFound) => {
            id = new_calendar(api, access, calendar_id).await?;
            Vec::new()
        }
        Err(error) => return Err(error),
    };
    let plan = plan(desired, &remote);
    let mut report = Report::default();
    for event in &plan.insert {
        api.insert_event(access, &id, event).await?;
        report.inserted += 1;
    }
    for (existing, event) in &plan.update {
        match api.update_event(access, &id, &existing.id, event).await {
            Ok(()) => {}
            // Gerade bei Google von Hand gelöscht: neu eintragen.
            Err(GoogleError::NotFound) => api.insert_event(access, &id, event).await?,
            Err(error) => return Err(error),
        }
        report.updated += 1;
    }
    for existing in &plan.delete {
        match api.delete_event(access, &id, &existing.id).await {
            Ok(()) | Err(GoogleError::NotFound) => {}
            Err(error) => return Err(error),
        }
        report.deleted += 1;
    }
    Ok(report)
}

async fn new_calendar<A: GoogleApi>(
    api: &A,
    access: &str,
    slot: &mut Option<String>,
) -> Result<String, GoogleError> {
    let id = api.create_calendar(access).await?;
    *slot = Some(id.clone());
    Ok(id)
}

fn record(settings: &mut GoogleSettings, outcome: Result<(), Failure>, total: usize, now: i64) {
    match outcome {
        Ok(()) => {
            settings.last_sync_at = Some(now);
            settings.last_sync_count = Some(u32::try_from(total).unwrap_or(u32::MAX));
            settings.last_error = None;
            settings.needs_reconnect = false;
        }
        Err(failure) => {
            settings.last_error = Some(failure.message());
            settings.needs_reconnect = failure.needs_reconnect();
        }
    }
}

async fn access_token<A: GoogleApi, T: TokenStore>(
    ctx: &Context<'_, A, T>,
) -> Result<String, Failure> {
    let refresh = ctx
        .tokens
        .load()
        .map_err(Failure::Local)?
        .ok_or(Failure::Google(GoogleError::InvalidGrant))?;
    ctx.api
        .refresh_access_token(ctx.creds, &refresh)
        .await
        .map_err(Failure::Google)
}

/// Gleicht ab, falls verbunden. Ein misslungener Abgleich ist kein Fehler des Befehls: Die
/// Meldung steht danach in den Einstellungen, der nächste Lauf holt alles nach.
pub async fn sync_now<A: GoogleApi, T: TokenStore>(
    ctx: &Context<'_, A, T>,
    vehicles: &[Vehicle],
    now: i64,
) -> Result<GoogleSettings, ApiError> {
    let mut settings = load_settings(ctx.settings_path);
    if !settings.is_connected() {
        return Ok(settings);
    }
    let desired = build_events(vehicles, settings.content);
    let outcome = match access_token(ctx).await {
        Ok(access) => reconcile(ctx.api, &access, &mut settings.calendar_id, &desired)
            .await
            .map(|_| ())
            .map_err(Failure::Google),
        Err(failure) => Err(failure),
    };
    record(&mut settings, outcome, desired.len(), now);
    save_settings(ctx.settings_path, &settings)?;
    Ok(settings)
}

/// Anmeldung im Browser, danach der erste Abgleich. `open` öffnet die Adresse im Browser.
/// Die Fahrzeuge liest `load_vehicles` erst nach der Anmeldung, weil sie Minuten dauern kann;
/// lassen sie sich nicht lesen, entfällt der erste Abgleich (nie mit leerer Liste abgleichen).
/// Bricht der Nutzer ab, ist das Ergebnis `None` und nichts hat sich geändert.
pub async fn connect<A, T, V, O>(
    ctx: &Context<'_, A, T>,
    load_vehicles: V,
    state: &GoogleState,
    open: O,
    timeout: Duration,
    now: i64,
) -> Result<Option<GoogleSettings>, ApiError>
where
    A: GoogleApi,
    T: TokenStore,
    V: FnOnce() -> Result<Vec<Vehicle>, ApiError> + Send,
    O: FnOnce(&str) + Send,
{
    let session = oauth::begin(ctx.creds).await?;
    let code = {
        let pending = state.begin_pending(&session.url)?;
        open(&session.url);
        match oauth::await_callback(&session.listener, &session.state, &pending.cancel, timeout)
            .await
        {
            Ok(code) => code,
            Err(GoogleError::Cancelled) => return Ok(None),
            Err(error) => return Err(error.into()),
        }
    };
    drop(session.listener);

    let TokenGrant {
        access_token,
        refresh_token,
        scope,
        email,
    } = ctx
        .api
        .exchange_code(ctx.creds, &code, &session.verifier, &session.redirect_uri)
        .await?;
    let access_token = Zeroizing::new(access_token);
    if !scope.split_whitespace().any(|item| item == CALENDAR_SCOPE) {
        return Err(GoogleError::MissingCalendarAccess.into());
    }
    let refresh_token = Zeroizing::new(refresh_token.ok_or(GoogleError::NoLongTermAccess)?);
    ctx.tokens.save(&refresh_token)?;

    let previous = load_settings(ctx.settings_path);
    let email = email.unwrap_or_else(|| "Google-Konto".to_string());
    let same_account = previous.email.as_deref() == Some(email.as_str());
    let mut settings = GoogleSettings {
        email: Some(email),
        // Dasselbe Konto erneut verbunden: Der Kalender von vorher wird weiter benutzt.
        calendar_id: previous.calendar_id.filter(|_| same_account),
        content: previous.content,
        ..GoogleSettings::default()
    };
    save_settings(ctx.settings_path, &settings)?;

    let (outcome, total) = match load_vehicles() {
        Ok(vehicles) => {
            let desired = build_events(&vehicles, settings.content);
            let outcome = reconcile(ctx.api, &access_token, &mut settings.calendar_id, &desired)
                .await
                .map(|_| ())
                .map_err(Failure::Google);
            (outcome, desired.len())
        }
        Err(error) => (Err(Failure::Local(error)), 0),
    };
    record(&mut settings, outcome, total, now);
    save_settings(ctx.settings_path, &settings)?;
    Ok(Some(settings))
}

fn not_deleted(error: GoogleError) -> ApiError {
    let reason = match error {
        GoogleError::Network | GoogleError::RateLimited | GoogleError::Server(_) => {
            "Google ist gerade nicht erreichbar.".to_string()
        }
        other => other.message(),
    };
    ApiError::google(&format!(
        "Der Kalender „Werkstatt Motion“ konnte bei Google nicht gelöscht werden. {reason} \
         Die Verbindung bleibt bestehen."
    ))
}

/// Trennt die Verbindung. Mit `delete_calendar` löscht die App vorher ihren Kalender bei
/// Google; gelingt das nicht, bleibt die Verbindung bestehen. Ist der Zugang schon
/// abgelaufen, kann die App den Kalender nicht mehr löschen und räumt nur hier auf.
/// Ohne `delete_calendar` gelingt das Trennen hier immer, auch wenn der Schlüsselspeicher
/// nicht erreichbar ist: Das Token aufzuräumen ist dann nur ein Versuch.
pub async fn disconnect<A: GoogleApi, T: TokenStore>(
    ctx: &Context<'_, A, T>,
    delete_calendar: bool,
) -> Result<GoogleSettings, ApiError> {
    let settings = load_settings(ctx.settings_path);
    let refresh = match ctx.tokens.load() {
        Ok(refresh) => refresh,
        Err(error) if delete_calendar => return Err(error),
        Err(_) => None,
    };
    if delete_calendar {
        if let (Some(calendar_id), Some(refresh)) = (settings.calendar_id.as_deref(), &refresh) {
            match ctx.api.refresh_access_token(ctx.creds, refresh).await {
                Ok(access) => match ctx.api.delete_calendar(&access, calendar_id).await {
                    Ok(()) | Err(GoogleError::NotFound) => {}
                    Err(error) => return Err(not_deleted(error)),
                },
                Err(error) if error.needs_reconnect() => {}
                Err(error) => return Err(not_deleted(error)),
            }
        }
    }
    if let Some(refresh) = &refresh {
        ctx.api.revoke(refresh).await;
    }
    // Ein Token, das liegen bleibt, schadet nicht: Ohne Konto in den Einstellungen benutzt
    // die App es nicht, und die nächste Anmeldung überschreibt es.
    let _ = ctx.tokens.clear();
    let cleared = GoogleSettings {
        content: settings.content,
        ..GoogleSettings::default()
    };
    save_settings(ctx.settings_path, &cleared)?;
    Ok(cleared)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::google::events::build_events;
    use crate::google::testing::{credentials, vehicle, FakeGoogle, MemoryTokens, ACCESS};
    use crate::google::{Content, SETTINGS_FILE};
    use std::io::{Read, Write};
    use std::path::PathBuf;
    use std::sync::Arc;

    struct Setup {
        _dir: tempfile::TempDir,
        path: PathBuf,
        api: FakeGoogle,
        tokens: MemoryTokens,
        creds: ClientCredentials,
    }

    impl Setup {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join(SETTINGS_FILE);
            Setup {
                _dir: dir,
                path,
                api: FakeGoogle::default(),
                tokens: MemoryTokens::default(),
                creds: credentials(),
            }
        }

        /// Schon verbunden, noch ohne Kalender.
        fn connected() -> Self {
            let setup = Setup::new();
            setup.tokens.save("dauer-1").unwrap();
            save_settings(
                &setup.path,
                &GoogleSettings {
                    email: Some("kollege@gmail.com".to_string()),
                    ..GoogleSettings::default()
                },
            )
            .unwrap();
            setup
        }

        fn ctx(&self) -> Context<'_, FakeGoogle, MemoryTokens> {
            Context {
                api: &self.api,
                creds: &self.creds,
                tokens: &self.tokens,
                settings_path: &self.path,
            }
        }

        fn settings(&self) -> GoogleSettings {
            load_settings(&self.path)
        }

        fn sync(&self, vehicles: &[Vehicle], now: i64) -> GoogleSettings {
            tauri::async_runtime::block_on(sync_now(&self.ctx(), vehicles, now)).unwrap()
        }

        fn calendar(&self) -> String {
            self.settings().calendar_id.expect("Kalender angelegt")
        }

        fn summaries(&self) -> Vec<String> {
            let mut list: Vec<_> = self
                .api
                .events(&self.calendar())
                .into_iter()
                .map(|event| event.summary)
                .collect();
            list.sort();
            list
        }
    }

    fn workshop() -> Vec<Vehicle> {
        vec![
            vehicle("a", Some("2026-11-05T14:00")),
            vehicle("b", Some("2026-11-05T15:30")),
            vehicle("c", Some("2026-11-06")),
            vehicle("ohne", None),
        ]
    }

    #[test]
    fn erster_abgleich_legt_kalender_und_termine_an() {
        let setup = Setup::connected();
        let settings = setup.sync(&workshop(), 1_000);

        assert_eq!(setup.api.calendar_ids().len(), 1);
        assert_eq!(settings.last_sync_at, Some(1_000));
        assert_eq!(settings.last_sync_count, Some(3));
        assert_eq!(settings.last_error, None);
        assert_eq!(setup.summaries(), vec!["Auto a", "Auto b", "Auto c"]);
        assert_eq!(setup.settings(), settings, "der Stand ist gespeichert");
        assert!(setup.api.calls().contains(&"refresh:dauer-1".to_string()));
    }

    #[test]
    fn zweiter_abgleich_ohne_aenderung_schreibt_nichts() {
        let setup = Setup::connected();
        setup.sync(&workshop(), 1_000);
        setup.api.clear_calls();
        let settings = setup.sync(&workshop(), 2_000);
        assert_eq!(setup.api.calls(), vec!["refresh:dauer-1", "list"]);
        assert_eq!(settings.last_sync_at, Some(2_000));
    }

    #[test]
    fn aenderungen_in_der_app_kommen_bei_google_an() {
        let setup = Setup::connected();
        setup.sync(&workshop(), 1_000);

        let mut changed = workshop();
        changed[0].appointment_at = Some("2026-11-05T16:00".to_string());
        changed[0].vehicle_name = "Auto a neu".to_string();
        changed.remove(1);
        changed.push(vehicle("d", Some("2026-11-07T08:00")));
        setup.api.clear_calls();
        let settings = setup.sync(&changed, 2_000);

        let calls = setup.api.calls();
        assert!(calls.contains(&"update:a".to_string()));
        assert!(calls.contains(&"insert:d".to_string()));
        assert_eq!(
            calls
                .iter()
                .filter(|call| call.starts_with("delete:"))
                .count(),
            1
        );
        assert_eq!(setup.summaries(), vec!["Auto a neu", "Auto c", "Auto d"]);
        assert_eq!(settings.last_sync_count, Some(3));
    }

    #[test]
    fn termine_von_hand_im_kalender_bleiben_unberuehrt() {
        let setup = Setup::connected();
        setup.sync(&workshop(), 1_000);
        setup.api.add_foreign_event(&setup.calendar(), "Zahnarzt");
        setup.sync(&[], 2_000);
        assert_eq!(setup.summaries(), vec!["Zahnarzt"]);
    }

    #[test]
    fn bei_google_geloeschter_kalender_wird_neu_angelegt() {
        let setup = Setup::connected();
        setup.sync(&workshop(), 1_000);
        let first = setup.calendar();
        setup.api.delete_calendar_by_hand(&first);

        let settings = setup.sync(&workshop(), 2_000);
        let second = settings.calendar_id.clone().unwrap();
        assert_ne!(first, second);
        assert_eq!(setup.api.calendar_ids(), vec![second]);
        assert_eq!(setup.summaries().len(), 3);
        assert_eq!(settings.last_error, None);
    }

    #[test]
    fn bei_google_geloeschter_termin_wird_beim_aendern_neu_eingetragen() {
        let setup = Setup::connected();
        setup.sync(&workshop(), 1_000);
        let calendar = setup.calendar();
        {
            let mut state = setup.api.state.lock().unwrap();
            let event = state
                .calendars
                .get_mut(&calendar)
                .unwrap()
                .iter_mut()
                .find(|event| event.vehicle.as_deref() == Some("a"))
                .unwrap();
            event.fingerprint = Some("veraltet".to_string());
        }
        // Zwischen Lesen und Ändern löscht jemand den Termin bei Google.
        setup.api.fail("update", GoogleError::NotFound);
        setup.api.clear_calls();
        let settings = setup.sync(&workshop(), 2_000);
        assert_eq!(settings.last_error, None);
        let calls = setup.api.calls();
        assert!(calls.contains(&"update:a".to_string()));
        assert!(calls.contains(&"insert:a".to_string()));
    }

    #[test]
    fn abgelaufener_zugang_verlangt_neue_anmeldung() {
        let setup = Setup::connected();
        setup.api.state.lock().unwrap().refresh_error = Some(GoogleError::InvalidGrant);
        let settings = setup.sync(&workshop(), 1_000);
        assert!(settings.needs_reconnect);
        assert_eq!(
            settings.last_error,
            Some(GoogleError::InvalidGrant.message())
        );
        assert_eq!(settings.last_sync_at, None);
        assert!(setup.api.calendar_ids().is_empty());
        assert!(settings.is_connected(), "die Verbindung bleibt eingetragen");
    }

    #[test]
    fn fehlendes_token_verlangt_neue_anmeldung() {
        let setup = Setup::connected();
        setup.tokens.clear().unwrap();
        let settings = setup.sync(&workshop(), 1_000);
        assert!(settings.needs_reconnect);
        assert!(setup.api.calls().is_empty());
    }

    #[test]
    fn nicht_erreichbarer_schluesselspeicher_wird_gemeldet() {
        let setup = Setup::connected();
        setup
            .tokens
            .unavailable
            .store(true, std::sync::atomic::Ordering::SeqCst);
        let settings = setup.sync(&workshop(), 1_000);
        assert_eq!(
            settings.last_error.as_deref(),
            Some(ApiError::keystore_unavailable().message.as_str())
        );
        assert!(!settings.needs_reconnect);
    }

    #[test]
    fn ohne_netz_bleibt_der_letzte_gute_stand_und_ein_hinweis() {
        let setup = Setup::connected();
        setup.sync(&workshop(), 1_000);
        setup.api.fail("list", GoogleError::Network);
        let settings = setup.sync(&workshop(), 2_000);
        assert_eq!(settings.last_sync_at, Some(1_000));
        assert_eq!(settings.last_error, Some(GoogleError::Network.message()));
        assert!(!settings.needs_reconnect);

        let settings = setup.sync(&workshop(), 3_000);
        assert_eq!(settings.last_sync_at, Some(3_000));
        assert_eq!(settings.last_error, None);
    }

    #[test]
    fn abgebrochener_lauf_wird_ohne_doppelte_termine_nachgeholt() {
        let setup = Setup::connected();
        setup.api.fail("insert", GoogleError::Network);
        let failed = setup.sync(&workshop(), 1_000);
        assert!(failed.last_error.is_some());
        // Der Kalender ist schon angelegt und gemerkt: kein zweiter beim nächsten Lauf.
        assert!(failed.calendar_id.is_some());

        setup.sync(&workshop(), 2_000);
        assert_eq!(setup.api.calendar_ids().len(), 1);
        assert_eq!(setup.summaries(), vec!["Auto a", "Auto b", "Auto c"]);
    }

    #[test]
    fn doppelte_termine_aus_frueheren_laeufen_verschwinden() {
        let setup = Setup::connected();
        setup.sync(&workshop(), 1_000);
        let calendar = setup.calendar();
        let fingerprint = build_events(&workshop(), Content::Short)[0]
            .fingerprint
            .clone();
        setup.api.add_managed_event(&calendar, "a", &fingerprint);
        setup.sync(&workshop(), 2_000);
        assert_eq!(setup.summaries().len(), 3);
    }

    #[test]
    fn nicht_verbunden_heisst_nichts_tun() {
        let setup = Setup::new();
        let settings = setup.sync(&workshop(), 1_000);
        assert!(!settings.is_connected());
        assert!(setup.api.calls().is_empty());
        assert!(!setup.path.exists(), "ohne Verbindung entsteht keine Datei");
    }

    #[test]
    fn gewechselter_inhalt_schreibt_beim_naechsten_abgleich_alle_titel_neu() {
        let setup = Setup::connected();
        setup.sync(&workshop(), 1_000);
        save_settings(
            &setup.path,
            &GoogleSettings {
                content: Content::Full,
                ..setup.settings()
            },
        )
        .unwrap();
        setup.api.clear_calls();
        let settings = setup.sync(&workshop(), 2_000);
        assert_eq!(settings.content, Content::Full);
        assert_eq!(
            setup
                .api
                .calls()
                .iter()
                .filter(|call| call.starts_with("update:"))
                .count(),
            3
        );
        assert_eq!(
            setup.summaries(),
            vec![
                "Kunde a – Auto a · AB-a 1",
                "Kunde b – Auto b · AB-b 1",
                "Kunde c – Auto c · AB-c 1"
            ]
        );
    }

    // ---------- Anmelden ----------

    /// Spielt den Browser: Er folgt der Anmeldeadresse und landet mit `code` auf der
    /// Rückleitungsadresse – oder mit `error`, wenn `deny` gesetzt ist.
    fn browser(code: &'static str, deny: bool) -> impl FnOnce(&str) + Send {
        move |url: &str| {
            let url = reqwest::Url::parse(url).unwrap();
            let pairs: std::collections::HashMap<String, String> =
                url.query_pairs().into_owned().collect();
            let redirect = reqwest::Url::parse(&pairs["redirect_uri"]).unwrap();
            let port = redirect.port().unwrap();
            let state = pairs["state"].clone();
            std::thread::spawn(move || {
                let query = if deny {
                    format!("error=access_denied&state={state}")
                } else {
                    format!("state={state}&code={code}&scope=x")
                };
                let mut stream = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
                write!(stream, "GET /?{query} HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n").unwrap();
                let mut answer = String::new();
                let _ = stream.read_to_string(&mut answer);
            });
        }
    }

    fn connect_with(
        setup: &Setup,
        state: &GoogleState,
        open: impl FnOnce(&str) + Send,
    ) -> Result<Option<GoogleSettings>, ApiError> {
        tauri::async_runtime::block_on(connect(
            &setup.ctx(),
            || Ok(workshop()),
            state,
            open,
            Duration::from_secs(20),
            5_000,
        ))
    }

    #[test]
    fn ohne_lesbare_fahrzeuge_kein_erster_abgleich() {
        let setup = Setup::new();
        let result = tauri::async_runtime::block_on(connect(
            &setup.ctx(),
            || Err(ApiError::database("Die Datenbank ist nicht verfügbar")),
            &GoogleState::default(),
            browser("c", false),
            Duration::from_secs(20),
            5_000,
        ))
        .unwrap()
        .unwrap();
        assert!(result.is_connected());
        assert_eq!(
            result.last_error.as_deref(),
            Some("Die Datenbank ist nicht verfügbar")
        );
        assert!(
            setup.api.calendar_ids().is_empty(),
            "nie mit leerer Liste abgleichen"
        );
    }

    #[test]
    fn anmelden_speichert_zugang_und_gleicht_gleich_ab() {
        let setup = Setup::new();
        let state = GoogleState::default();
        let mut opened = String::new();
        let open = browser("code-123", false);
        let result = connect_with(&setup, &state, |url| {
            opened = url.to_string();
            open(url);
        })
        .unwrap()
        .unwrap();

        assert_eq!(result.email.as_deref(), Some("kollege@gmail.com"));
        assert_eq!(result.last_sync_count, Some(3));
        assert_eq!(result.last_sync_at, Some(5_000));
        assert_eq!(setup.tokens.current().as_deref(), Some("dauer-1"));
        assert_eq!(setup.settings(), result);
        assert_eq!(setup.summaries().len(), 3);
        assert_eq!(state.pending_url(), None, "die Anmeldung ist abgeschlossen");

        // PKCE stimmt: Der Verifier passt zur Challenge der Adresse, die Rückleitung zur
        // Adresse des Anschlusses.
        let (code, verifier, redirect) = setup.api.state.lock().unwrap().exchanged[0].clone();
        assert_eq!(code, "code-123");
        let url = reqwest::Url::parse(&opened).unwrap();
        let pairs: std::collections::HashMap<String, String> =
            url.query_pairs().into_owned().collect();
        assert_eq!(pairs["code_challenge"], oauth::pkce_challenge(&verifier));
        assert_eq!(pairs["redirect_uri"], redirect);
    }

    #[test]
    fn anmelden_ohne_kalender_haekchen_scheitert_ohne_spuren() {
        let setup = Setup::new();
        setup.api.state.lock().unwrap().grant_scope = "openid email".to_string();
        let error = connect_with(&setup, &GoogleState::default(), browser("c", false)).unwrap_err();
        assert_eq!(error.message, GoogleError::MissingCalendarAccess.message());
        assert_eq!(setup.tokens.current(), None);
        assert!(!setup.settings().is_connected());
        assert!(setup.api.calendar_ids().is_empty());
    }

    #[test]
    fn anmelden_ohne_dauerhaften_zugang_scheitert() {
        let setup = Setup::new();
        setup.api.state.lock().unwrap().grant_refresh = None;
        let error = connect_with(&setup, &GoogleState::default(), browser("c", false)).unwrap_err();
        assert_eq!(error.message, GoogleError::NoLongTermAccess.message());
        assert!(!setup.settings().is_connected());
    }

    #[test]
    fn verweigerte_anmeldung_wird_gemeldet() {
        let setup = Setup::new();
        let error = connect_with(&setup, &GoogleState::default(), browser("c", true)).unwrap_err();
        assert_eq!(error.message, GoogleError::Denied.message());
        assert!(setup.api.calls().is_empty());
    }

    #[test]
    fn abgebrochene_anmeldung_aendert_nichts() {
        let setup = Setup::new();
        let state = Arc::new(GoogleState::default());
        let canceller = Arc::clone(&state);
        let result = connect_with(&setup, &state, move |_| {
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(200));
                canceller.cancel();
            });
        })
        .unwrap();
        assert_eq!(result, None);
        assert!(!setup.settings().is_connected());
        assert_eq!(state.pending_url(), None);
        assert!(setup.api.calls().is_empty());
    }

    #[test]
    fn misslungener_erster_abgleich_laesst_die_verbindung_stehen() {
        let setup = Setup::new();
        setup.api.fail("create_calendar", GoogleError::ApiDisabled);
        let result = connect_with(&setup, &GoogleState::default(), browser("c", false))
            .unwrap()
            .unwrap();
        assert!(result.is_connected());
        assert_eq!(result.last_error, Some(GoogleError::ApiDisabled.message()));
        assert_eq!(setup.tokens.current().as_deref(), Some("dauer-1"));
    }

    #[test]
    fn erneute_anmeldung_mit_demselben_konto_nutzt_den_kalender_weiter() {
        let setup = Setup::new();
        let first = connect_with(&setup, &GoogleState::default(), browser("c1", false))
            .unwrap()
            .unwrap();
        let second = connect_with(&setup, &GoogleState::default(), browser("c2", false))
            .unwrap()
            .unwrap();
        assert_eq!(first.calendar_id, second.calendar_id);
        assert_eq!(setup.api.calendar_ids().len(), 1);
        assert_eq!(setup.summaries().len(), 3);

        setup.api.state.lock().unwrap().grant_email = Some("andere@gmail.com".to_string());
        let third = connect_with(&setup, &GoogleState::default(), browser("c3", false))
            .unwrap()
            .unwrap();
        assert_ne!(third.calendar_id, first.calendar_id);
        assert_eq!(third.email.as_deref(), Some("andere@gmail.com"));
    }

    #[test]
    fn gewaehlter_inhalt_bleibt_ueber_die_anmeldung_erhalten() {
        let setup = Setup::new();
        save_settings(
            &setup.path,
            &GoogleSettings {
                content: Content::Full,
                ..GoogleSettings::default()
            },
        )
        .unwrap();
        let result = connect_with(&setup, &GoogleState::default(), browser("c", false))
            .unwrap()
            .unwrap();
        assert_eq!(result.content, Content::Full);
        assert!(setup.summaries()[0].starts_with("Kunde "));
    }

    // ---------- Trennen ----------

    fn disconnect_with(setup: &Setup, delete_calendar: bool) -> Result<GoogleSettings, ApiError> {
        tauri::async_runtime::block_on(disconnect(&setup.ctx(), delete_calendar))
    }

    #[test]
    fn trennen_loescht_kalender_und_zugang() {
        let setup = Setup::connected();
        setup.sync(&workshop(), 1_000);
        save_settings(
            &setup.path,
            &GoogleSettings {
                content: Content::Full,
                ..setup.settings()
            },
        )
        .unwrap();
        let calendar = setup.calendar();

        let settings = disconnect_with(&setup, true).unwrap();
        assert!(!settings.is_connected());
        assert_eq!(
            settings.content,
            Content::Full,
            "die Wahl des Inhalts bleibt"
        );
        assert_eq!(settings.calendar_id, None);
        assert!(setup.api.calendar_ids().is_empty());
        assert!(setup
            .api
            .calls()
            .contains(&format!("delete_calendar:{calendar}")));
        assert_eq!(setup.api.state.lock().unwrap().revoked, vec!["dauer-1"]);
        assert_eq!(setup.tokens.current(), None);
        assert_eq!(setup.settings(), settings);
    }

    #[test]
    fn trennen_ohne_netz_laesst_alles_wie_es_war() {
        let setup = Setup::connected();
        setup.sync(&workshop(), 1_000);
        let before = setup.settings();
        setup.api.fail("delete_calendar", GoogleError::Network);

        let error = disconnect_with(&setup, true).unwrap_err();
        assert!(error.message.contains("nicht gelöscht"));
        assert!(error.message.contains("bleibt bestehen"));
        assert_eq!(setup.settings(), before);
        assert_eq!(setup.tokens.current().as_deref(), Some("dauer-1"));
        assert!(setup.api.state.lock().unwrap().revoked.is_empty());
    }

    #[test]
    fn nur_hier_trennen_laesst_den_kalender_bei_google() {
        let setup = Setup::connected();
        setup.sync(&workshop(), 1_000);
        let settings = disconnect_with(&setup, false).unwrap();
        assert!(!settings.is_connected());
        assert_eq!(setup.api.calendar_ids().len(), 1);
        assert!(!setup
            .api
            .calls()
            .iter()
            .any(|call| call.starts_with("delete_calendar")));
        assert_eq!(setup.tokens.current(), None);
    }

    #[test]
    fn trennen_mit_abgelaufenem_zugang_raeumt_trotzdem_auf() {
        let setup = Setup::connected();
        setup.sync(&workshop(), 1_000);
        setup.api.state.lock().unwrap().refresh_error = Some(GoogleError::InvalidGrant);
        let settings = disconnect_with(&setup, true).unwrap();
        assert!(!settings.is_connected());
        assert_eq!(setup.tokens.current(), None);
    }

    #[test]
    fn trennen_wenn_der_kalender_schon_weg_ist() {
        let setup = Setup::connected();
        setup.sync(&workshop(), 1_000);
        setup.api.delete_calendar_by_hand(&setup.calendar());
        assert!(!disconnect_with(&setup, true).unwrap().is_connected());
    }

    #[test]
    fn nur_hier_trennen_klappt_auch_ohne_schluesselspeicher() {
        let setup = Setup::connected();
        setup.sync(&workshop(), 1_000);
        setup
            .tokens
            .unavailable
            .store(true, std::sync::atomic::Ordering::SeqCst);

        let error = disconnect_with(&setup, true).unwrap_err();
        assert_eq!(error.message, ApiError::keystore_unavailable().message);
        assert!(
            setup.settings().is_connected(),
            "Löschen bei Google braucht den Zugang"
        );

        let settings = disconnect_with(&setup, false).unwrap();
        assert!(!settings.is_connected());
        assert_eq!(setup.settings(), settings);
    }

    #[test]
    fn trennen_ohne_verbindung_schadet_nicht() {
        let setup = Setup::new();
        let settings = disconnect_with(&setup, true).unwrap();
        assert!(!settings.is_connected());
        assert!(setup.api.calls().is_empty());
    }

    #[test]
    fn das_nachgebildete_google_verlangt_den_frischen_zugang() {
        // Gegenprobe für die Tests oben: Ein falsches Zugriffstoken fällt auf.
        let api = FakeGoogle::default();
        let result = tauri::async_runtime::block_on(api.create_calendar("falsch"));
        assert_eq!(result, Err(GoogleError::InvalidGrant));
        assert_eq!(
            tauri::async_runtime::block_on(api.create_calendar(ACCESS)).map(|id| id.is_empty()),
            Ok(false)
        );
    }
}
