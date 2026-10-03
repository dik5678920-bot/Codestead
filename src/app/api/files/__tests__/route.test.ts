// @vitest-environment node
import { NextRequest } from "next/server";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const errors = vi.hoisted(() => ({
  conflict: class UploadIdempotencyConflictError extends Error {},
  ambiguous: class UploadCommitAmbiguousError extends Error {},
  tombstoned: class UploadIdempotencyTombstonedError extends Error {},
}));

const mocks = vi.hoisted(() => ({
  requireAuth: vi.fn(),
  select: vi.fn(),
  createUpload: vi.fn(),
  store: {},
  repository: {},
  root: "",
}));

vi.mock("@/lib/db/client", () => ({ db: { select: mocks.select } }));
vi.mock("@/lib/http/authz", () => ({ requireAuth: mocks.requireAuth }));
vi.mock("@/lib/security/rate-limit", () => ({
  withRateLimit: vi.fn(async (_input, handler: () => Promise<Response>) => handler()),
}));
vi.mock("@/lib/storage/object-root", () => ({ objectStorageRoot: () => mocks.root }));
vi.mock("@/lib/storage/durable-object-store", () => ({
  NodeDurableObjectStore: class NodeDurableObjectStore {
    constructor() {
      return mocks.store;
    }
  },
}));
vi.mock("@/lib/storage/upload-repository", () => ({
  PostgresUploadReceiptRepository: class PostgresUploadReceiptRepository {
    constructor() {
      return mocks.repository;
    }
  },
}));
vi.mock("@/lib/storage/upload-service", () => ({
  createDurableUpload: mocks.createUpload,
  UploadIdempotencyConflictError: errors.conflict,
  UploadCommitAmbiguousError: errors.ambiguous,
  UploadIdempotencyTombstonedError: errors.tombstoned,
}));
vi.mock("@/lib/storage/quota-store", () => ({
  StorageQuotaExceededError: class StorageQuotaExceededError extends Error {},
}));

import { GET, POST } from "../route";
import { MAX_UPLOAD_BYTES } from "@/lib/storage/policy";

function streamedRequest(chunks: Uint8Array[], contentLength?: string) {
  let reads = 0;
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[reads++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel,
  }, { highWaterMark: 0 });
  const request = new NextRequest("http://localhost/api/files", {
    method: "POST", body, duplex: "half",
    headers: {
      "Content-Type": "multipart/form-data; boundary=test-boundary",
      "Idempotency-Key": "a1000000-0000-4000-8000-000000000001",
      ...(contentLength === undefined ? {} : { "Content-Length": contentLength }),
    },
  } as ConstructorParameters<typeof NextRequest>[1]);
  return { request, cancel, reads: () => reads };
}

const multipartStart = Buffer.from('--test-boundary\r\nContent-Disposition: form-data; name="file"; filename="main.py"\r\nContent-Type: text/plain\r\n\r\n');
const multipartEnd = Buffer.from("\r\n--test-boundary--\r\n");

const originalUploadsEnabled = process.env.UPLOADS_ENABLED;

describe("learner file API integrity metadata boundary", () => {
  it("rejects an oversized Content-Length before reading any body bytes", async () => {
    const input = streamedRequest([multipartStart], String(MAX_UPLOAD_BYTES + 1024 * 1024));
    const response = await POST(input.request);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Files must be between 1 byte and 50 MB." });
    expect(input.reads()).toBe(0);
    expect(mocks.createUpload).not.toHaveBeenCalled();
  });

  it.each([undefined, "1"])("stops a streaming oversized file with Content-Length %s", async (length) => {
    const input = streamedRequest([
      multipartStart, Buffer.alloc(MAX_UPLOAD_BYTES, 97), Buffer.from("x"), multipartEnd,
    ], length);
    const response = await POST(input.request);
    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: "Files must be between 1 byte and 50 MB." });
    expect(input.reads()).toBe(3);
    expect(input.cancel).toHaveBeenCalled();
    expect(mocks.createUpload).not.toHaveBeenCalled();
  });

  it("accepts exactly 50 MiB, with multipart framing split across chunks", async () => {
    const input = streamedRequest([
      multipartStart.subarray(0, 7), multipartStart.subarray(7),
      Buffer.alloc(MAX_UPLOAD_BYTES, 97), multipartEnd,
    ], String(multipartStart.length + MAX_UPLOAD_BYTES + multipartEnd.length));
    expect((await POST(input.request)).status).toBe(201);
    const bytes = mocks.createUpload.mock.calls[0][0].bytes as Buffer;
    expect(bytes.length).toBe(MAX_UPLOAD_BYTES);
    expect(bytes[0]).toBe(97);
    expect(bytes.at(-1)).toBe(97);
    expect(input.cancel).not.toHaveBeenCalled();
  });

  it("bounds ignored multipart content before reading the rest of the body", async () => {
    const input = streamedRequest([
      Buffer.from('--test-boundary\r\nContent-Disposition: form-data; name="ignored"\r\n\r\n'),
      Buffer.alloc(MAX_UPLOAD_BYTES + 64 * 1024 + 1, 97), multipartEnd,
    ]);
    expect((await POST(input.request)).status).toBe(413);
    expect(input.reads()).toBe(2);
    expect(input.cancel).toHaveBeenCalled();
    expect(mocks.createUpload).not.toHaveBeenCalled();
  });

  it("keeps the empty-file 413 and missing-file 400 responses", async () => {
    const empty = streamedRequest([multipartStart, multipartEnd]);
    expect((await POST(empty.request)).status).toBe(413);
    const missing = streamedRequest([Buffer.from('--test-boundary\r\nContent-Disposition: form-data; name="other"\r\n\r\nhello'), multipartEnd]);
    const response = await POST(missing.request);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Choose a file." });
    expect(mocks.createUpload).not.toHaveBeenCalled();
  });

  it("does not finalize a truncated multipart upload", async () => {
    const input = streamedRequest([multipartStart, Buffer.from("hello")]);
    await expect(POST(input.request)).rejects.toThrow();
    expect(mocks.createUpload).not.toHaveBeenCalled();
  });
  beforeEach(async () => {
    process.env.UPLOADS_ENABLED = "true";
    vi.clearAllMocks();
    mocks.root = await mkdtemp(path.join(tmpdir(), "learncoding-file-route-test-"));
    mocks.requireAuth.mockResolvedValue({
      session: { user: { id: "learner-1" } },
      response: null,
    });
    mocks.createUpload.mockResolvedValue({
      id: "a2000000-0000-4000-8000-000000000001",
      name: "main.py",
      mediaType: "text/plain",
      sizeBytes: 5,
      storageKey: `${"a".repeat(64)}/a2000000-0000-4000-8000-000000000001`,
      sha256: "b".repeat(64),
      scanStatus: "pending",
      replayed: false,
    });
  });

  afterEach(async () => {
    if (originalUploadsEnabled === undefined) delete process.env.UPLOADS_ENABLED;
    else process.env.UPLOADS_ENABLED = originalUploadsEnabled;
    await rm(mocks.root, { recursive: true, force: true });
  });

  it("does not select or return server-side content hashes in the learner listing", async () => {
    mocks.select.mockImplementation(() => {
      const call = mocks.select.mock.calls.length;
      return {
        from: () => ({
          where: () => call === 1
            ? Promise.resolve([{
                id: "file-1",
                name: "main.py",
                mediaType: "text/plain",
                sizeBytes: 5,
                scanStatus: "safe",
                createdAt: new Date("2026-07-12T00:00:00.000Z"),
              }])
            : { limit: async () => [{ quota: 2 * 1024 ** 3 }] },
        }),
      };
    });
    const response = await GET();
    expect(response.status).toBe(200);
    const firstProjection = mocks.select.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(firstProjection).not.toHaveProperty("sha256");
    const body = await response.json();
    expect(body.files[0]).toMatchObject({ id: "file-1", name: "main.py", sizeBytes: 5 });
    expect(body.uploadsEnabled).toBe(true);
    expect(JSON.stringify(body)).not.toContain("sha256");
    expect(response.headers.get("cache-control")).toContain("no-store");
  });

  it("returns a safe size-limit reason without exposing raw scanner errors", async () => {
    mocks.select.mockImplementation(() => {
      const call = mocks.select.mock.calls.length;
      return { from: () => ({ where: () => call === 1 ? Promise.resolve([
        { id: "size-rejected", sizeBytes: 5, scanStatus: "scanner_error", scanErrorCode: "scanner_size_limit" },
        { id: "other-error", sizeBytes: 5, scanStatus: "scanner_error", scanErrorCode: "private daemon text" },
      ]) : { limit: async () => [{ quota: 2 * 1024 ** 3 }] } }) };
    });
    const response = await GET();
    const body = await response.json();
    expect(body.files[0].scanFailureReason).toBe("This file exceeds the safety scanner's size limit. Upload a smaller file.");
    expect(JSON.stringify(body)).not.toContain("scanErrorCode");
    expect(JSON.stringify(body)).not.toContain("private daemon text");
  });

  it("keeps the digest in the server reservation while omitting it from the upload response", async () => {
    const form = new FormData();
    form.set("file", new File(["hello"], "main.py", { type: "text/plain" }));
    const request = new NextRequest("http://localhost/api/files", {
      method: "POST", body: form,
      headers: { "Idempotency-Key": "a1000000-0000-4000-8000-000000000001" },
    });
    const response = await POST(request);
    expect(response.status).toBe(201);
    expect(mocks.createUpload).toHaveBeenCalledWith(expect.objectContaining({
      ownerUserId: "learner-1",
      idempotencyKey: "a1000000-0000-4000-8000-000000000001",
      originalName: "main.py",
      mediaType: "text/plain",
      scanStatus: "pending",
      bytes: expect.any(Buffer),
    }), expect.objectContaining({
      store: mocks.store,
      repository: mocks.repository,
    }));
    const body = await response.json();
    expect(body.file).toMatchObject({ name: "main.py", sizeBytes: 5 });
    expect(body.file).not.toHaveProperty("sha256");
    expect(JSON.stringify(body)).not.toContain("sha256");
  });

  it("requires a UUID idempotency key before reading an enabled upload body", async () => {
    const formData = vi.fn(async () => {
      const form = new FormData();
      form.set("file", new File(["hello"], "main.py", { type: "text/plain" }));
      return form;
    });
    const response = await POST({
      headers: new Headers({ "Idempotency-Key": "not-a-uuid" }),
      formData,
    } as unknown as NextRequest);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      code: "INVALID_IDEMPOTENCY_KEY",
      error: "Idempotency-Key must be a UUID.",
    });
    expect(formData).not.toHaveBeenCalled();
    expect(mocks.createUpload).not.toHaveBeenCalled();
  });

  it("returns 409 when a UUID is replayed with a different payload", async () => {
    mocks.createUpload.mockRejectedValueOnce(new errors.conflict());
    const form = new FormData();
    form.set("file", new File(["changed"], "main.py", { type: "text/plain" }));
    const response = await POST(new NextRequest("http://localhost/api/files", {
      method: "POST", body: form,
      headers: { "Idempotency-Key": "a1000000-0000-4000-8000-000000000001" },
    }));
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
  });

  it("returns a stable no-store 410 when an exact replay belongs to a deleted upload", async () => {
    mocks.createUpload.mockRejectedValueOnce(new errors.tombstoned());
    const form = new FormData();
    form.set("file", new File(["hello"], "main.py", { type: "text/plain" }));
    const response = await POST(new NextRequest("http://localhost/api/files", {
      method: "POST", body: form,
      headers: { "Idempotency-Key": "a1000000-0000-4000-8000-000000000001" },
    }));
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({
      code: "UPLOAD_IDEMPOTENCY_TOMBSTONED",
      error: "This Idempotency-Key belongs to a deleted upload and cannot be reused.",
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("rejects disabled uploads before reading the request body", async () => {
    process.env.UPLOADS_ENABLED = "false";
    const formData = vi.fn(async () => {
      throw new Error("body was parsed");
    });
    const response = await POST({ formData } as unknown as NextRequest);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      code: "UPLOADS_DISABLED",
      error: "Project file uploads are disabled during the private pilot.",
    });
    expect(formData).not.toHaveBeenCalled();
    expect(mocks.createUpload).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toContain("no-store");
  });
});
