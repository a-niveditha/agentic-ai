import { LoaderError } from './types.js';

export interface ZipLimits {
  maxEntries: number;
  maxUncompressedBytes: number;
  maxRatio: number;
}

export const DEFAULT_ZIP_LIMITS: ZipLimits = {
  maxEntries: 2_000,
  maxUncompressedBytes: 60 * 1024 * 1024,
  maxRatio: 200,
};

/**
 * Reads only the zip central directory (no decompression) and rejects archives that would expand into
 * an unreasonable amount of data (zip bombs) before a parser ever inflates them.
 */
export function assertZipIsSafe(buffer: Buffer, limits: ZipLimits = DEFAULT_ZIP_LIMITS): void {
  const eocdSig = 0x06054b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 22 - 0xffff); i--) {
    if (buffer.readUInt32LE(i) === eocdSig) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new LoaderError('corrupt', 'Not a valid zip container.');

  const entries = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  if (entries === 0xffff || cdOffset === 0xffffffff) {
    throw new LoaderError('corrupt', 'Zip64 archives are not supported.');
  }
  if (entries > limits.maxEntries) throw new LoaderError('too_large', 'Archive has too many entries.');

  let total = 0;
  let pos = cdOffset;
  for (let n = 0; n < entries; n++) {
    if (pos + 46 > buffer.length || buffer.readUInt32LE(pos) !== 0x02014b50) {
      throw new LoaderError('corrupt', 'Corrupt zip central directory.');
    }
    const compressed = buffer.readUInt32LE(pos + 20);
    const uncompressed = buffer.readUInt32LE(pos + 24);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    total += uncompressed;
    if (total > limits.maxUncompressedBytes) {
      throw new LoaderError('too_large', 'Archive expands to too much data (possible zip bomb).');
    }
    if (uncompressed > 1024 * 1024 && uncompressed / Math.max(1, compressed) > limits.maxRatio) {
      throw new LoaderError('too_large', 'Archive compression ratio is suspicious (possible zip bomb).');
    }
    pos += 46 + nameLen + extraLen + commentLen;
  }
}
