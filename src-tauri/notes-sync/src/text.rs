//! The words in a `.notex` file, without opening the document.
//!
//! Library-wide search has to look inside every note, and a note is mostly not
//! words: its bulk is ink and embedded images and PDFs. So this deserialises
//! into a struct that declares only what search reads — a page's id and, per
//! media object, its kind, its `text` and its table `cells` — and lets serde
//! walk past everything else as `IgnoredAny`, the same trick `thumb.rs` uses to
//! keep page one alone. Nothing here matches a query; the frontend does that
//! with the one folding routine the in-note search uses, so the two can never
//! disagree about what "cafe" finds.

use std::{fs::File, io::BufReader, path::Path};

use serde::{Deserialize, Serialize};

/// One piece of searchable text and where it sits in the note.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TextPiece {
    /// Zero-based.
    pub page_index: u32,
    pub page_id: String,
    pub media_id: Option<String>,
    /// `text`, `note` or `table`.
    pub kind: &'static str,
    pub text: String,
}

/// A page made from a page of an embedded PDF. Its words are in the PDF, which this does not read: the frontend
/// reads them with PDF.js (the same reader the in-note search uses) and keeps them, by source, for next time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfPagePiece {
    /// Zero-based, in the note.
    pub page_index: u32,
    pub page_id: String,
    pub source_id: String,
    /// Zero-based, in the PDF.
    pub pdf_page_index: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentText {
    pub title: String,
    pub page_count: u32,
    pub pieces: Vec<TextPiece>,
    pub pdf_pages: Vec<PdfPagePiece>,
}

#[derive(Deserialize)]
struct MediaHead {
    #[serde(default)]
    id: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    cells: Vec<String>,
}

#[derive(Deserialize)]
struct PdfRefHead {
    #[serde(default, rename = "sourceId")]
    source_id: String,
    #[serde(default, rename = "pageIndex")]
    page_index: u32,
}

#[derive(Deserialize)]
struct PageHead {
    #[serde(default)]
    id: String,
    #[serde(default)]
    media: Vec<MediaHead>,
    #[serde(default)]
    pdf: Option<PdfRefHead>,
}

#[derive(Deserialize)]
struct DocumentBody {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    pages: Vec<PageHead>,
}

#[derive(Deserialize)]
struct NotexBody {
    #[serde(default)]
    format: Option<String>,
    #[serde(default)]
    document: Option<DocumentBody>,
    // A bare serialized document has its pages at the top level.
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    pages: Vec<PageHead>,
}

/// Read a document's title and every piece of typed text in it.
pub fn read_document_text(path: &Path, fallback_title: &str) -> Result<DocumentText, String> {
    let file = File::open(path).map_err(|e| format!("Cannot open {}: {e}", path.display()))?;
    let body: NotexBody = serde_json::from_reader(BufReader::new(file))
        .map_err(|e| format!("{} is not a KK-Notes document: {e}", path.display()))?;

    if let Some(format) = body.format.as_deref() {
        if format != "notex" {
            return Err(format!("{} is not a KK-Notes document", path.display()));
        }
    }

    let (title, pages) = match body.document {
        Some(document) => (document.title, document.pages),
        None => (body.title, body.pages),
    };
    let title = title
        .filter(|t| !t.trim().is_empty())
        .unwrap_or_else(|| fallback_title.to_string());

    let page_count = u32::try_from(pages.len()).unwrap_or(u32::MAX);
    let mut pieces = Vec::new();
    let mut pdf_pages = Vec::new();
    for (index, page) in pages.iter().enumerate() {
        let page_index = u32::try_from(index).unwrap_or(u32::MAX);
        if let Some(pdf) = page.pdf.as_ref().filter(|p| !p.source_id.is_empty()) {
            pdf_pages.push(PdfPagePiece {
                page_index,
                page_id: page.id.clone(),
                source_id: pdf.source_id.clone(),
                pdf_page_index: pdf.page_index,
            });
        }
        for media in &page.media {
            let mut push = |kind: &'static str, text: &str| {
                if !text.trim().is_empty() {
                    pieces.push(TextPiece {
                        page_index,
                        page_id: page.id.clone(),
                        media_id: Some(media.id.clone()),
                        kind,
                        text: text.to_string(),
                    });
                }
            };
            match media.kind.as_str() {
                "text" => push("text", media.text.as_deref().unwrap_or("")),
                "note" => push("note", media.text.as_deref().unwrap_or("")),
                "table" => {
                    for cell in &media.cells {
                        push("table", cell);
                    }
                }
                _ => {}
            }
        }
    }

    Ok(DocumentText { title, page_count, pieces, pdf_pages })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn write(dir: &Path, name: &str, body: &str) -> std::path::PathBuf {
        let path = dir.join(name);
        fs::write(&path, body).unwrap();
        path
    }

    fn scratch(tag: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("notes-sync-text-{tag}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    const NOTE: &str = r##"{"format":"notex","version":1,"savedAt":"2026-01-01T00:00:00Z","document":{"title":"Groceries","pages":[
        {"id":"p1","strokes":[{"kind":"freehand","points":[1,2,3]}],"media":[
            {"id":"m1","kind":"text","text":"Buy a lemon","fontSize":16},
            {"id":"m2","kind":"image","src":"data:image/png;base64,AAAA"},
            {"id":"m3","kind":"note","text":"  ","color":"#fff"}]},
        {"id":"p2","media":[
            {"id":"m4","kind":"table","rows":1,"columns":3,"cells":["milk","","eggs"]},
            {"id":"m5","kind":"note","text":"Call Zoë"}]}],
        "pdfSources":{"a":"QUJD"}}}"##;

    #[test]
    fn collects_typed_text_with_positions_and_skips_the_rest() {
        let dir = scratch("a");
        let path = write(&dir, "g.notex", NOTE);
        let text = read_document_text(&path, "fallback").unwrap();
        assert_eq!(text.title, "Groceries");
        assert_eq!(text.page_count, 2);
        let got: Vec<(u32, &str, &str)> = text.pieces.iter().map(|p| (p.page_index, p.kind, p.text.as_str())).collect();
        assert_eq!(
            got,
            vec![(0, "text", "Buy a lemon"), (1, "table", "milk"), (1, "table", "eggs"), (1, "note", "Call Zoë")]
        );
        assert_eq!(text.pieces[0].media_id.as_deref(), Some("m1"));
        assert_eq!(text.pieces[0].page_id, "p1");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn lists_the_pages_made_from_a_pdf_without_reading_the_pdf() {
        let dir = scratch("p");
        let path = write(
            &dir,
            "p.notex",
            r#"{"format":"notex","document":{"title":"Lecture","pages":[
                {"id":"a","pdf":{"sourceId":"pdf_1","pageIndex":0,"viewBox":[0,0,612,792],"rotation":0,"scale":1.3}},
                {"id":"b","media":[{"id":"m","kind":"text","text":"my answer"}]},
                {"id":"c","pdf":{"sourceId":"pdf_1","pageIndex":4}},
                {"id":"d","pdf":{"sourceId":""}}],
                "pdfSources":{"pdf_1":{"name":"L.pdf","pageCount":5,"data":"JVBERi0="}}}}"#,
        );
        let text = read_document_text(&path, "p").unwrap();
        let got: Vec<(u32, &str, &str, u32)> = text
            .pdf_pages
            .iter()
            .map(|p| (p.page_index, p.page_id.as_str(), p.source_id.as_str(), p.pdf_page_index))
            .collect();
        assert_eq!(got, vec![(0, "a", "pdf_1", 0), (2, "c", "pdf_1", 4)]);
        assert_eq!(text.pieces.len(), 1);
        let json = serde_json::to_string(&text).unwrap();
        assert!(json.contains(r#""pdfPages":[{"pageIndex":0,"pageId":"a","sourceId":"pdf_1","pdfPageIndex":0}"#), "{json}");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn a_bare_document_and_a_missing_title() {
        let dir = scratch("b");
        let path = write(&dir, "bare.json", r#"{"pages":[{"id":"p","media":[{"id":"m","kind":"text","text":"hi"}]}]}"#);
        let text = read_document_text(&path, "Bare").unwrap();
        assert_eq!(text.title, "Bare");
        assert_eq!(text.pieces.len(), 1);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn pages_without_media_and_no_pages_at_all() {
        let dir = scratch("c");
        let path = write(&dir, "x.notex", r#"{"format":"notex","document":{"title":"T","pages":[{"id":"p"}]}}"#);
        let text = read_document_text(&path, "x").unwrap();
        assert_eq!((text.page_count, text.pieces.len()), (1, 0));
        let empty = write(&dir, "e.notex", r#"{"format":"notex","document":{"title":"E"}}"#);
        assert_eq!(read_document_text(&empty, "e").unwrap().page_count, 0);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn refuses_what_is_not_a_note() {
        let dir = scratch("d");
        let other = write(&dir, "o.notex", r#"{"format":"something-else","document":{"pages":[]}}"#);
        assert!(read_document_text(&other, "o").is_err());
        let broken = write(&dir, "b.notex", "not json");
        assert!(read_document_text(&broken, "b").is_err());
        assert!(read_document_text(&dir.join("missing.notex"), "m").is_err());
        let _ = fs::remove_dir_all(dir);
    }
}
