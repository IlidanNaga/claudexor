import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";

const MAX_HELPER_BYTES = 16 * 1024 * 1024;
const IMAGE_FILE_MACHINE_AMD64 = 0x8664;
const IMAGE_FILE_EXECUTABLE_IMAGE = 0x0002;
const PE32_PLUS_MAGIC = 0x020b;

/** Validate one helper as a bounded, regular PE32+ x64 executable and return
 * its lowercase SHA-256. This is byte custody only; it deliberately makes no
 * Authenticode claim. */
export function inspectWin32ConptyHelper(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 256 || info.size > MAX_HELPER_BYTES) {
    throw new Error(`ConPTY helper is not a bounded regular file: ${path}`);
  }
  const bytes = readFileSync(path);
  if (bytes[0] !== 0x4d || bytes[1] !== 0x5a) {
    throw new Error(`ConPTY helper has no MZ header: ${path}`);
  }
  const pe = bytes.readUInt32LE(0x3c);
  if (pe < 0x40 || pe + 26 > bytes.length || bytes.toString("ascii", pe, pe + 4) !== "PE\0\0") {
    throw new Error(`ConPTY helper has an invalid PE header: ${path}`);
  }
  const machine = bytes.readUInt16LE(pe + 4);
  const optionalHeaderBytes = bytes.readUInt16LE(pe + 20);
  const characteristics = bytes.readUInt16LE(pe + 22);
  if (machine !== IMAGE_FILE_MACHINE_AMD64) {
    throw new Error(`ConPTY helper is PE machine 0x${machine.toString(16)}, expected x64: ${path}`);
  }
  if (
    optionalHeaderBytes < 2 ||
    pe + 24 + optionalHeaderBytes > bytes.length ||
    bytes.readUInt16LE(pe + 24) !== PE32_PLUS_MAGIC
  ) {
    throw new Error(`ConPTY helper is not a complete PE32+ image: ${path}`);
  }
  if ((characteristics & IMAGE_FILE_EXECUTABLE_IMAGE) === 0) {
    throw new Error(`ConPTY helper PE is not marked executable: ${path}`);
  }
  return createHash("sha256").update(bytes).digest("hex");
}

/** Require every carrier to contain the exact same validated bytes. */
export function verifyWin32ConptyHelperCustody(paths, expectedSha256) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new Error("at least one ConPTY helper path is required");
  }
  if (expectedSha256 !== undefined && !/^[0-9a-f]{64}$/.test(expectedSha256)) {
    throw new Error("expected ConPTY helper SHA-256 must be 64 lowercase hex characters");
  }
  const observed = paths.map((path) => ({ path, sha256: inspectWin32ConptyHelper(path) }));
  const authority = expectedSha256 ?? observed[0].sha256;
  for (const item of observed) {
    if (item.sha256 !== authority) {
      throw new Error(
        `ConPTY helper byte mismatch: ${item.path} has ${item.sha256}, expected ${authority}`,
      );
    }
  }
  return { sha256: authority, files: observed };
}
