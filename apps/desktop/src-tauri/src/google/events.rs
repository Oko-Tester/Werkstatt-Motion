//! Aus Fahrzeugen werden Termine für Google Kalender – rein rechnerisch, ohne Netz.
//!
//! Ein Termin mit Uhrzeit dauert eine Stunde, einer ohne Uhrzeit wird ganztägig.
//! Jeder Termin trägt bei Google drei private Eigenschaften: `wm` (gehört zu dieser
//! App), `vehicle` (Kennung des Fahrzeugs) und `fp` (Fingerabdruck des Inhalts).
//! Damit erkennt der Abgleich ohne weitere Ablage, was neu ist, was sich geändert
//! hat und was weg muss; Termine, die jemand von Hand in den Kalender gelegt hat,
//! fasst er nicht an.

use std::collections::{HashMap, HashSet};

use serde::Serialize;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use super::Content;
use crate::models::Vehicle;

/// Die Termine der App sind Ortszeit ohne Zeitzone. Die App ist für Werkstätten in
/// Deutschland, Österreich und der Schweiz gemacht; dort gilt überall diese Zeit.
pub const TIME_ZONE: &str = "Europe/Berlin";

/// Dauer eines Termins mit Uhrzeit.
const DURATION_HOURS: u32 = 1;

/// Steigt, wenn sich ändert, wie ein Termin bei Google aussieht: Dann werden alle
/// Termine beim nächsten Abgleich neu geschrieben.
const FORMAT_VERSION: &str = "1";

/// Kennzeichen der App-Termine bei Google.
pub const MARK_KEY: &str = "wm";
pub const MARK_VALUE: &str = "1";

/// Text, wenn ein Termin sonst keinen Titel hätte.
const FALLBACK_TITLE: &str = "Werkstatttermin";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EventTime {
    /// Ganzer Tag, `YYYY-MM-DD`. Das Ende ist bei Google der Folgetag (exklusiv).
    Day(String),
    /// Ortszeit ohne Zeitzone, `YYYY-MM-DDTHH:MM:00`.
    Moment(String),
}

impl EventTime {
    fn key(&self) -> String {
        match self {
            EventTime::Day(day) => format!("D{day}"),
            EventTime::Moment(moment) => format!("T{moment}"),
        }
    }

    fn to_json(&self) -> Value {
        match self {
            EventTime::Day(day) => json!({ "date": day }),
            EventTime::Moment(moment) => json!({ "dateTime": moment, "timeZone": TIME_ZONE }),
        }
    }

    /// Sortierschlüssel: Ganztägige Termine stehen vor denen mit Uhrzeit am selben Tag.
    fn sort_text(&self) -> &str {
        match self {
            EventTime::Day(day) => day,
            EventTime::Moment(moment) => moment,
        }
    }
}

/// So soll ein Termin bei Google stehen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DesiredEvent {
    pub vehicle_id: String,
    pub summary: String,
    pub start: EventTime,
    pub end: EventTime,
    pub fingerprint: String,
}

impl DesiredEvent {
    /// Der Termin, wie er an Google geht.
    pub fn to_json(&self) -> Value {
        json!({
            "summary": self.summary,
            "start": self.start.to_json(),
            "end": self.end.to_json(),
            "extendedProperties": {
                "private": {
                    MARK_KEY: MARK_VALUE,
                    "vehicle": self.vehicle_id,
                    "fp": self.fingerprint,
                }
            }
        })
    }
}

/// Ein Termin für die Vorschau in den Einstellungen.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PreviewEvent {
    /// `YYYY-MM-DD`
    pub date: String,
    /// `HH:MM`, ohne Uhrzeit leer
    pub time: Option<String>,
    /// `HH:MM` des Endes, ohne Uhrzeit leer
    pub end_time: Option<String>,
    pub title: String,
}

impl From<&DesiredEvent> for PreviewEvent {
    fn from(event: &DesiredEvent) -> Self {
        let clock = |time: &EventTime| match time {
            EventTime::Day(_) => None,
            EventTime::Moment(moment) => moment.get(11..16).map(str::to_string),
        };
        let date = match &event.start {
            EventTime::Day(day) => day.clone(),
            EventTime::Moment(moment) => moment.get(0..10).unwrap_or_default().to_string(),
        };
        PreviewEvent {
            date,
            time: clock(&event.start),
            end_time: clock(&event.end),
            title: event.summary.clone(),
        }
    }
}

/// Ein Termin dieser App, wie er gerade bei Google steht.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RemoteEvent {
    pub id: String,
    pub vehicle_id: Option<String>,
    pub fingerprint: Option<String>,
}

/// Liest die Termine dieser App aus einer Antwortseite von `events.list`.
pub fn parse_remote_events(page: &Value) -> Vec<RemoteEvent> {
    page.get("items")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|item| {
            let id = item.get("id")?.as_str()?.to_string();
            let private = item.pointer("/extendedProperties/private")?;
            if private.get(MARK_KEY)?.as_str()? != MARK_VALUE {
                return None;
            }
            let text = |key: &str| private.get(key).and_then(Value::as_str).map(str::to_string);
            Some(RemoteEvent {
                id,
                vehicle_id: text("vehicle"),
                fingerprint: text("fp"),
            })
        })
        .collect()
}

/// Alle Termine, die bei Google stehen sollen, nach Zeit sortiert.
pub fn build_events(vehicles: &[Vehicle], content: Content) -> Vec<DesiredEvent> {
    let mut events: Vec<DesiredEvent> = vehicles
        .iter()
        .filter(|vehicle| vehicle.archived_at.is_none())
        .filter_map(|vehicle| build_event(vehicle, content))
        .collect();
    events.sort_by(|left, right| {
        left.start
            .sort_text()
            .cmp(right.start.sort_text())
            .then_with(|| left.vehicle_id.cmp(&right.vehicle_id))
    });
    events
}

pub fn build_event(vehicle: &Vehicle, content: Content) -> Option<DesiredEvent> {
    let (day, time) = parse_appointment(vehicle.appointment_at.as_deref()?)?;
    let (start, end) = match time {
        None => (EventTime::Day(day.iso()), EventTime::Day(day.next().iso())),
        Some((hour, minute)) => {
            let (end_day, end_hour) = if hour + DURATION_HOURS > 23 {
                (day.next(), hour + DURATION_HOURS - 24)
            } else {
                (day, hour + DURATION_HOURS)
            };
            (
                EventTime::Moment(format!("{}T{hour:02}:{minute:02}:00", day.iso())),
                EventTime::Moment(format!("{}T{end_hour:02}:{minute:02}:00", end_day.iso())),
            )
        }
    };
    let summary = summary(vehicle, content);
    let fingerprint = fingerprint(&summary, &start, &end);
    Some(DesiredEvent {
        vehicle_id: vehicle.id.clone(),
        summary,
        start,
        end,
        fingerprint,
    })
}

fn summary(vehicle: &Vehicle, content: Content) -> String {
    let vehicle_name = vehicle.vehicle_name.trim();
    let text = match content {
        Content::Short => vehicle_name.to_string(),
        Content::Full => {
            let mut text = vehicle.customer_name.trim().to_string();
            for (separator, part) in [(" – ", vehicle_name), (" · ", vehicle.license_plate.trim())]
            {
                if part.is_empty() {
                    continue;
                }
                if !text.is_empty() {
                    text.push_str(separator);
                }
                text.push_str(part);
            }
            text
        }
    };
    if text.is_empty() {
        FALLBACK_TITLE.to_string()
    } else {
        text
    }
}

fn fingerprint(summary: &str, start: &EventTime, end: &EventTime) -> String {
    let mut hasher = Sha256::new();
    for part in [FORMAT_VERSION, summary, &start.key(), &end.key()] {
        hasher.update(part.as_bytes());
        hasher.update([0u8]);
    }
    hasher
        .finalize()
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Was der Abgleich bei Google tun muss.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Plan<'a> {
    pub insert: Vec<&'a DesiredEvent>,
    pub update: Vec<(&'a RemoteEvent, &'a DesiredEvent)>,
    pub delete: Vec<&'a RemoteEvent>,
}

#[cfg(test)]
impl Plan<'_> {
    pub fn is_empty(&self) -> bool {
        self.insert.is_empty() && self.update.is_empty() && self.delete.is_empty()
    }
}

/// Vergleicht Soll und Ist. Doppelte App-Termine für dasselbe Fahrzeug (etwa nach einem
/// abgebrochenen Lauf) werden bis auf einen gelöscht.
pub fn plan<'a>(desired: &'a [DesiredEvent], remote: &'a [RemoteEvent]) -> Plan<'a> {
    let wanted: HashMap<&str, &DesiredEvent> = desired
        .iter()
        .map(|event| (event.vehicle_id.as_str(), event))
        .collect();
    let mut seen: HashSet<&str> = HashSet::new();
    let mut result = Plan::default();
    for existing in remote {
        let target = existing
            .vehicle_id
            .as_deref()
            .and_then(|id| wanted.get_key_value(id));
        match target {
            Some((&vehicle_id, &event)) if seen.insert(vehicle_id) => {
                if existing.fingerprint.as_deref() != Some(event.fingerprint.as_str()) {
                    result.update.push((existing, event));
                }
            }
            _ => result.delete.push(existing),
        }
    }
    result.insert = desired
        .iter()
        .filter(|event| !seen.contains(event.vehicle_id.as_str()))
        .collect();
    result
}

/// Ein Kalendertag.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Day {
    year: u32,
    month: u32,
    day: u32,
}

impl Day {
    fn iso(self) -> String {
        format!("{:04}-{:02}-{:02}", self.year, self.month, self.day)
    }

    fn next(self) -> Day {
        if self.day < days_in_month(self.year, self.month) {
            Day {
                day: self.day + 1,
                ..self
            }
        } else if self.month < 12 {
            Day {
                month: self.month + 1,
                day: 1,
                ..self
            }
        } else {
            Day {
                year: self.year + 1,
                month: 1,
                day: 1,
            }
        }
    }
}

fn days_in_month(year: u32, month: u32) -> u32 {
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    }
}

fn digits(text: Option<&str>) -> Option<u32> {
    let text = text?;
    if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    text.parse().ok()
}

/// Liest `YYYY-MM-DD` oder `YYYY-MM-DDTHH:mm`, wie die Datenbank es speichert. Alles andere
/// ergibt keinen Termin – lieber einer weniger bei Google als ein falscher.
fn parse_appointment(value: &str) -> Option<(Day, Option<(u32, u32)>)> {
    if value.len() != 10 && value.len() != 16 {
        return None;
    }
    if value.get(4..5)? != "-" || value.get(7..8)? != "-" {
        return None;
    }
    let year = digits(value.get(0..4))?;
    let month = digits(value.get(5..7))?;
    let day = digits(value.get(8..10))?;
    if year == 0 || !(1..=12).contains(&month) || day == 0 || day > days_in_month(year, month) {
        return None;
    }
    let date = Day { year, month, day };
    if value.len() == 10 {
        return Some((date, None));
    }
    if value.get(10..11)? != "T" || value.get(13..14)? != ":" {
        return None;
    }
    let hour = digits(value.get(11..13))?;
    let minute = digits(value.get(14..16))?;
    if hour > 23 || minute > 59 {
        return None;
    }
    Some((date, Some((hour, minute))))
}

#[cfg(test)]
mod tests {
    use super::*;

    pub fn vehicle(id: &str, appointment: Option<&str>) -> Vehicle {
        Vehicle {
            id: id.to_string(),
            customer_name: "Müller".to_string(),
            vehicle_name: "VW Golf".to_string(),
            license_plate: "AB-CD 123".to_string(),
            note: "Kunde zahlt bar, Schlüssel im Kasten".to_string(),
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

    fn moment(text: &str) -> EventTime {
        EventTime::Moment(text.to_string())
    }

    fn day(text: &str) -> EventTime {
        EventTime::Day(text.to_string())
    }

    #[test]
    fn termin_mit_uhrzeit_dauert_eine_stunde() {
        let event = build_event(&vehicle("v1", Some("2026-11-05T14:00")), Content::Short).unwrap();
        assert_eq!(event.start, moment("2026-11-05T14:00:00"));
        assert_eq!(event.end, moment("2026-11-05T15:00:00"));
        assert_eq!(event.summary, "VW Golf");
        assert_eq!(event.vehicle_id, "v1");
    }

    #[test]
    fn termin_ohne_uhrzeit_ist_ganztaegig() {
        let event = build_event(&vehicle("v1", Some("2026-11-06")), Content::Short).unwrap();
        assert_eq!(event.start, day("2026-11-06"));
        assert_eq!(event.end, day("2026-11-07"));
    }

    #[test]
    fn spaete_termine_enden_am_folgetag() {
        let cases = [
            (
                "2026-11-05T23:30",
                "2026-11-05T23:30:00",
                "2026-11-06T00:30:00",
            ),
            (
                "2026-11-30T23:00",
                "2026-11-30T23:00:00",
                "2026-12-01T00:00:00",
            ),
            (
                "2026-12-31T23:15",
                "2026-12-31T23:15:00",
                "2027-01-01T00:15:00",
            ),
            (
                "2028-02-28T23:00",
                "2028-02-28T23:00:00",
                "2028-02-29T00:00:00",
            ),
            (
                "2027-02-28T23:00",
                "2027-02-28T23:00:00",
                "2027-03-01T00:00:00",
            ),
            (
                "2026-11-05T22:59",
                "2026-11-05T22:59:00",
                "2026-11-05T23:59:00",
            ),
        ];
        for (input, start, end) in cases {
            let event = build_event(&vehicle("v", Some(input)), Content::Short).unwrap();
            assert_eq!(event.start, moment(start), "{input}");
            assert_eq!(event.end, moment(end), "{input}");
        }
    }

    #[test]
    fn ganztaegige_termine_am_monats_und_jahresende() {
        for (input, end) in [
            ("2026-01-31", "2026-02-01"),
            ("2026-04-30", "2026-05-01"),
            ("2026-12-31", "2027-01-01"),
            ("2028-02-28", "2028-02-29"),
            ("2028-02-29", "2028-03-01"),
            ("2100-02-28", "2100-03-01"),
            ("2000-02-28", "2000-02-29"),
        ] {
            let event = build_event(&vehicle("v", Some(input)), Content::Short).unwrap();
            assert_eq!(event.end, day(end), "{input}");
        }
    }

    #[test]
    fn unlesbare_termine_ergeben_keinen_eintrag() {
        for value in [
            "",
            "2026-11-5",
            "2026-13-01",
            "2026-02-30",
            "2027-02-29",
            "0000-01-01",
            "2026-11-05T24:00",
            "2026-11-05T12:60",
            "2026-11-05 12:00",
            "2026-11-05T12:00:00",
            "+026-11-05",
            "2026-1a-05",
            "2026-11-05T1a:00",
            "２０２６-11-05",
        ] {
            assert!(
                build_event(&vehicle("v", Some(value)), Content::Short).is_none(),
                "{value}"
            );
        }
        assert!(build_event(&vehicle("v", None), Content::Short).is_none());
    }

    #[test]
    fn knapper_inhalt_zeigt_nur_das_fahrzeug() {
        let event = build_event(&vehicle("v", Some("2026-11-05T14:00")), Content::Short).unwrap();
        assert_eq!(event.summary, "VW Golf");
        let json = event.to_json().to_string();
        assert!(!json.contains("Müller"));
        assert!(!json.contains("AB-CD"));
        assert!(!json.contains("bar"), "Notizen gehen nie zu Google");
    }

    #[test]
    fn voller_inhalt_zeigt_kunde_fahrzeug_und_kennzeichen() {
        let full = |customer: &str, car: &str, plate: &str| {
            let mut item = vehicle("v", Some("2026-11-05T14:00"));
            item.customer_name = customer.to_string();
            item.vehicle_name = car.to_string();
            item.license_plate = plate.to_string();
            build_event(&item, Content::Full).unwrap().summary
        };
        assert_eq!(
            full("Müller", "VW Golf", "AB-CD 123"),
            "Müller – VW Golf · AB-CD 123"
        );
        assert_eq!(full("Müller", "", "AB-CD 123"), "Müller · AB-CD 123");
        assert_eq!(full("Müller", "VW Golf", ""), "Müller – VW Golf");
        assert_eq!(
            full("  Müller ", " VW Golf ", " AB-CD 123 "),
            "Müller – VW Golf · AB-CD 123"
        );
        assert_eq!(full("", "", ""), FALLBACK_TITLE);
        assert_eq!(full("", "VW Golf", ""), "VW Golf");
    }

    #[test]
    fn ohne_fahrzeugname_steht_ein_neutraler_titel() {
        let mut item = vehicle("v", Some("2026-11-05T14:00"));
        item.vehicle_name = "   ".to_string();
        assert_eq!(
            build_event(&item, Content::Short).unwrap().summary,
            FALLBACK_TITLE
        );
    }

    #[test]
    fn archivierte_fahrzeuge_und_fahrzeuge_ohne_termin_fehlen() {
        let mut archived = vehicle("archiviert", Some("2026-11-05T09:00"));
        archived.archived_at = Some("2026-11-04T10:00:00Z".to_string());
        let events = build_events(
            &[
                archived,
                vehicle("ohne", None),
                vehicle("mit", Some("2026-11-05")),
            ],
            Content::Short,
        );
        let ids: Vec<_> = events
            .iter()
            .map(|event| event.vehicle_id.as_str())
            .collect();
        assert_eq!(ids, vec!["mit"]);
    }

    #[test]
    fn termine_sind_nach_zeit_sortiert_ganztaegige_zuerst() {
        let events = build_events(
            &[
                vehicle("c", Some("2026-11-06T08:00")),
                vehicle("b", Some("2026-11-05T15:30")),
                vehicle("a", Some("2026-11-05T14:00")),
                vehicle("d", Some("2026-11-05")),
            ],
            Content::Short,
        );
        let ids: Vec<_> = events
            .iter()
            .map(|event| event.vehicle_id.as_str())
            .collect();
        assert_eq!(ids, vec!["d", "a", "b", "c"]);
    }

    #[test]
    fn fingerabdruck_aendert_sich_mit_dem_inhalt() {
        let base = build_event(&vehicle("v", Some("2026-11-05T14:00")), Content::Short).unwrap();
        let same = build_event(&vehicle("v", Some("2026-11-05T14:00")), Content::Short).unwrap();
        assert_eq!(base.fingerprint, same.fingerprint);
        assert_eq!(base.fingerprint.len(), 16);

        let moved = build_event(&vehicle("v", Some("2026-11-05T15:00")), Content::Short).unwrap();
        let full = build_event(&vehicle("v", Some("2026-11-05T14:00")), Content::Full).unwrap();
        let all_day = build_event(&vehicle("v", Some("2026-11-05")), Content::Short).unwrap();
        assert_ne!(base.fingerprint, moved.fingerprint);
        assert_ne!(base.fingerprint, full.fingerprint);
        assert_ne!(base.fingerprint, all_day.fingerprint);

        // Notiz und Arbeitsstand stehen nicht bei Google und lösen keinen Abgleich aus.
        let mut other = vehicle("v", Some("2026-11-05T14:00"));
        other.note = "neu".to_string();
        other.is_done = true;
        assert_eq!(
            build_event(&other, Content::Short).unwrap().fingerprint,
            base.fingerprint
        );
    }

    #[test]
    fn termin_geht_mit_zeitzone_und_kennzeichen_an_google() {
        let event = build_event(&vehicle("v1", Some("2026-11-05T14:00")), Content::Short).unwrap();
        let json = event.to_json();
        assert_eq!(json["summary"], "VW Golf");
        assert_eq!(json["start"]["dateTime"], "2026-11-05T14:00:00");
        assert_eq!(json["start"]["timeZone"], TIME_ZONE);
        assert_eq!(json["end"]["dateTime"], "2026-11-05T15:00:00");
        assert_eq!(json["extendedProperties"]["private"]["wm"], "1");
        assert_eq!(json["extendedProperties"]["private"]["vehicle"], "v1");
        assert_eq!(
            json["extendedProperties"]["private"]["fp"],
            event.fingerprint.as_str()
        );

        let all_day = build_event(&vehicle("v2", Some("2026-11-06")), Content::Short).unwrap();
        let json = all_day.to_json();
        assert_eq!(json["start"], json!({ "date": "2026-11-06" }));
        assert_eq!(json["end"], json!({ "date": "2026-11-07" }));
    }

    #[test]
    fn vorschau_zeigt_tag_uhrzeit_und_titel() {
        let timed = build_event(&vehicle("v", Some("2026-11-05T14:00")), Content::Short).unwrap();
        assert_eq!(
            PreviewEvent::from(&timed),
            PreviewEvent {
                date: "2026-11-05".to_string(),
                time: Some("14:00".to_string()),
                end_time: Some("15:00".to_string()),
                title: "VW Golf".to_string(),
            }
        );
        let late = build_event(&vehicle("v", Some("2026-11-05T23:30")), Content::Short).unwrap();
        assert_eq!(PreviewEvent::from(&late).end_time.as_deref(), Some("00:30"));
        let all_day = build_event(&vehicle("v", Some("2026-11-06")), Content::Short).unwrap();
        assert_eq!(PreviewEvent::from(&all_day).time, None);
        assert_eq!(PreviewEvent::from(&all_day).end_time, None);
    }

    #[test]
    fn nur_eigene_termine_werden_gelesen() {
        let page = json!({
            "items": [
                { "id": "e1", "extendedProperties": { "private": { "wm": "1", "vehicle": "v1", "fp": "aa" } } },
                { "id": "e2", "extendedProperties": { "private": { "wm": "1" } } },
                { "id": "fremd", "summary": "Zahnarzt" },
                { "id": "anders", "extendedProperties": { "private": { "wm": "2", "vehicle": "v9" } } },
                { "extendedProperties": { "private": { "wm": "1", "vehicle": "ohne-id" } } }
            ]
        });
        assert_eq!(
            parse_remote_events(&page),
            vec![
                RemoteEvent {
                    id: "e1".to_string(),
                    vehicle_id: Some("v1".to_string()),
                    fingerprint: Some("aa".to_string()),
                },
                RemoteEvent {
                    id: "e2".to_string(),
                    vehicle_id: None,
                    fingerprint: None,
                },
            ]
        );
        assert!(parse_remote_events(&json!({})).is_empty());
    }

    fn remote(id: &str, vehicle: Option<&str>, fingerprint: Option<&str>) -> RemoteEvent {
        RemoteEvent {
            id: id.to_string(),
            vehicle_id: vehicle.map(str::to_string),
            fingerprint: fingerprint.map(str::to_string),
        }
    }

    #[test]
    fn abgleich_plant_neu_geaendert_und_weg() {
        let desired = build_events(
            &[
                vehicle("gleich", Some("2026-11-05T09:00")),
                vehicle("geaendert", Some("2026-11-05T10:00")),
                vehicle("neu", Some("2026-11-05T11:00")),
            ],
            Content::Short,
        );
        let same_fp = desired[0].fingerprint.clone();
        let existing = vec![
            remote("e-gleich", Some("gleich"), Some(&same_fp)),
            remote("e-geaendert", Some("geaendert"), Some("alt")),
            remote("e-weg", Some("weg"), Some("x")),
            remote("e-ohne", None, None),
        ];
        let plan = plan(&desired, &existing);
        assert_eq!(
            plan.insert
                .iter()
                .map(|e| e.vehicle_id.as_str())
                .collect::<Vec<_>>(),
            vec!["neu"]
        );
        assert_eq!(
            plan.update
                .iter()
                .map(|(r, d)| (r.id.as_str(), d.vehicle_id.as_str()))
                .collect::<Vec<_>>(),
            vec![("e-geaendert", "geaendert")]
        );
        assert_eq!(
            plan.delete
                .iter()
                .map(|r| r.id.as_str())
                .collect::<Vec<_>>(),
            vec!["e-weg", "e-ohne"]
        );
    }

    #[test]
    fn doppelte_termine_werden_bis_auf_einen_geloescht() {
        let desired = build_events(&[vehicle("v", Some("2026-11-05T09:00"))], Content::Short);
        let fp = desired[0].fingerprint.clone();
        let existing = vec![
            remote("erster", Some("v"), Some(&fp)),
            remote("zweiter", Some("v"), Some(&fp)),
            remote("dritter", Some("v"), Some("alt")),
        ];
        let plan = plan(&desired, &existing);
        assert!(plan.insert.is_empty());
        assert!(plan.update.is_empty());
        assert_eq!(
            plan.delete
                .iter()
                .map(|r| r.id.as_str())
                .collect::<Vec<_>>(),
            vec!["zweiter", "dritter"]
        );
    }

    #[test]
    fn gleicher_stand_ergibt_leeren_plan() {
        let desired = build_events(
            &[
                vehicle("a", Some("2026-11-05")),
                vehicle("b", Some("2026-11-05T08:00")),
            ],
            Content::Full,
        );
        let existing: Vec<_> = desired
            .iter()
            .map(|event| {
                remote(
                    &format!("e-{}", event.vehicle_id),
                    Some(&event.vehicle_id),
                    Some(&event.fingerprint),
                )
            })
            .collect();
        assert!(plan(&desired, &existing).is_empty());
        assert!(plan(&[], &[]).is_empty());
    }
}
