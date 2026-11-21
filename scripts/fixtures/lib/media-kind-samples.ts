// Deterministic sample bytes for the six media kinds the review island's byte
// road serves (`MEDIA_BYTE_ROAD_KINDS` in src/lib/lifecycle/review-island-byte-road.ts):
// image, video, audio, pdf, document and archive.
//
// Development fixture data only. Every sample is a small, well-formed file of
// its form, built here from code (the video is a fixed 578-byte VP8 WebM), so
// the fixture needs no model, no network and no binary file in the tree. The
// same call always returns the same bytes.

/** One media kind's sample: the form it is filed under and its bytes. */
export interface MediaKindSample {
  /** The byte road's kind name (a key of `MEDIA_BYTE_ROAD_KINDS`). */
  kind: "image" | "video" | "audio" | "pdf" | "document" | "archive";
  /** The form the sample is uploaded as, and the form the store detects. */
  mime: string;
  filename: string;
  title: string;
  bytes: Buffer;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (ISO-HDLC), as PNG chunks and ZIP entries use it. */
export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u16le(n: number) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32le(n: number) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }
function u32be(n: number) { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; }

/** A zlib stream of stored (uncompressed) blocks: byte-stable on every zlib. */
function zlibStored(data: Buffer): Buffer {
  const parts: Buffer[] = [Buffer.from([0x78, 0x01])];
  let at = 0;
  do {
    const block = data.subarray(at, at + 0xffff);
    at += block.length;
    parts.push(Buffer.from([at >= data.length ? 1 : 0]), u16le(block.length), u16le(~block.length & 0xffff), block);
  } while (at < data.length);
  let a = 1, b = 0;
  for (const byte of data) { a = (a + byte) % 65521; b = (b + a) % 65521; }
  parts.push(u32be((b << 16) | a));
  return Buffer.concat(parts);
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typed = Buffer.concat([Buffer.from(type, "latin1"), data]);
  return Buffer.concat([u32be(data.length), typed, u32be(crc32(typed))]);
}

/** A 64x36 RGB PNG: two bands of colour. */
function samplePng(): Buffer {
  const width = 64, height = 36;
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const [r, g, bl] = y < height / 2 ? [0x2f, 0x6f, 0xdf] : [0xf4, 0xb4, 0x3c];
      row[1 + x * 3] = r; row[2 + x * 3] = g; row[3 + x * 3] = bl;
    }
    rows.push(row);
  }
  const ihdr = Buffer.concat([u32be(width), u32be(height), Buffer.from([8, 2, 0, 0, 0])]);
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", ihdr), pngChunk("IDAT", zlibStored(Buffer.concat(rows))), pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

// A two-second 64x36 VP8 WebM of one solid colour, made once with
//   ffmpeg -f lavfi -i color=c=0x2f6fdf:s=64x36:r=2:d=2 -c:v libvpx -b:v 20k -an
//     -fflags +bitexact -flags:v +bitexact -map_metadata -1 -f webm sample.webm
// It carries no encoder version and no creation time.
const WEBM_BASE64 = [
  "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAISEU2bdLpNu4tTq4QVSalmU6yBoU27i1Or",
  "hBZUrmtTrIHGTbuMU6uEElTDZ1OsggETTbuMU6uEHFO7a1OsggH87AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmoCrX",
  "sYMPQkBNgIRMYXZmV0GETGF2ZkSJiECfQAAAAAAAFlSua8iuAQAAAAAAAD/XgQFzxYgAAAAAAAAAAZyBACK1nIN1bmSIgQCG",
  "hVZfVlA4g4EBI+ODhB3NZQDgkLCBQLqBJJqBAlWwhFW5gQESVMNn0HNzzWPAi2PFiAAAAAAAAAABZ8iYRaOHRU5DT0RFUkSH",
  "i0xhdmMgbGlidnB4Z8ihRaOIRFVSQVRJT05Eh5MwMDowMDowMi4wMDAwMDAwMDAAH0O2dUCO54EAo8GBAACAkAMAnQEqQAAk",
  "AABHCIWFiIWEiAICAnWqA/gD+gIHO3nizzMeXgD+9hNf/3HimPJRv+48v/w4+owoP/C/gKOWgQH0ANEBAAEQEAAYABhYL/QA",
  "CIwAAKOWgQPoANEBAAEQEAAYABhYL/QACIwAAKOWgQXcANEBAAEQEAAYABhYL/QACIwAABxTu2uRu4+zgQC3iveBAfGCAWjw",
  "gQM=",
].join("");

/** One second of a 440 Hz triangle tone, 16-bit mono PCM at 8000 Hz. */
function sampleWav(): Buffer {
  const rate = 8000, samples = rate, period = rate / 440;
  const pcm = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const phase = (i % period) / period;
    const level = phase < 0.5 ? 4 * phase - 1 : 3 - 4 * phase;
    pcm.writeInt16LE(Math.round(level * 8000), i * 2);
  }
  const fmt = Buffer.concat([u16le(1), u16le(1), u32le(rate), u32le(rate * 2), u16le(2), u16le(16)]);
  return Buffer.concat([
    Buffer.from("RIFF", "latin1"), u32le(4 + 8 + fmt.length + 8 + pcm.length), Buffer.from("WAVE", "latin1"),
    Buffer.from("fmt ", "latin1"), u32le(fmt.length), fmt,
    Buffer.from("data", "latin1"), u32le(pcm.length), pcm,
  ]);
}

/** A one-page PDF with one line of text and a correct cross-reference table. */
function samplePdf(): Buffer {
  const text = "BT /F1 18 Tf 36 96 Td (Cinatra media fixture: pdf) Tj ET";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${text.length} >>\nstream\n${text}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}

/** A ZIP of stored entries, every entry dated 1980-01-01 00:00. */
function storedZip(entries: ReadonlyArray<{ name: string; data: Buffer }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(data);
    const common = Buffer.concat([
      u16le(0), u16le(0), u16le(0), u16le(0x21), u32le(crc), u32le(data.length), u32le(data.length),
      u16le(nameBytes.length), u16le(0),
    ]);
    const local = Buffer.concat([u32le(0x04034b50), u16le(20), common, nameBytes, data]);
    centrals.push(Buffer.concat([
      u32le(0x02014b50), u16le(20), u16le(20), common, u16le(0), u16le(0), u16le(0), u32le(0), u32le(offset), nameBytes,
    ]));
    locals.push(local);
    offset += local.length;
  }
  const central = Buffer.concat(centrals);
  const end = Buffer.concat([
    u32le(0x06054b50), u16le(0), u16le(0), u16le(entries.length), u16le(entries.length),
    u32le(central.length), u32le(offset), u16le(0),
  ]);
  return Buffer.concat([...locals, central, end]);
}

const xml = (s: string) => Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${s}`, "utf8");

/** A minimal Word document (OOXML) with one paragraph. */
function sampleDocx(): Buffer {
  return storedZip([
    { name: "[Content_Types].xml", data: xml(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
      "</Types>") },
    { name: "_rels/.rels", data: xml(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
      "</Relationships>") },
    { name: "word/document.xml", data: xml(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
      "<w:body><w:p><w:r><w:t>Cinatra media fixture: document</w:t></w:r></w:p></w:body></w:document>") },
  ]);
}

function sampleArchive(): Buffer {
  return storedZip([
    { name: "README.txt", data: Buffer.from("Cinatra media fixture: archive\n", "utf8") },
    { name: "data/sample.csv", data: Buffer.from("kind,form\narchive,application/zip\n", "utf8") },
  ]);
}

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** The six samples, one per media kind, in the byte road's order. */
export function mediaKindSamples(): MediaKindSample[] {
  return [
    { kind: "image", mime: "image/png", filename: "media-fixture.png", title: "Media fixture: image", bytes: samplePng() },
    { kind: "video", mime: "video/webm", filename: "media-fixture.webm", title: "Media fixture: video", bytes: Buffer.from(WEBM_BASE64, "base64") },
    { kind: "audio", mime: "audio/wav", filename: "media-fixture.wav", title: "Media fixture: audio", bytes: sampleWav() },
    { kind: "pdf", mime: "application/pdf", filename: "media-fixture.pdf", title: "Media fixture: pdf", bytes: samplePdf() },
    { kind: "document", mime: DOCX, filename: "media-fixture.docx", title: "Media fixture: document", bytes: sampleDocx() },
    { kind: "archive", mime: "application/zip", filename: "media-fixture.zip", title: "Media fixture: archive", bytes: sampleArchive() },
  ];
}
