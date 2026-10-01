import { constants } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fs = vi.hoisted(() => ({ link: vi.fn(), lstat: vi.fn(), mkdir: vi.fn(), open: vi.fn(), readFile: vi.fn(), realpath: vi.fn(), unlink: vi.fn() }));
vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>(), ...fs, default: fs }));
import { DurableObjectStoreSafetyError, NodeDurableObjectStore, OBJECT_STORAGE_MARKER_CONTENT, OBJECT_STORAGE_MARKER_NAME } from "../durable-object-store";

const root = path.resolve("objects");
const owner = "a".repeat(64);
const objectId = "11111111-1111-4111-8111-111111111111";
const rootReference = "/proc/self/fd/10";
const ownerReference = "/proc/self/fd/12";
const markerPath = path.join(rootReference, OBJECT_STORAGE_MARKER_NAME);
const ownerPath = path.join(rootReference, owner);
const tempPath = path.join(ownerReference, `.${objectId}.fixed.uploading`);
const destination = path.join(ownerReference, objectId);
const original = new Map(["platform", "getuid", "getgid"].map((key) => [key, Object.getOwnPropertyDescriptor(process, key)]));
const uid = vi.fn(() => 1000); const gid = vi.fn(() => 1000);
const identity = (ino: number, mode: number, userId: number) => ({ dev: 8, ino, mode, uid: userId, gid: 1000, nlink: 1, isSymbolicLink: () => false, isDirectory: () => (mode & 0o170000) === 0o040000 });
const rootStat = () => identity(10, 0o041770, 0);
const markerStat = () => identity(11, 0o100440, 0);
const ownerStat = () => identity(12, 0o040700, 1000);
function handle(fd: number, stat: () => ReturnType<typeof identity>) {
  return { fd, stat: vi.fn(async () => stat()), close: vi.fn(async () => undefined), sync: vi.fn(async () => undefined), write: vi.fn(async (_bytes: Buffer, _offset: number, length: number) => ({ bytesWritten: length })) };
}
let rootHandle: ReturnType<typeof handle>;
let markerHandle: ReturnType<typeof handle>;
let ownerHandle: ReturnType<typeof handle>;
let fileHandle: ReturnType<typeof handle>;
const create = () => new NodeDurableObjectStore({ root, temporarySuffix: () => "fixed" }).create({ ownerSegment: owner, objectId, bytes: Buffer.from("payload") });
beforeEach(() => {
  vi.resetAllMocks(); uid.mockReturnValue(1000); gid.mockReturnValue(1000);
  for (const [key, value] of [["platform", "linux"], ["getuid", uid], ["getgid", gid]] as const) Object.defineProperty(process, key, { configurable: true, value });
  rootHandle = handle(10, rootStat); markerHandle = handle(11, markerStat); ownerHandle = handle(12, ownerStat); fileHandle = handle(13, () => identity(13, 0o100600, 1000));
  fs.realpath.mockImplementation(async (name) => name === root ? root : path.join(root, owner));
  fs.lstat.mockImplementation(async (name) => name === root ? rootStat() : name === markerPath ? markerStat() : name === ownerPath ? ownerStat() : identity(13, 0o100600, 1000));
  fs.open.mockImplementation(async (name) => name === root ? rootHandle : name === markerPath ? markerHandle : name === ownerPath ? ownerHandle : fileHandle);
  fs.readFile.mockResolvedValue(Buffer.from(OBJECT_STORAGE_MARKER_CONTENT));
  fs.link.mockResolvedValue(undefined); fs.unlink.mockResolvedValue(undefined); fs.mkdir.mockResolvedValue(undefined);
});
afterEach(() => {
  for (const [key, descriptor] of original) {
    if (descriptor) Object.defineProperty(process, key, descriptor);
    else Reflect.deleteProperty(process, key);
  }
});

describe("node filesystem durability boundary", () => {
  it("pins root and marker handles, publishes without overwrite, and syncs the directory before returning", async () => {
    expect(await create()).toEqual({ storageKey: `${owner}/${objectId}` });
    expect(fs.mkdir).toHaveBeenCalledWith(ownerPath, { mode: 0o700 });
    expect(fs.open).toHaveBeenCalledWith(tempPath, expect.any(Number), 0o600);
    const flags = fs.open.mock.calls.find(([name]) => name === tempPath)![1];
    expect(flags & constants.O_EXCL).toBe(constants.O_EXCL);
    expect(flags & constants.O_CREAT).toBe(constants.O_CREAT);
    expect(fs.link).toHaveBeenCalledWith(tempPath, destination);
    expect(fs.unlink).toHaveBeenCalledWith(tempPath);
    expect(fileHandle.sync.mock.invocationCallOrder[0]).toBeLessThan(fs.link.mock.invocationCallOrder[0]);
    expect(fs.link.mock.invocationCallOrder[0]).toBeLessThan(ownerHandle.sync.mock.invocationCallOrder[0]);
    expect(rootHandle.sync).toHaveBeenCalledOnce();
    expect(ownerHandle.close).toHaveBeenCalledOnce(); expect(markerHandle.close).toHaveBeenCalledTimes(2); expect(rootHandle.close).toHaveBeenCalledTimes(2);
  });
  it("opens an existing owner without claiming its directory was newly created", async () => {
    fs.mkdir.mockRejectedValue(Object.assign(new Error("exists"), { code: "EEXIST" }));
    expect(await create()).toEqual({ storageKey: `${owner}/${objectId}` });
    expect(rootHandle.sync).not.toHaveBeenCalled();
    expect(fileHandle.write).toHaveBeenCalledWith(Buffer.from("payload"), 0, 7);
  });
  it("erases through the pinned owner handle and revalidates the owner after syncing", async () => {
    expect(await new NodeDurableObjectStore({ root }).erase(`${owner}/${objectId}`)).toEqual({ alreadyAbsent: false });
    expect(fs.mkdir).not.toHaveBeenCalled(); expect(fs.lstat).toHaveBeenCalledWith(destination);
    expect(fs.unlink).toHaveBeenCalledWith(destination); expect(ownerHandle.sync).toHaveBeenCalledOnce();
    expect(ownerHandle.stat).toHaveBeenCalledTimes(2); expect(ownerHandle.close).toHaveBeenCalledOnce();
  });
  it("does not overwrite a destination collision and durably removes the temporary file", async () => {
    const collision = Object.assign(new Error("collision"), { code: "EEXIST" }); fs.link.mockRejectedValue(collision);
    await expect(create()).rejects.toBe(collision);
    expect(fs.unlink.mock.calls).toEqual([[tempPath]]); expect(ownerHandle.sync).toHaveBeenCalledOnce();
  });
  it("rolls back the destination link if removing the source link fails", async () => {
    const failure = new Error("unlink source failed"); fs.unlink.mockRejectedValueOnce(failure);
    await expect(create()).rejects.toBe(failure);
    expect(fs.unlink.mock.calls).toEqual([[tempPath], [destination], [tempPath]]);
    expect(ownerHandle.sync).toHaveBeenCalledOnce();
  });
  it("cleans both names when publication rollback has an ambiguous outcome", async () => {
    fs.unlink.mockRejectedValueOnce(new Error("source failure")).mockRejectedValueOnce(new Error("rollback failure"));
    await expect(create()).rejects.toMatchObject({ name: "DurableObjectPublicationStateError" });
    expect(fs.unlink.mock.calls).toEqual([[tempPath], [destination], [destination], [tempPath]]);
    expect(ownerHandle.sync).toHaveBeenCalledOnce();
  });
  it.each(["wrong marker", "changed root identity", "root symlink", "root not directory", "changed canonical root", "missing group"])("refuses %s before writing", async (failure) => {
    if (failure === "wrong marker") fs.readFile.mockResolvedValue(Buffer.from("other root"));
    if (failure === "changed root identity") rootHandle.stat.mockResolvedValue({ ...rootStat(), ino: 99 });
    if (failure === "root symlink") fs.lstat.mockResolvedValueOnce({ ...rootStat(), isSymbolicLink: () => true });
    if (failure === "root not directory") fs.lstat.mockResolvedValueOnce({ ...rootStat(), isDirectory: () => false });
    if (failure === "changed canonical root") fs.realpath.mockResolvedValueOnce(path.resolve("other-root"));
    if (failure === "missing group") Object.defineProperty(process, "getgid", { value: undefined, configurable: true });
    await expect(create()).rejects.toBeInstanceOf(DurableObjectStoreSafetyError);
    expect(fileHandle.write).not.toHaveBeenCalled(); expect(fs.link).not.toHaveBeenCalled();
  });
  it("wraps root I/O errors and closes any root handle already opened", async () => {
    const failure = new Error("marker inaccessible"); fs.lstat.mockRejectedValueOnce(failure);
    await expect(new NodeDurableObjectStore({ root }).assertReady()).rejects.toMatchObject({ cause: failure });
    expect(fs.open).not.toHaveBeenCalled();
    fs.readFile.mockRejectedValueOnce(failure);
    await expect(new NodeDurableObjectStore({ root }).assertReady()).rejects.toMatchObject({ cause: failure });
    expect(rootHandle.close).toHaveBeenCalledOnce(); expect(markerHandle.close).toHaveBeenCalledOnce();
  });
  it("closes verification handles on a successful readiness check", async () => {
    await expect(new NodeDurableObjectStore({ root }).assertReady()).resolves.toBeUndefined();
    expect(rootHandle.close).toHaveBeenCalledOnce(); expect(markerHandle.close).toHaveBeenCalledOnce(); expect(fs.mkdir).not.toHaveBeenCalled();
  });
  it("wraps owner creation errors while releasing the pinned root", async () => {
    const failure = Object.assign(new Error("denied"), { code: "EACCES" }); fs.mkdir.mockRejectedValue(failure);
    await expect(create()).rejects.toMatchObject({ cause: failure }); expect(rootHandle.close).toHaveBeenCalledOnce(); expect(fs.link).not.toHaveBeenCalled();
  });
  it.each(["canonical owner changed", "owner symlink", "owner identity changed", "missing owner id", "missing owner group"])("refuses %s and closes the owner", async (failure) => {
    if (failure === "canonical owner changed") fs.realpath.mockImplementation(async (name) => name === root ? root : path.join(root, "other"));
    if (failure === "owner symlink") fs.lstat.mockImplementation(async (name) => name === root ? rootStat() : name === markerPath ? markerStat() : { ...ownerStat(), isSymbolicLink: () => true });
    if (failure === "owner identity changed") ownerHandle.stat.mockResolvedValue({ ...ownerStat(), ino: 99 });
    if (failure === "missing owner id") Object.defineProperty(process, "getuid", { configurable: true, value: undefined });
    if (failure === "missing owner group") gid.mockReturnValueOnce(1000).mockReturnValueOnce(undefined as unknown as number);
    await expect(create()).rejects.toBeInstanceOf(DurableObjectStoreSafetyError);
    expect(ownerHandle.close).toHaveBeenCalledOnce(); expect(rootHandle.close).toHaveBeenCalledOnce(); expect(fileHandle.write).not.toHaveBeenCalled();
  });
  it("rejects platform and relative-root assumptions without filesystem access", async () => {
    Object.defineProperty(process, "platform", { configurable: true, value: "win32" });
    await expect(new NodeDurableObjectStore({ root }).assertReady()).rejects.toThrow("requires Linux");
    Object.defineProperty(process, "platform", { configurable: true, value: "linux" });
    await expect(new NodeDurableObjectStore({ root: "relative" }).assertReady()).rejects.toBeInstanceOf(DurableObjectStoreSafetyError);
    expect(fs.realpath).not.toHaveBeenCalled();
  });
});
