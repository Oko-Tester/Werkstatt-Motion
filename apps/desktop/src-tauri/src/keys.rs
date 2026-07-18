use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use zeroize::{Zeroize, Zeroizing};

use crate::crypto::{self, SecretKey};
use crate::error::{ApiError, ErrorCode};

/// Dienstname im Anmeldedaten-/Schlüsselspeicher des Betriebssystems
/// (Windows Credential Manager, macOS Keychain, Linux Secret Service).
const SERVICE: &str = "de.werkstattmotion.desktop";
const MASTER_KEY_ENTRY: &str = "master-key";
const RECOVERY_CODE_ENTRY: &str = "backup-recovery-code";

/// Zugriff auf den Schlüsselspeicher. Als Trait, damit Tests ohne laufenden
/// Betriebssystem-Dienst auskommen.
pub trait KeyStore: Send + Sync {
    /// `Ok(None)` bedeutet: Eintrag existiert nicht. Fehler bedeuten:
    /// Speicher nicht erreichbar – daraus darf nie „Schlüssel neu erzeugen“
    /// abgeleitet werden.
    fn read(&self, entry: &str) -> Result<Option<Zeroizing<String>>, ApiError>;
    fn write(&self, entry: &str, value: &str) -> Result<(), ApiError>;
}

/// Produktivimplementierung über das `keyring`-Crate.
pub struct OsKeyStore;

impl KeyStore for OsKeyStore {
    fn read(&self, entry: &str) -> Result<Option<Zeroizing<String>>, ApiError> {
        let item =
            keyring::Entry::new(SERVICE, entry).map_err(|_| ApiError::keystore_unavailable())?;
        match item.get_password() {
            Ok(value) => Ok(Some(Zeroizing::new(value))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(ApiError::keystore_unavailable()),
        }
    }

    fn write(&self, entry: &str, value: &str) -> Result<(), ApiError> {
        let item =
            keyring::Entry::new(SERVICE, entry).map_err(|_| ApiError::keystore_unavailable())?;
        item.set_password(value)
            .map_err(|_| ApiError::keystore_unavailable())
    }
}

/// Geladenes Schlüsselmaterial. Verlässt niemals das Rust-Backend.
pub struct KeyMaterial {
    pub master_key: SecretKey,
    /// Schützt die Schlüsselwiederherstellungsdaten in Backups.
    pub recovery_code: Zeroizing<String>,
}

impl std::fmt::Debug for KeyMaterial {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Weder Schlüssel noch Wiederherstellungscode dürfen in Ausgaben landen.
        f.write_str("KeyMaterial(***)")
    }
}

fn invalid_stored_key() -> ApiError {
    ApiError {
        code: ErrorCode::KeystoreUnavailable,
        message: "Gespeicherter Schlüssel ist ungültig".to_string(),
        field: None,
    }
}

/// Menschlich abschreibbarer Wiederherstellungscode mit voller Zufallsentropie,
/// z. B. „7F3A-91C2-…“ (8 Gruppen à 4 Hex-Zeichen = 128 Bit).
fn generate_recovery_code() -> Zeroizing<String> {
    let bytes = Zeroizing::new(crypto::random_bytes(16));
    let groups: Vec<String> = bytes
        .chunks(2)
        .map(|pair| format!("{:02X}{:02X}", pair[0], pair[1]))
        .collect();
    Zeroizing::new(groups.join("-"))
}

/// Lädt den Master-Key oder erzeugt ihn beim allerersten Start.
///
/// Sicherheitsregel: Existieren bereits verschlüsselte Einträge, wird bei
/// fehlendem Schlüssel NIEMALS ein neuer erzeugt – das würde die Daten
/// endgültig unlesbar machen. Stattdessen kommt ein klarer Fehlerzustand.
pub fn load_or_init(
    store: &dyn KeyStore,
    has_encrypted_data: bool,
) -> Result<KeyMaterial, ApiError> {
    match store.read(MASTER_KEY_ENTRY)? {
        Some(encoded) => {
            let mut bytes = BASE64
                .decode(encoded.as_bytes())
                .map_err(|_| invalid_stored_key())?;
            let master_key = SecretKey::from_slice(&bytes).ok_or_else(invalid_stored_key);
            bytes.zeroize();
            let master_key = master_key?;

            let recovery_code = match store.read(RECOVERY_CODE_ENTRY)? {
                Some(code) => code,
                None => {
                    // Älterer Stand ohne Code: nachziehen, Schlüssel bleibt gleich.
                    let code = generate_recovery_code();
                    store.write(RECOVERY_CODE_ENTRY, &code)?;
                    code
                }
            };
            Ok(KeyMaterial {
                master_key,
                recovery_code,
            })
        }
        None => {
            if has_encrypted_data {
                return Err(ApiError::key_missing());
            }
            let master_key = SecretKey::generate();
            let encoded = Zeroizing::new(BASE64.encode(master_key.as_bytes()));
            store.write(MASTER_KEY_ENTRY, &encoded)?;
            let recovery_code = generate_recovery_code();
            store.write(RECOVERY_CODE_ENTRY, &recovery_code)?;
            Ok(KeyMaterial {
                master_key,
                recovery_code,
            })
        }
    }
}

/// Übernimmt nach einer Wiederherstellung den Master-Key aus dem Backup,
/// falls er vom aktuellen Schlüssel abweicht.
pub fn store_master_key(store: &dyn KeyStore, key: &SecretKey) -> Result<(), ApiError> {
    let encoded = Zeroizing::new(BASE64.encode(key.as_bytes()));
    store.write(MASTER_KEY_ENTRY, &encoded)
}

/// Liest nur den Wiederherstellungscode. Wird für die Backup-Validierung
/// gebraucht, wenn der Master-Key selbst nicht (mehr) geladen werden konnte.
pub fn read_recovery_code(store: &dyn KeyStore) -> Result<Option<Zeroizing<String>>, ApiError> {
    store.read(RECOVERY_CODE_ENTRY)
}

#[cfg(test)]
pub mod tests {
    use super::*;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::Mutex;

    /// In-Memory-Schlüsselspeicher für Tests.
    #[derive(Default)]
    pub struct MockKeyStore {
        pub entries: Mutex<HashMap<String, String>>,
        pub fail_read: AtomicBool,
        pub fail_write: AtomicBool,
    }

    impl KeyStore for MockKeyStore {
        fn read(&self, entry: &str) -> Result<Option<Zeroizing<String>>, ApiError> {
            if self.fail_read.load(Ordering::SeqCst) {
                return Err(ApiError::keystore_unavailable());
            }
            Ok(self
                .entries
                .lock()
                .unwrap()
                .get(entry)
                .cloned()
                .map(Zeroizing::new))
        }

        fn write(&self, entry: &str, value: &str) -> Result<(), ApiError> {
            if self.fail_write.load(Ordering::SeqCst) {
                return Err(ApiError::keystore_unavailable());
            }
            self.entries
                .lock()
                .unwrap()
                .insert(entry.to_string(), value.to_string());
            Ok(())
        }
    }

    #[test]
    fn erster_start_erzeugt_schluessel_und_wiederherstellungscode() {
        let store = MockKeyStore::default();
        let keys = load_or_init(&store, false).unwrap();

        let entries = store.entries.lock().unwrap();
        assert!(entries.contains_key(MASTER_KEY_ENTRY));
        assert!(entries.contains_key(RECOVERY_CODE_ENTRY));
        assert_eq!(*keys.recovery_code, entries[RECOVERY_CODE_ENTRY]);
        // Der Code hat das erwartete Format (8 Hex-Gruppen).
        assert_eq!(keys.recovery_code.split('-').count(), 8);
        drop(entries);

        // Zweiter Start lädt denselben Schlüssel.
        let again = load_or_init(&store, true).unwrap();
        assert_eq!(again.master_key, keys.master_key);
        assert_eq!(again.recovery_code, keys.recovery_code);
    }

    #[test]
    fn fehlender_schluessel_bei_bestehenden_daten_erzeugt_sicheren_fehler() {
        let store = MockKeyStore::default();
        let err = load_or_init(&store, true).unwrap_err();
        assert_eq!(err.code, ErrorCode::KeyMissing);
        // Es darf KEIN neuer Schlüssel entstehen.
        assert!(store.entries.lock().unwrap().is_empty());
    }

    #[test]
    fn nicht_erreichbarer_keystore_erzeugt_fehler_ohne_neuanlage() {
        let store = MockKeyStore::default();
        store.fail_read.store(true, Ordering::SeqCst);
        let err = load_or_init(&store, false).unwrap_err();
        assert_eq!(err.code, ErrorCode::KeystoreUnavailable);
        assert!(store.entries.lock().unwrap().is_empty());
    }

    #[test]
    fn korrupter_schluessel_wird_nicht_ueberschrieben() {
        let store = MockKeyStore::default();
        store
            .entries
            .lock()
            .unwrap()
            .insert(MASTER_KEY_ENTRY.to_string(), "kein-base64!".to_string());

        let err = load_or_init(&store, true).unwrap_err();
        assert_eq!(err.code, ErrorCode::KeystoreUnavailable);
        assert_eq!(
            store.entries.lock().unwrap()[MASTER_KEY_ENTRY],
            "kein-base64!"
        );
    }

    #[test]
    fn fehlender_wiederherstellungscode_wird_nachgezogen() {
        let store = MockKeyStore::default();
        let first = load_or_init(&store, false).unwrap();
        store.entries.lock().unwrap().remove(RECOVERY_CODE_ENTRY);

        let again = load_or_init(&store, true).unwrap();
        assert_eq!(again.master_key, first.master_key);
        assert!(store
            .entries
            .lock()
            .unwrap()
            .contains_key(RECOVERY_CODE_ENTRY));
    }
}
