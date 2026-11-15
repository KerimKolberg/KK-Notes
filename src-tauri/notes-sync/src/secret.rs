//! Keeping the Google refresh token from being read off the disk.
//!
//! The token is what lets the app into the user's Drive without asking again, and it sat in a JSON file
//! in the app's data folder as plain text: anything that could copy that file had it — a backup tool, a
//! folder synced to somewhere else, another account on the PC with an administrator's reach, a disk
//! pulled out of the machine.
//!
//! On Windows it is now sealed with the Data Protection API before it is written: encrypted with a key
//! Windows derives from the user's own sign-in, so the file is of use only to that user on that PC, and
//! nothing new is asked of anyone (no password, no prompt). It does not hide the token from a program
//! running *as* the user, which could ask Windows to unseal it just as this app does; no storage on the
//! same account can.
//!
//! Elsewhere there is nothing to add here. On Android the app's files are private to the app already:
//! the system keeps every other app out of them. So sealing is "not available" there, and the token is
//! stored as it was.

/// Seal `plain` for this user on this machine. `None` where the platform has no such thing, or it failed:
/// the caller then stores it as it always did.
pub fn seal(plain: &[u8]) -> Option<Vec<u8>> {
    imp::seal(plain)
}

/// Undo [`seal`]. `None` when it cannot be undone: another user, another machine, or not sealed at all.
pub fn unseal(sealed: &[u8]) -> Option<Vec<u8>> {
    imp::unseal(sealed)
}

/// Bytes as lowercase hex, to sit in a JSON file.
pub fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The reverse; `None` for anything that is not hex of whole bytes.
pub fn from_hex(text: &str) -> Option<Vec<u8>> {
    if text.len() % 2 != 0 || !text.is_ascii() {
        return None;
    }
    (0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).ok()).collect()
}

#[cfg(windows)]
mod imp {
    use std::ffi::c_void;
    use windows::core::PCWSTR;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB};

    /// Copy what the API allocated, and give its memory back.
    fn take(blob: CRYPT_INTEGER_BLOB) -> Option<Vec<u8>> {
        if blob.pbData.is_null() {
            return None;
        }
        // SAFETY: the API returned `cbData` bytes at `pbData`, allocated with `LocalAlloc`, which are
        // ours to read and then to free exactly once.
        unsafe {
            let bytes = std::slice::from_raw_parts(blob.pbData, blob.cbData as usize).to_vec();
            let _ = LocalFree(Some(HLOCAL(blob.pbData.cast::<c_void>())));
            Some(bytes)
        }
    }

    fn blob_of(bytes: &[u8]) -> CRYPT_INTEGER_BLOB {
        CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr().cast_mut() }
    }

    pub fn seal(plain: &[u8]) -> Option<Vec<u8>> {
        let input = blob_of(plain);
        let mut output = CRYPT_INTEGER_BLOB::default();
        // SAFETY: `input` points at `plain`, which outlives the call and is only read; `output` is
        // written by the call. No window may be shown: this runs with no one to answer it.
        unsafe { CryptProtectData(&input, PCWSTR::null(), None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output).ok()? };
        take(output)
    }

    pub fn unseal(sealed: &[u8]) -> Option<Vec<u8>> {
        let input = blob_of(sealed);
        let mut output = CRYPT_INTEGER_BLOB::default();
        // SAFETY: as in `seal`.
        unsafe { CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output).ok()? };
        take(output)
    }
}

#[cfg(not(windows))]
mod imp {
    pub fn seal(_plain: &[u8]) -> Option<Vec<u8>> {
        None
    }

    pub fn unseal(_sealed: &[u8]) -> Option<Vec<u8>> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_goes_there_and_back() {
        assert_eq!(to_hex(&[0, 1, 0xab, 0xff]), "0001abff");
        assert_eq!(from_hex("0001abff"), Some(vec![0, 1, 0xab, 0xff]));
        assert_eq!(from_hex(""), Some(vec![]));
        for bad in ["abc", "zz", "é0"] {
            assert_eq!(from_hex(bad), None, "{bad}");
        }
    }

    #[cfg(windows)]
    #[test]
    fn what_is_sealed_comes_back_and_is_not_the_plain_text() {
        let plain = br#"{"refreshToken":"1//r"}"#;
        let sealed = seal(plain).expect("the Data Protection API seals");
        assert!(!sealed.windows(plain.len()).any(|w| w == plain));
        assert_eq!(unseal(&sealed).as_deref(), Some(&plain[..]));
        assert_eq!(unseal(b"not sealed"), None);
    }
}
