use chacha20poly1305::aead::rand_core::RngCore;
use chacha20poly1305::aead::{Aead, AeadCore, KeyInit, OsRng, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::{Zeroize, Zeroizing};

use crate::error::ApiError;

/// Version des Verschlüsselungsformats. Wird pro Eintrag gespeichert, damit
/// spätere Formatwechsel migrierbar sind. Version 1: XChaCha20-Poly1305,
/// 32-Byte-Schlüssel, 24-Byte-Zufallsnonce, AAD bindet Eintrags-ID + Version.
pub const ENCRYPTION_VERSION: i64 = 1;

pub const KEY_LEN: usize = 32;
pub const NONCE_LEN: usize = 24;

/// Symmetrischer Schlüssel. Wird beim Droppen sicher überschrieben und
/// erscheint niemals in Debug-Ausgaben oder Fehlermeldungen.
#[derive(Clone)]
pub struct SecretKey([u8; KEY_LEN]);

impl SecretKey {
    pub fn from_bytes(bytes: [u8; KEY_LEN]) -> Self {
        Self(bytes)
    }

    pub fn from_slice(bytes: &[u8]) -> Option<Self> {
        let array: [u8; KEY_LEN] = bytes.try_into().ok()?;
        Some(Self(array))
    }

    pub fn generate() -> Self {
        let mut bytes = [0u8; KEY_LEN];
        OsRng.fill_bytes(&mut bytes);
        Self(bytes)
    }

    pub fn as_bytes(&self) -> &[u8; KEY_LEN] {
        &self.0
    }
}

impl Drop for SecretKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

impl std::fmt::Debug for SecretKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("SecretKey(***)")
    }
}

impl PartialEq for SecretKey {
    fn eq(&self, other: &Self) -> bool {
        // Kein Timing-kritischer Pfad: wird nur zum Vergleich nach einer
        // erfolgreichen Entschlüsselung genutzt, nie zur Authentisierung.
        self.0 == other.0
    }
}

fn cipher(key: &SecretKey) -> XChaCha20Poly1305 {
    XChaCha20Poly1305::new(key.as_bytes().into())
}

/// Verschlüsselt `plaintext` authentifiziert. Liefert Ciphertext und die
/// pro Aufruf frisch erzeugte Zufallsnonce.
pub fn seal(
    key: &SecretKey,
    plaintext: &[u8],
    aad: &[u8],
) -> Result<(Vec<u8>, [u8; NONCE_LEN]), ApiError> {
    let nonce = XChaCha20Poly1305::generate_nonce(&mut OsRng);
    let ciphertext = cipher(key)
        .encrypt(&nonce, Payload { msg: plaintext, aad })
        .map_err(|_| ApiError::crypto())?;
    let nonce_bytes: [u8; NONCE_LEN] = nonce
        .as_slice()
        .try_into()
        .expect("XChaCha20-Nonce hat 24 Byte");
    Ok((ciphertext, nonce_bytes))
}

/// Entschlüsselt und prüft die Authentizität. Manipulierte Daten werden
/// abgelehnt; die Fehlermeldung enthält niemals Klartext oder Schlüssel.
pub fn open(
    key: &SecretKey,
    ciphertext: &[u8],
    nonce: &[u8],
    aad: &[u8],
) -> Result<Zeroizing<Vec<u8>>, ApiError> {
    let nonce: [u8; NONCE_LEN] = nonce.try_into().map_err(|_| ApiError::crypto())?;
    let nonce = XNonce::from(nonce);
    let plaintext = cipher(key)
        .decrypt(&nonce, Payload { msg: ciphertext, aad })
        .map_err(|_| ApiError::crypto())?;
    Ok(Zeroizing::new(plaintext))
}

/// Leitet aus dem Wiederherstellungscode und einem Salt den Schlüssel ab,
/// der im Backup den Master-Key schützt. Der Code hat volle Zufallsentropie,
/// daher genügt HKDF-SHA256 ohne zusätzliches Stretching.
pub fn derive_wrapping_key(recovery_code: &str, salt: &[u8]) -> SecretKey {
    let hkdf = Hkdf::<Sha256>::new(Some(salt), recovery_code.as_bytes());
    let mut okm = [0u8; KEY_LEN];
    hkdf.expand(b"werkstatt-backup-key-wrap-v1", &mut okm)
        .expect("HKDF-Ausgabelänge ist gültig");
    let key = SecretKey::from_bytes(okm);
    okm.zeroize();
    key
}

/// Erzeugt `len` kryptographisch sichere Zufallsbytes.
pub fn random_bytes(len: usize) -> Vec<u8> {
    let mut bytes = vec![0u8; len];
    OsRng.fill_bytes(&mut bytes);
    bytes
}

#[cfg(test)]
mod tests {
    use super::*;

    const MARKER: &str = "GEHEIM-Testinhalt-4711";

    #[test]
    fn verschluesseln_und_entschluesseln() {
        let key = SecretKey::generate();
        let (ciphertext, nonce) = seal(&key, MARKER.as_bytes(), b"aad-1").unwrap();
        assert_ne!(ciphertext.as_slice(), MARKER.as_bytes());

        let plaintext = open(&key, &ciphertext, &nonce, b"aad-1").unwrap();
        assert_eq!(plaintext.as_slice(), MARKER.as_bytes());
    }

    #[test]
    fn gleicher_inhalt_bekommt_unterschiedliche_nonces() {
        let key = SecretKey::generate();
        let (ct1, nonce1) = seal(&key, MARKER.as_bytes(), b"aad").unwrap();
        let (ct2, nonce2) = seal(&key, MARKER.as_bytes(), b"aad").unwrap();
        assert_ne!(nonce1, nonce2);
        assert_ne!(ct1, ct2);
    }

    #[test]
    fn manipulierter_ciphertext_wird_abgelehnt() {
        let key = SecretKey::generate();
        let (mut ciphertext, nonce) = seal(&key, MARKER.as_bytes(), b"aad").unwrap();
        ciphertext[0] ^= 0x01;
        assert!(open(&key, &ciphertext, &nonce, b"aad").is_err());
    }

    #[test]
    fn manipulierte_nonce_und_aad_werden_abgelehnt() {
        let key = SecretKey::generate();
        let (ciphertext, mut nonce) = seal(&key, MARKER.as_bytes(), b"aad").unwrap();

        assert!(open(&key, &ciphertext, &nonce, b"andere-aad").is_err());

        nonce[0] ^= 0x01;
        assert!(open(&key, &ciphertext, &nonce, b"aad").is_err());
    }

    #[test]
    fn falscher_schluessel_wird_abgelehnt() {
        let key = SecretKey::generate();
        let (ciphertext, nonce) = seal(&key, MARKER.as_bytes(), b"aad").unwrap();
        assert!(open(&SecretKey::generate(), &ciphertext, &nonce, b"aad").is_err());
    }

    #[test]
    fn fehlermeldung_enthaelt_keinen_klartext() {
        let key = SecretKey::generate();
        let (mut ciphertext, nonce) = seal(&key, MARKER.as_bytes(), b"aad").unwrap();
        ciphertext[3] ^= 0xff;
        let err = open(&key, &ciphertext, &nonce, b"aad").unwrap_err();
        let text = format!("{err} {err:?}");
        assert!(!text.contains(MARKER));
        assert!(!text.contains("4711"));
    }

    #[test]
    fn schluessel_debug_gibt_keine_bytes_aus() {
        let key = SecretKey::from_bytes([0xAB; KEY_LEN]);
        let debug = format!("{key:?}");
        assert_eq!(debug, "SecretKey(***)");
    }

    #[test]
    fn wrapping_key_ist_deterministisch_pro_code_und_salt() {
        let a = derive_wrapping_key("CODE-EINS", b"salz-1");
        let b = derive_wrapping_key("CODE-EINS", b"salz-1");
        let c = derive_wrapping_key("CODE-ZWEI", b"salz-1");
        let d = derive_wrapping_key("CODE-EINS", b"salz-2");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_ne!(a, d);
    }

    #[test]
    fn master_key_wrap_roundtrip() {
        let master = SecretKey::generate();
        let salt = random_bytes(16);
        let wrap = derive_wrapping_key("MEIN-CODE", &salt);
        let (wrapped, nonce) = seal(&wrap, master.as_bytes(), b"key-recovery").unwrap();

        let unwrapped = open(&wrap, &wrapped, &nonce, b"key-recovery").unwrap();
        assert_eq!(unwrapped.as_slice(), master.as_bytes());

        // Falscher Code entschlüsselt nicht.
        let wrong = derive_wrapping_key("FALSCHER-CODE", &salt);
        assert!(open(&wrong, &wrapped, &nonce, b"key-recovery").is_err());
    }
}
