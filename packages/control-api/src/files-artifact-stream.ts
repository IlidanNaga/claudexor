import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createHash } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { DaemonRunRecord } from "./run-record.js";
import { safeArtifactPath } from "./artifact-paths.js";
import { readFilesWorkProduct } from "./files-work-product.js";

/** Full output transfer uses the existing artifact endpoint and immutable result
 * manifest; bounded text previews remain a separate representation. */
export async function streamFilesArtifact(
  record: DaemonRunRecord,
  relative: string,
  res: ServerResponse,
): Promise<boolean> {
  const product = readFilesWorkProduct(record);
  if (!product) return false;
  const state = product.manifest.entries
    .flatMap((entry) => [entry.before, entry.after])
    .find((item) => item !== "unknown" && item?.kind === "file" && item.artifactPath === relative);
  const manifest = relative === product.manifestPath;
  if (!manifest && (!state || state === "unknown" || state.kind !== "file")) return false;
  const path = safeArtifactPath(product.artifactRoot, relative);
  if (!path) throw new Error("Files artifact is unavailable");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("Files artifact is not a regular file");
    const file = state && state !== "unknown" && state.kind === "file" ? state : null;
    const expectedHash = manifest ? product.manifestSha256 : file?.sha256;
    const expectedSize = manifest ? Buffer.byteLength(product.text) : (file?.sizeBytes ?? -1);
    if (stat.size !== expectedSize) throw new Error("Files artifact size mismatch");
    const hash = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk);
    if (`sha256:${hash.digest("hex")}` !== expectedHash)
      throw new Error("Files artifact digest mismatch");
    res.writeHead(200, {
      "Content-Type": manifest ? "application/json" : "application/octet-stream",
      "Content-Length": expectedSize,
      ETag: `"${expectedHash}"`,
    });
    await pipeline(handle.createReadStream({ start: 0, autoClose: false }), res);
    return true;
  } finally {
    await handle.close();
  }
}
