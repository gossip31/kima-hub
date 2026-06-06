/**
 * Parser for playlist CSV exports (Exportify, TuneMyMusic, Soundiiz, etc.).
 *
 * These tools let a user export their own Spotify/Apple/Deezer playlist to a CSV
 * with one row per track. Column names vary between tools, so we auto-detect the
 * Title / Artist / Album / ISRC / Duration columns from the header row.
 *
 * The parser is dependency-free (RFC4180-ish: quoted fields, escaped "" quotes,
 * embedded commas and newlines, CRLF, BOM). Delimiter is auto-detected between
 * comma / semicolon / tab so Soundiiz-style `;` exports work too.
 */

export interface CsvTrackEntry {
    title: string;
    artist: string;
    album: string;
    isrc: string | null;
    durationMs: number;
    /** Source track id/URI if the export carried one (e.g. Spotify Track URI). */
    trackId: string | null;
}

const MAX_ROWS = 10_000;

// Header aliases, normalised (lowercased, trimmed, whitespace-collapsed).
// Matched exactly against the normalised header so "Album Artist Name(s)" never
// gets mistaken for "Artist Name(s)".
const TITLE_HEADERS = [
    "track name",
    "title",
    "track",
    "name",
    "song",
    "song name",
    "track title",
];
const ARTIST_HEADERS = [
    "artist name(s)",
    "artist name",
    "artist",
    "artists",
    "artist(s)",
];
const ALBUM_HEADERS = [
    "album name",
    "album",
    "album title",
    "album name(s)",
];
const ISRC_HEADERS = ["isrc", "isrc code"];
const DURATION_HEADERS = [
    "duration (ms)",
    "duration ms",
    "duration_ms",
    "track duration (ms)",
    "duration",
    "length",
    "time",
];
const TRACK_ID_HEADERS = [
    "track uri",
    "spotify track id",
    "spotify - id",
    "spotify id",
    "track id",
    "uri",
    "id",
];

function normaliseHeader(h: string): string {
    return h.trim().toLowerCase().replace(/\s+/g, " ");
}

/** Pick the first column whose normalised header matches one of the aliases. */
function findColumn(headers: string[], aliases: string[]): number {
    for (const alias of aliases) {
        const idx = headers.indexOf(alias);
        if (idx !== -1) return idx;
    }
    return -1;
}

/** Detect the delimiter by counting candidates in the first non-empty line. */
function detectDelimiter(text: string): string {
    const firstLine = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
    const candidates: Array<[string, number]> = [
        [",", (firstLine.match(/,/g) || []).length],
        [";", (firstLine.match(/;/g) || []).length],
        ["\t", (firstLine.match(/\t/g) || []).length],
    ];
    candidates.sort((a, b) => b[1] - a[1]);
    return candidates[0][1] > 0 ? candidates[0][0] : ",";
}

/** Tokenise CSV text into rows of string fields (RFC4180-ish). */
function parseRows(text: string, delim: string): string[][] {
    const rows: string[][] = [];
    let field = "";
    let row: string[] = [];
    let inQuotes = false;
    const n = text.length;

    for (let i = 0; i < n; i++) {
        const c = text[i];

        if (inQuotes) {
            if (c === '"') {
                if (text[i + 1] === '"') {
                    field += '"';
                    i++; // skip the escaped quote
                } else {
                    inQuotes = false;
                }
            } else {
                field += c;
            }
            continue;
        }

        if (c === '"') {
            inQuotes = true;
        } else if (c === delim) {
            row.push(field);
            field = "";
        } else if (c === "\r") {
            // swallow; newline handled on \n
        } else if (c === "\n") {
            row.push(field);
            rows.push(row);
            row = [];
            field = "";
        } else {
            field += c;
        }
    }

    // Flush trailing field/row (file may not end with a newline)
    if (field.length > 0 || row.length > 0) {
        row.push(field);
        rows.push(row);
    }

    return rows;
}

/** Parse a duration cell into milliseconds. Handles raw ms, raw seconds, and mm:ss / h:mm:ss. */
function parseDuration(raw: string): number {
    const s = raw.trim();
    if (!s) return 0;

    if (/^\d+$/.test(s)) {
        const num = parseInt(s, 10);
        // Heuristic: values over 10000 are already milliseconds; smaller ones are seconds.
        return num > 10_000 ? num : num * 1000;
    }

    const hms = s.match(/^(\d+):(\d{1,2}):(\d{1,2})(?:\.\d+)?$/);
    if (hms) {
        return (
            (parseInt(hms[1], 10) * 3600 +
                parseInt(hms[2], 10) * 60 +
                parseInt(hms[3], 10)) *
            1000
        );
    }

    const ms = s.match(/^(\d+):(\d{1,2})(?:\.\d+)?$/);
    if (ms) {
        return (parseInt(ms[1], 10) * 60 + parseInt(ms[2], 10)) * 1000;
    }

    return 0;
}

function cleanIsrc(raw: string): string | null {
    const s = raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
    // ISRC is 12 chars (CC-XXX-YY-NNNNN); be lenient but reject obvious junk.
    return /^[A-Z0-9]{12}$/.test(s) ? s : null;
}

/**
 * Parse a playlist CSV export into track entries.
 * Throws if the Title and Artist columns can't be identified.
 */
export function parseCsvTracks(content: string): CsvTrackEntry[] {
    // Strip UTF-8 BOM if present.
    let text = content;
    if (text.charCodeAt(0) === 0xfeff) {
        text = text.slice(1);
    }
    if (!text.trim()) {
        throw new Error("CSV file is empty");
    }

    const delim = detectDelimiter(text);
    const rows = parseRows(text, delim);
    if (rows.length < 2) {
        throw new Error("CSV file has no data rows");
    }

    const headers = rows[0].map(normaliseHeader);
    const titleIdx = findColumn(headers, TITLE_HEADERS);
    const artistIdx = findColumn(headers, ARTIST_HEADERS);
    const albumIdx = findColumn(headers, ALBUM_HEADERS);
    const isrcIdx = findColumn(headers, ISRC_HEADERS);
    const durationIdx = findColumn(headers, DURATION_HEADERS);
    const trackIdIdx = findColumn(headers, TRACK_ID_HEADERS);

    if (titleIdx === -1 || artistIdx === -1) {
        throw new Error(
            "Could not find Title and Artist columns in the CSV header. " +
                "Expected columns like \"Track Name\" and \"Artist Name(s)\" " +
                "(Exportify / TuneMyMusic / Soundiiz exports are supported).",
        );
    }

    const entries: CsvTrackEntry[] = [];

    for (let r = 1; r < rows.length && entries.length < MAX_ROWS; r++) {
        const row = rows[r];
        // Skip blank lines (parser yields a single empty field for those).
        if (row.length === 1 && row[0].trim() === "") continue;

        const title = (row[titleIdx] ?? "").trim();
        const artist = (row[artistIdx] ?? "").trim();
        if (!title || !artist) continue;

        const album = albumIdx !== -1 ? (row[albumIdx] ?? "").trim() : "";
        const isrc = isrcIdx !== -1 ? cleanIsrc(row[isrcIdx] ?? "") : null;
        const durationMs =
            durationIdx !== -1 ? parseDuration(row[durationIdx] ?? "") : 0;
        const trackId =
            trackIdIdx !== -1 ? (row[trackIdIdx] ?? "").trim() || null : null;

        entries.push({ title, artist, album, isrc, durationMs, trackId });
    }

    return entries;
}
