import busboy from "busboy";
import { MAX_UPLOAD_BYTES } from "./policy";

// Bound framing, ignored fields and extra parts as well as the selected file.
// The file allowance remains exactly 50 MiB; framing is not file content.
export const MAX_UPLOAD_BODY_BYTES = MAX_UPLOAD_BYTES + 64 * 1024;

export class UploadTooLargeError extends Error {}

export async function readUpload(request: Request): Promise<{ name: string; bytes: Buffer } | null> {
  const length = request.headers.get("Content-Length");
  if (length !== null && /^\d+$/.test(length) && BigInt(length) > BigInt(MAX_UPLOAD_BODY_BYTES)) {
    await request.body?.cancel().catch(() => {});
    throw new UploadTooLargeError();
  }
  if (!request.body) return null;

  const parser = busboy({
    headers: { "content-type": request.headers.get("Content-Type") ?? "" },
    defParamCharset: "utf8",
    // Busboy emits limit on reaching this value, so allow the exact limit
    // and reject at the first byte beyond it.
    limits: { fileSize: MAX_UPLOAD_BYTES + 1, fieldSize: 64 * 1024 },
  });
  const reader = request.body.getReader();
  const chunks: Buffer[] = [];
  let name: string | undefined;
  let selected = false;
  let failure: Error | undefined;
  let size = 0;
  let bodySize = 0;
  parser.on("error", (error: Error) => { failure ??= error; });
  parser.on("field", (field) => {
    if (field === "file" && !selected) selected = true;
  });
  parser.on("file", (field, file, info) => {
    const retain = field === "file" && !selected;
    if (retain) { selected = true; name = info.filename; }
    file.on("error", (error: Error) => { failure ??= error; });
    file.on("limit", () => { failure ??= new UploadTooLargeError(); });
    file.on("data", (chunk: Buffer) => {
      if (!retain || failure) return;
      size += chunk.length;
      if (size > MAX_UPLOAD_BYTES) failure = new UploadTooLargeError();
      else chunks.push(Buffer.from(chunk));
    });
  });

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bodySize += value.byteLength;
      if (bodySize > MAX_UPLOAD_BODY_BYTES) throw new UploadTooLargeError();
      await new Promise<void>((resolve, reject) => {
        parser.write(value, (error) => error ? reject(error) : resolve());
      });
      if (failure) throw failure;
    }
    await new Promise<void>((resolve, reject) => {
      parser.once("close", resolve);
      parser.once("error", reject);
      parser.end();
    });
    if (failure) throw failure;
    if (name === undefined) return null;
    if (size === 0) throw new UploadTooLargeError();
    return { name, bytes: Buffer.concat(chunks, size) };
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    parser.destroy();
    reader.releaseLock();
    for (const chunk of chunks) chunk.fill(0);
  }
}
