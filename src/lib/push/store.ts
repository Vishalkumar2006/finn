import { BlobNotFoundError, BlobPreconditionFailedError, get, head, put } from "@vercel/blob";
import type { Change, PushDoc } from "./subscription";

/** Separate from monitoring state: its own private path, never read by the monitor and never served publicly. */
const PATH = "push/subscriptions.json";

export interface PushStore {
  read(): Promise<{ doc: PushDoc; etag: string } | null>;
  /** etag null means create; false means someone else wrote first. */
  write(doc: PushDoc, etag: string | null): Promise<boolean>;
}

export class StoreBusy extends Error {}

/**
 * Read, edit, conditionally write; on a conflict, start again from the newer copy. Simultaneous subscribe and
 * unsubscribe calls therefore never lose each other's change.
 */
export async function mutate<T extends Change>(store: PushStore, edit: (doc: PushDoc | null) => T, attempts = 6): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    const cur = await store.read();
    const out = edit(cur?.doc ?? null);
    if (!out.changed) return out;
    if (await store.write(out.doc, cur?.etag ?? null)) return out;
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 120 * (i + 1)));
  }
  throw new StoreBusy("Subscription store busy");
}

export const blobPushStore: PushStore = {
  async read() {
    try {
      const etag = (await head(PATH)).etag;
      const r = await get(PATH, { access: "private", useCache: false });
      if (!r || r.statusCode !== 200) return null;
      return { doc: (await new Response(r.stream).json()) as PushDoc, etag };
    } catch (e) {
      if (e instanceof BlobNotFoundError) return null;
      throw e;
    }
  },
  async write(doc, etag) {
    try {
      await put(PATH, JSON.stringify(doc), {
        access: "private", addRandomSuffix: false, contentType: "application/json", cacheControlMaxAge: 60,
        ...(etag ? { allowOverwrite: true, ifMatch: etag } : { allowOverwrite: false }),
      });
      return true;
    } catch (e) {
      if (e instanceof BlobPreconditionFailedError) return false;
      // A create that lost the race finds the blob already there: treat as a conflict and re-read.
      if (!etag && e instanceof Error && /already exists/i.test(e.message)) return false;
      throw e;
    }
  },
};
