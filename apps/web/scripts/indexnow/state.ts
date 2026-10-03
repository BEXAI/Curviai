import { randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, rename, unlink, type FileHandle } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseState, type IndexNowState } from "./model";

const MAX_STATE_BYTES = 5 * 1024 * 1024;
const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const NONBLOCK = constants.O_NONBLOCK ?? 0;
const POSIX = process.platform !== "win32";

type StateStore = {
  read(): Promise<IndexNowState | null>;
  save(state: IndexNowState): Promise<void>;
};

function refusal(message: string): Error {
  // Never attach native filesystem errors: they can contain private paths.
  return new Error(`IndexNow state: ${message}`);
}

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function io<T>(operation: () => Promise<T>, message: string): Promise<T> {
  try { return await operation(); } catch { throw refusal(message); }
}

function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

function privateOwner(stat: Stats): boolean {
  return !POSIX || (typeof process.getuid === "function" && stat.uid === process.getuid());
}

function checkDirectory(stat: Stats): void {
  if (!stat.isDirectory() || stat.isSymbolicLink() || !privateOwner(stat)
    || (POSIX && (stat.mode & 0o077) !== 0)) {
    throw refusal("use a private directory owned by the current user, without symlinks or group/world permissions.");
  }
}

function checkFile(stat: Stats): void {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || !privateOwner(stat)
    || (POSIX && (stat.mode & 0o777) !== 0o600)) {
    throw refusal("files must be regular, have one link, be owned by the current user and mode 0600.");
  }
}

async function optionalStat(path: string): Promise<Stats | null> {
  try { return await lstat(path); } catch (error) {
    if (hasCode(error, "ENOENT")) return null;
    throw refusal("could not inspect a file; preserve the directory and review before retrying.");
  }
}

async function close(handle: FileHandle): Promise<void> {
  await io(() => handle.close(), "could not close a file safely; stop and review before retrying.");
}

/** The lock is deliberately never stolen, even when its recorded PID is absent. */
export async function withStateDirectory<T>(directory: string, callback: (store: StateStore) => Promise<T>): Promise<T> {
  if (!isAbsolute(directory)) throw refusal("the directory must be absolute.");
  const path = resolve(directory);
  try { await mkdir(path, { mode: 0o700, recursive: false }); } catch (error) {
    if (!hasCode(error, "EEXIST")) throw refusal("could not create the dedicated directory; its parent must already exist.");
  }
  const initialDirectory = await io(() => lstat(path), "could not inspect the dedicated directory.");
  checkDirectory(initialDirectory);
  const directoryHandle = await io(
    () => open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0) | NO_FOLLOW),
    "could not open the private directory safely.",
  );
  let lockHandle: FileHandle | undefined;
  let lockIdentity: Stats | undefined;
  const lockPath = join(path, ".lock");
  const statePath = join(path, "state.json");
  let active = true;
  let pending = Promise.resolve();
  let failure: unknown;

  async function checkIdentity(): Promise<void> {
    const current = await io(() => lstat(path), "the directory changed during this run; stop and review.");
    checkDirectory(current);
    if (!sameFile(initialDirectory, current)) throw refusal("the directory changed during this run; stop and review.");
    if (lockIdentity) {
      const lock = await optionalStat(lockPath);
      if (!lock || !sameFile(lockIdentity, lock)) throw refusal("the lock changed during this run; stop and review.");
      checkFile(lock);
    }
  }

  async function readState(): Promise<{ state: IndexNowState | null; stat: Stats | null }> {
    await checkIdentity();
    const stat = await optionalStat(statePath);
    if (!stat) return { state: null, stat: null };
    checkFile(stat);
    if (stat.size > MAX_STATE_BYTES) throw refusal("the file exceeds the 5 MiB limit; preserve it and review.");
    const handle = await io(() => open(statePath, constants.O_RDONLY | NO_FOLLOW | NONBLOCK), "could not open the state file safely.");
    try {
      const opened = await io(() => handle.stat(), "could not inspect the open state file.");
      checkFile(opened);
      if (!sameFile(stat, opened)) throw refusal("the state file changed while opening; stop and review.");
      const bytes = Buffer.alloc(MAX_STATE_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await io(() => handle.read(bytes, length, bytes.length - length, length), "could not read the state file.");
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
      }
      if (length > MAX_STATE_BYTES) throw refusal("the file exceeds the 5 MiB limit; preserve it and review.");
      const finished = await io(() => handle.stat(), "could not verify the state file after reading.");
      const current = await optionalStat(statePath);
      if (!current || !sameFile(stat, current) || !sameFile(opened, finished)
        || stat.size !== length || finished.size !== length || stat.mtimeMs !== finished.mtimeMs
        || stat.ctimeMs !== finished.ctimeMs) {
        throw refusal("the state file changed while reading; stop and review.");
      }
      checkFile(current);
      let value: unknown;
      try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length))); }
      catch { throw refusal("the file is corrupt or truncated; preserve it and review before retrying."); }
      return { state: parseState(value), stat: finished };
    } finally { await close(handle); }
  }

  async function saveState(state: IndexNowState): Promise<void> {
    const data = `${JSON.stringify(parseState(state), null, 2)}\n`;
    if (Buffer.byteLength(data) > MAX_STATE_BYTES) throw refusal("the proposed file exceeds the 5 MiB limit.");
    // Validate an existing file even if the caller omitted read(). Never silently
    // replace corrupt history, a symlink, or a file with insecure permissions.
    const previous = await readState();
    const temporaryPath = join(path, `.state-${randomUUID()}.tmp`);
    const temporary = await io(
      () => open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o600),
      "could not create a private temporary file.",
    );
    let temporaryIdentity: Stats | undefined;
    let renamed = false;
    let closed = false;
    try {
      temporaryIdentity = await io(() => temporary.stat(), "could not inspect the temporary file.");
      checkFile(temporaryIdentity);
      await io(() => temporary.writeFile(data, "utf8"), "could not write the temporary file; existing state was preserved.");
      await io(() => temporary.sync(), "could not flush the temporary file; existing state was preserved.");
      await close(temporary);
      closed = true;
      await checkIdentity();
      const current = await optionalStat(statePath);
      if (current) checkFile(current);
      if ((previous.stat === null) !== (current === null)
        || (previous.stat && current && (!sameFile(previous.stat, current)
          || previous.stat.mtimeMs !== current.mtimeMs || previous.stat.ctimeMs !== current.ctimeMs))) {
        throw refusal("the state file changed before replacement; stop and review.");
      }
      const temporaryCurrent = await optionalStat(temporaryPath);
      if (!temporaryCurrent || !sameFile(temporaryIdentity, temporaryCurrent)) throw refusal("the temporary file changed; stop and review.");
      checkFile(temporaryCurrent);
      await io(() => rename(temporaryPath, statePath), "could not replace the state file atomically; stop and review.");
      renamed = true;
      await io(() => directoryHandle.sync(), "durability could not be confirmed; stop and review before retrying.");
    } finally {
      try { if (!closed) await close(temporary); } finally {
        if (!renamed && temporaryIdentity) {
          const current = await optionalStat(temporaryPath);
          if (current && sameFile(temporaryIdentity, current) && !current.isSymbolicLink()) {
            await io(() => unlink(temporaryPath), "could not remove this run's temporary file; stop and review.");
          }
        }
      }
    }
  }

  function enqueue<R>(operation: () => Promise<R>): Promise<R> {
    if (!active) return Promise.reject(refusal("the store is closed."));
    const result = pending.then(() => {
      if (failure) throw failure;
      return operation();
    });
    pending = result.then(() => {}, (error: unknown) => { failure = error; });
    return result;
  }

  try {
    const openedDirectory = await io(() => directoryHandle.stat(), "could not verify the open directory.");
    checkDirectory(openedDirectory);
    if (!sameFile(initialDirectory, openedDirectory)) throw refusal("the directory changed while opening; stop and review.");
    await checkIdentity();
    try { lockHandle = await open(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW, 0o600); }
    catch (error) {
      if (hasCode(error, "EEXIST")) throw refusal("the directory is locked. Do not remove the lock until the previous run and any uncertain submission are reviewed.");
      throw refusal("could not acquire the exclusive lock.");
    }
    lockIdentity = await io(() => lockHandle!.stat(), "could not inspect the exclusive lock.");
    checkFile(lockIdentity);
    await io(() => lockHandle!.writeFile(`${process.pid}\n`, "utf8"), "could not record the exclusive lock.");
    await io(() => lockHandle!.sync(), "could not flush the exclusive lock.");
    await io(() => directoryHandle.sync(), "could not persist the exclusive lock.");
    // The leaf directory itself may have been created in this run, or by a
    // previous run that failed before flushing its parent's directory entry.
    // Ancestor aliases such as macOS /tmp are allowed; the private leaf is not.
    const parent = await io(
      () => open(dirname(path), constants.O_RDONLY | (constants.O_DIRECTORY ?? 0)),
      "could not open the parent directory for durability verification.",
    );
    try {
      const parentStat = await io(() => parent.stat(), "could not inspect the parent directory.");
      if (!parentStat.isDirectory()) throw refusal("the parent must be a directory.");
      await io(() => parent.sync(), "could not persist the private directory in its parent; stop and review.");
    } finally { await close(parent); }
    await checkIdentity();
    const result = await callback({ read: () => enqueue(async () => (await readState()).state), save: (state) => enqueue(() => saveState(state)) });
    await pending;
    if (failure) throw failure;
    return result;
  } finally {
    active = false;
    await pending;
    try {
      if (lockIdentity) {
        await checkIdentity();
        await io(() => unlink(lockPath), "could not release this run's lock; review it before retrying.");
        await io(() => directoryHandle.sync(), "could not persist lock release; review it before retrying.");
      }
    } finally {
      try { if (lockHandle) await close(lockHandle); } finally { await close(directoryHandle); }
    }
  }
}
