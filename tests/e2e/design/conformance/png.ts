/**
 * THE SMALLEST PNG READER THAT CAN ANSWER "IS ANYTHING PAINTED HERE".
 *
 * A computed style says what the cascade DECLARES; it does not say what the
 * compositor PUT ON THE GLASS. The third proof round measured a search row
 * whose prompt was declared in the muted ink, present as an attribute, and
 * absent from every pixel of every frame — so the reading that settles this
 * control's prompt has to be taken off a raster, the way that round took it.
 *
 * Playwright hands back a PNG buffer and this project ships no image
 * dependency, so the few bytes of decoding it needs live here: 8-bit,
 * non-interlaced, greyscale/RGB/RGBA — which is every shape a Chromium
 * screenshot arrives in — unfiltered through the five PNG line filters with
 * `node:zlib` doing the inflate.
 */
import { inflateSync } from "node:zlib";

export interface Raster {
  width: number;
  height: number;
  channels: number;
  /** Unfiltered, row-major, `channels` bytes per pixel. */
  data: Buffer;
}

const SIGNATURE = "89504e470d0a1a0a";

export function decodePng(buffer: Buffer): Raster {
  if (buffer.subarray(0, 8).toString("hex") !== SIGNATURE) {
    throw new Error("the screenshot is not a PNG");
  }

  let width = 0;
  let height = 0;
  let depth = 0;
  let colourType = 0;
  let interlace = 0;
  const pieces: Buffer[] = [];

  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString("ascii", offset + 4, offset + 8);
    const start = offset + 8;
    if (type === "IHDR") {
      width = buffer.readUInt32BE(start);
      height = buffer.readUInt32BE(start + 4);
      depth = buffer[start + 8];
      colourType = buffer[start + 9];
      interlace = buffer[start + 12];
    } else if (type === "IDAT") {
      pieces.push(buffer.subarray(start, start + length));
    } else if (type === "IEND") {
      break;
    }
    offset = start + length + 4;
  }

  if (depth !== 8) throw new Error(`unsupported bit depth ${depth}`);
  if (interlace !== 0) throw new Error("an interlaced PNG is not read here");
  const channels =
    colourType === 0 ? 1 : colourType === 2 ? 3 : colourType === 4 ? 2 : colourType === 6 ? 4 : 0;
  if (channels === 0) throw new Error(`unsupported colour type ${colourType}`);

  const raw = inflateSync(Buffer.concat(pieces));
  const stride = width * channels;
  const data = Buffer.alloc(height * stride);

  let cursor = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[cursor];
    cursor += 1;
    const line = raw.subarray(cursor, cursor + stride);
    cursor += stride;
    const row = data.subarray(y * stride, (y + 1) * stride);
    const previous = y > 0 ? data.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const left = x >= channels ? row[x - channels] : 0;
      const up = previous ? previous[x] : 0;
      const upLeft = previous && x >= channels ? previous[x - channels] : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = line[x];
          break;
        case 1:
          value = line[x] + left;
          break;
        case 2:
          value = line[x] + up;
          break;
        case 3:
          value = line[x] + ((left + up) >> 1);
          break;
        case 4: {
          const predictor = left + up - upLeft;
          const dLeft = Math.abs(predictor - left);
          const dUp = Math.abs(predictor - up);
          const dUpLeft = Math.abs(predictor - upLeft);
          const nearest =
            dLeft <= dUp && dLeft <= dUpLeft ? left : dUp <= dUpLeft ? up : upLeft;
          value = line[x] + nearest;
          break;
        }
        default:
          throw new Error(`unknown PNG line filter ${filter}`);
      }
      row[x] = value & 0xff;
    }
  }

  return { width, height, channels, data };
}

/** Rec. 601 luminance of one pixel, 0 to 255. */
export function luminance(raster: Raster, x: number, y: number): number {
  const at = (y * raster.width + x) * raster.channels;
  if (raster.channels <= 2) return raster.data[at];
  const r = raster.data[at];
  const g = raster.data[at + 1];
  const b = raster.data[at + 2];
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * The ground of a raster, taken as the most common luminance rounded to whole
 * steps — the row's own fill, whatever the palette resolves it to.
 */
export function groundLuminance(raster: Raster): number {
  const counts = new Map<number, number>();
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      const key = Math.round(luminance(raster, x, y));
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let best = 0;
  let seen = -1;
  for (const [key, count] of counts) {
    if (count > seen) {
      seen = count;
      best = key;
    }
  }
  return best;
}

export interface InkReading {
  ground: number;
  /** How far the strongest pixel departs from the ground. */
  strongestDeviation: number;
  /** Pixels departing from the ground by more than `threshold`. */
  inkPixels: number;
  /** Distinct columns holding at least one such pixel — a caret is a few. */
  inkColumns: number;
}

/** What is painted over the ground of a raster, counted rather than described. */
export function readInk(raster: Raster, threshold = 24): InkReading {
  const ground = groundLuminance(raster);
  const columns = new Set<number>();
  let inkPixels = 0;
  let strongestDeviation = 0;
  for (let y = 0; y < raster.height; y += 1) {
    for (let x = 0; x < raster.width; x += 1) {
      const deviation = Math.abs(luminance(raster, x, y) - ground);
      if (deviation > strongestDeviation) strongestDeviation = deviation;
      if (deviation > threshold) {
        inkPixels += 1;
        columns.add(x);
      }
    }
  }
  return {
    ground,
    strongestDeviation: Math.round(strongestDeviation * 10) / 10,
    inkPixels,
    inkColumns: columns.size,
  };
}
