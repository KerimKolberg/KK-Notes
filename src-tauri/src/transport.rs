//! Which HTTP transport this build has.
//!
//! The only `#[cfg]` in the cloud code, and it is two lines on purpose.
//! Everything else — the commands, the provider wiring, the account — compiles
//! identically either way and talks to a `Box<dyn HttpTransport>`, so the
//! configuration that leaves networking out still type-checks and still runs
//! the same code paths. It fails with a sentence instead of being compiled
//! away, which is what keeps `npm run check:rust` an honest check of this
//! crate rather than of a subset of it.
//!
//! Why there is a choice at all: the real transport is rustls, whose crypto
//! provider builds C and assembly, and the shell's type-check cross-compiles
//! for Windows from Linux where no MSVC toolchain exists to build them. The
//! transport itself is not left unverified — it lives in `notex-http`, which
//! compiles and tests natively.

use notes_sync::http::HttpTransport;

#[cfg(feature = "cloud-sync")]
pub fn network() -> Box<dyn HttpTransport> {
    Box::new(notex_http::UreqTransport::new())
}

#[cfg(not(feature = "cloud-sync"))]
pub fn network() -> Box<dyn HttpTransport> {
    Box::new(notes_sync::http::UnavailableTransport)
}
