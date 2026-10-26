-- Artwork rows stored before embedded art was sniffed carry whatever MIME
-- type the tag claimed — including image/svg+xml, which a browser opening
-- /api/artwork/{id} would run as a document (stored XSS). The server now
-- sniffs the bytes when serving, but an older build rolled back onto this
-- database serves the stored type verbatim, so neutralize it here: an
-- octet-stream body is downloaded, never rendered. Data-only and additive;
-- a rescan rebuilds embedded art under the sniff-only rules.

UPDATE artwork SET mime = 'application/octet-stream'
WHERE mime NOT IN ('image/jpeg', 'image/png', 'image/webp', 'image/gif');
