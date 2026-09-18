//! Pulling a thumbnail out of a `.notex` file without opening the document.
//!
//! A library of a hundred notebooks cannot parse a hundred documents into
//! memory to draw a hundred cards. A `.notex` is one JSON object whose bulk is
//! in two places — every page's strokes, and `pdfSources`, which carries whole
//! imported PDFs as base64 and is routinely the largest thing in the file — and
//! a thumbnail needs neither. It needs page one.
//!
//! So this deserialises straight into a struct that keeps page one and nothing
//! else. `serde_json` reading into typed structs is a streaming parser: fields
//! the target does not declare are consumed as `IgnoredAny`, which advances
//! over the tokens without building a value. Pages after the first go the same
//! way. The file is read once and the peak retained memory is one page, not one
//! document — which is the difference between a library that scrolls and one
//! that runs the tab out of memory.

use std::{fs::File, io::BufReader, marker::PhantomData, path::Path};

use serde::{
    de::{IgnoredAny, SeqAccess, Visitor},
    Deserialize, Deserializer, Serialize,
};

/// What the library needs to draw one card.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ThumbnailSource {
    pub title: String,
    pub page_count: u32,
    /// The first page, verbatim, as the frontend's own page renderer expects
    /// it. `None` for a document with no pages at all.
    pub page: Option<serde_json::Value>,
    /// ISO-8601, from the envelope. `None` for a bare serialized document.
    pub saved_at: Option<String>,
}

/// The first element of a sequence; the rest are skipped without allocating.
struct FirstOf<T> {
    first: Option<T>,
    len: u32,
}

impl<'de, T: Deserialize<'de>> Deserialize<'de> for FirstOf<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct SeqVisitor<T>(PhantomData<T>);

        impl<'de, T: Deserialize<'de>> Visitor<'de> for SeqVisitor<T> {
            type Value = FirstOf<T>;

            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("an array of pages")
            }

            fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self::Value, A::Error> {
                let first = seq.next_element::<T>()?;
                let mut len = u32::from(first.is_some());
                // The remaining pages are walked for syntax and dropped; this
                // is what keeps a 200-page notebook from being materialised.
                while seq.next_element::<IgnoredAny>()?.is_some() {
                    len = len.saturating_add(1);
                }
                Ok(FirstOf { first, len })
            }
        }

        deserializer.deserialize_seq(SeqVisitor(PhantomData))
    }
}

#[derive(Deserialize)]
struct DocumentHead {
    #[serde(default)]
    title: Option<String>,
    #[serde(default = "no_pages")]
    pages: FirstOf<serde_json::Value>,
}

fn no_pages() -> FirstOf<serde_json::Value> {
    FirstOf { first: None, len: 0 }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotexHead {
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    saved_at: Option<String>,
    #[serde(default)]
    document: Option<DocumentHead>,
    // A bare serialized document (`.json`) has the pages at the top level.
    #[serde(default)]
    title: Option<String>,
    #[serde(default = "no_pages")]
    pages: FirstOf<serde_json::Value>,
}

/// Read a document's title, page count and first page.
pub fn read_thumbnail_source(path: &Path, fallback_title: &str) -> Result<ThumbnailSource, String> {
    let file = File::open(path).map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
    let reader = BufReader::new(file);
    let head: NotexHead =
        serde_json::from_reader(reader).map_err(|e| format!("{} is not a Notes document: {e}", path.display()))?;

    if let Some(format) = head.format.as_deref() {
        if format != "notex" {
            return Err(format!("{} is not a Notes document", path.display()));
        }
    }

    let (title, pages) = match head.document {
        Some(document) => (document.title, document.pages),
        None => (head.title, head.pages),
    };
    let title = title.filter(|t| !t.trim().is_empty()).unwrap_or_else(|| fallback_title.to_string());

    Ok(ThumbnailSource {
        title,
        page_count: pages.len,
        page: pages.first,
        saved_at: head.saved_at,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn page(id: &str, colour: &str) -> String {
        format!(
            r#"{{"id":"{id}","dimensions":{{"width":794,"height":1123}},"template":"blank","templateConfig":{{"spacing":32,"strokeColor":"auto","strokeWidth":1}},"backgroundColor":"{colour}","strokes":[]}}"#
        )
    }

    fn write(dir: &Path, name: &str, body: &str) -> std::path::PathBuf {
        let path = dir.join(name);
        fs::write(&path, body).unwrap();
        path
    }

    #[test]
    fn reads_the_title_page_count_and_first_page() {
        let dir = tempfile::tempdir().unwrap();
        let body = format!(
            r#"{{"format":"notex","version":1,"savedAt":"2026-01-02T03:04:05.000Z","app":{{"name":"Notes","version":"0.1.0"}},"document":{{"version":1,"id":"d1","title":"Week 1","viewMode":"vertical-continuous","zoom":1,"activePageIndex":0,"pages":[{},{},{}]}}}}"#,
            page("p1", "#ffffff"),
            page("p2", "#eeeeee"),
            page("p3", "#dddddd")
        );
        let path = write(dir.path(), "Week 1.notex", &body);

        let source = read_thumbnail_source(&path, "fallback").unwrap();
        assert_eq!(source.title, "Week 1");
        assert_eq!(source.page_count, 3);
        assert_eq!(source.saved_at.as_deref(), Some("2026-01-02T03:04:05.000Z"));
        // The first page comes back whole, and only the first.
        let first = source.page.unwrap();
        assert_eq!(first["id"], "p1");
        assert_eq!(first["backgroundColor"], "#ffffff");
        assert_eq!(first["dimensions"]["width"], 794);
    }

    #[test]
    fn leaves_the_rest_of_the_document_on_disk() {
        // The bulk of a real file is the other pages' strokes and `pdfSources`,
        // which carries imported PDFs as base64. Here that is 4 MB of payload
        // around one small page; what comes back is the page.
        let dir = tempfile::tempdir().unwrap();
        let filler = "A".repeat(2 * 1024 * 1024);
        let fat_page = format!(
            r##"{{"id":"p2","dimensions":{{"width":794,"height":1123}},"template":"blank","templateConfig":{{"spacing":32,"strokeColor":"auto","strokeWidth":1}},"backgroundColor":"#fff","strokes":[],"note":"{filler}"}}"##
        );
        let body = format!(
            r#"{{"format":"notex","version":1,"document":{{"version":1,"id":"d1","title":"Big","viewMode":"vertical-continuous","zoom":1,"activePageIndex":0,"pages":[{},{}],"pdfSources":{{"s1":{{"data":"{filler}"}}}}}}}}"#,
            page("p1", "#ffffff"),
            fat_page
        );
        let path = write(dir.path(), "Big.notex", &body);
        assert!(fs::metadata(&path).unwrap().len() > 4 * 1024 * 1024);

        let source = read_thumbnail_source(&path, "fallback").unwrap();
        assert_eq!(source.page_count, 2);
        let first = source.page.unwrap();
        assert_eq!(first["id"], "p1");
        // What came back is one page, not the file.
        let retained = serde_json::to_string(&first).unwrap();
        assert!(retained.len() < 4096, "retained {} bytes", retained.len());
    }

    #[test]
    fn falls_back_to_the_file_name_when_a_document_has_no_title() {
        let dir = tempfile::tempdir().unwrap();
        for body in [
            r#"{"format":"notex","version":1,"document":{"version":1,"id":"d","viewMode":"v","zoom":1,"activePageIndex":0,"pages":[]}}"#,
            r#"{"format":"notex","version":1,"document":{"version":1,"id":"d","title":"   ","viewMode":"v","zoom":1,"activePageIndex":0,"pages":[]}}"#,
        ] {
            let path = write(dir.path(), "Untitled note.notex", body);
            assert_eq!(read_thumbnail_source(&path, "Untitled note").unwrap().title, "Untitled note");
        }
    }

    #[test]
    fn handles_a_document_with_no_pages() {
        let dir = tempfile::tempdir().unwrap();
        let path = write(
            dir.path(),
            "Empty.notex",
            r#"{"format":"notex","version":1,"document":{"version":1,"id":"d","title":"Empty","viewMode":"v","zoom":1,"activePageIndex":0,"pages":[]}}"#,
        );
        let source = read_thumbnail_source(&path, "Empty").unwrap();
        assert_eq!(source.page_count, 0);
        assert!(source.page.is_none());
    }

    #[test]
    fn reads_a_bare_serialized_document_too() {
        // A `.json` export has no envelope; the pages are at the top level.
        let dir = tempfile::tempdir().unwrap();
        let body = format!(
            r#"{{"version":1,"id":"d1","title":"Bare","viewMode":"vertical-continuous","zoom":1,"activePageIndex":0,"pages":[{}]}}"#,
            page("p1", "#ffffff")
        );
        let path = write(dir.path(), "Bare.json", &body);
        let source = read_thumbnail_source(&path, "fallback").unwrap();
        assert_eq!(source.title, "Bare");
        assert_eq!(source.page_count, 1);
        assert_eq!(source.page.unwrap()["id"], "p1");
    }

    #[test]
    fn refuses_something_that_is_not_a_document() {
        let dir = tempfile::tempdir().unwrap();
        assert!(read_thumbnail_source(&write(dir.path(), "a.notex", "not json at all"), "a").is_err());
        assert!(read_thumbnail_source(&write(dir.path(), "b.notex", r#"{"format":"other"}"#), "b").is_err());
        assert!(read_thumbnail_source(&dir.path().join("missing.notex"), "missing").is_err());
    }

    #[test]
    fn survives_a_truncated_file_without_panicking() {
        // A save interrupted by a flat battery. The library must still draw
        // every other card.
        let dir = tempfile::tempdir().unwrap();
        let path = write(dir.path(), "cut.notex", r#"{"format":"notex","version":1,"document":{"pages":[{"id":"p1""#);
        assert!(read_thumbnail_source(&path, "cut").is_err());
    }
}
