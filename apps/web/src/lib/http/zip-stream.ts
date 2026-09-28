/**
 * Streams a zip of stored files one entry at a time (the "all files" pack
 * download, Update.md 6.5). Each file is opened as a stream only once the
 * previous entry has been written to the response, so memory holds one
 * file's chunks at a time, not the whole pack, and a slow download holds one
 * storage read open, not all of them. The response's backpressure reaches
 * the archive, so nothing is read faster than the client takes it.
 */

import { PassThrough, Readable } from "node:stream";
import archiver from "archiver";

type Archiver = archiver.Archiver;

export interface ZipStreamEntry {
  /** Name inside the zip. */
  name: string;
  /** What the opener fetches (a storage key). */
  source: string;
}

/** Opens one entry's bytes as a stream; null when the object is gone. */
export type OpenEntryStream = (source: string) => Promise<Readable | null>;

export class ZipEntryMissingError extends Error {
  constructor(source: string) {
    super(`zip entry ${source} disappeared while zipping`);
    this.name = "ZipEntryMissingError";
  }
}

class ZipStreamClosedError extends Error {
  constructor() {
    super("the download was closed before the zip finished");
    this.name = "ZipStreamClosedError";
  }
}

/** Resolves once the archive has written the entry just appended; rejects
 * on an archive or source error, or when the download closes first. */
function entryWritten(archive: Archiver, source: Readable, closed: Promise<never>): Promise<void> {
  let cleanup = () => {};
  const done = new Promise<void>((resolve, reject) => {
    const onEntry = () => resolve();
    const onError = (err: unknown) => reject(err instanceof Error ? err : new Error(String(err)));
    archive.once("entry", onEntry);
    archive.once("error", onError);
    source.once("error", onError);
    cleanup = () => {
      archive.off("entry", onEntry);
      archive.off("error", onError);
      source.off("error", onError);
    };
  });
  return Promise.race([done, closed]).finally(cleanup);
}

/**
 * Appends every entry in order, waiting for each to be written before the
 * next is opened, then finalizes. Exported for tests; zipStream wires it to
 * a response body.
 */
export async function appendEntriesInOrder(
  archive: Archiver,
  entries: readonly ZipStreamEntry[],
  open: OpenEntryStream,
  closed: Promise<never> = new Promise<never>(() => {}),
): Promise<void> {
  for (const entry of entries) {
    const source = await Promise.race([open(entry.source), closed]);
    if (!source) {
      throw new ZipEntryMissingError(entry.source);
    }
    const written = entryWritten(archive, source, closed);
    archive.append(source, { name: entry.name });
    try {
      await written;
    } catch (err) {
      source.destroy();
      throw err;
    }
  }
  await archive.finalize();
}

/**
 * A web ReadableStream of the zip. A failure part way (an object vanished,
 * storage errored) ends the download with an error rather than handing over
 * a zip silently short a file; onError hears about it for the logs.
 */
export function zipStream(
  entries: readonly ZipStreamEntry[],
  open: OpenEntryStream,
  onError: (err: Error) => void,
): ReadableStream {
  const archive = archiver("zip", { zlib: { level: 6 } });
  const out = new PassThrough();
  archive.on("error", (err) => out.destroy(err));
  archive.pipe(out);

  // The client went away: stop waiting for entries that will never drain.
  let rejectClosed: (err: Error) => void = () => {};
  const closed = new Promise<never>((_, reject) => {
    rejectClosed = reject;
  });
  closed.catch(() => undefined);
  out.once("close", () => rejectClosed(new ZipStreamClosedError()));

  appendEntriesInOrder(archive, entries, open, closed).catch((err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err));
    archive.abort();
    if (!(error instanceof ZipStreamClosedError)) {
      onError(error);
    }
    out.destroy(error);
  });

  return Readable.toWeb(out) as ReadableStream;
}
