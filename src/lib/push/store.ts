import { BlobNotFoundError, BlobPreconditionFailedError, get, head, put } from "@vercel/blob";
import type { DeliveryDoc } from "./digest";
import type { PushDoc } from "./subscription";

/** One small private JSON document. Each has its own path; monitoring never reads either. */
export interface DocStore<D> {
  read(): Promise<{ doc: D; etag: string } | null>;
  /** etag null means create; false means someone else wrote first. */
  write(doc: D, etag: string | null): Promise<boolean>;
}

export type PushStore = DocStore<PushDoc>;

export class StoreBusy extends Error {}

/**
 * Read, edit, conditionally write; on a conflict, start again from the newer copy. Simultaneous writers therefore
 * never lose each other's change.
 */
export async function mutate<D, T extends { doc: D; changed: boolean }>(store: DocStore<D>, edit: (doc: D | null) => T, attempts = 6): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    const cur = await store.read();
    const out = edit(cur?.doc ?? null);
    if (!out.changed) return out;
    if (await store.write(out.doc, cur?.etag ?? null)) return out;
    await new Promise((r) => setTimeout(r, 40 + Math.random() * 120 * (i + 1)));
  }
  throw new StoreBusy("Store busy");
}

function blobDoc<D>(path: string): DocStore<D> {
  return {
    async read() {
      try {
        const etag = (await head(path)).etag;
        const r = await get(path, { access: "private", useCache: false });
        if (!r || r.statusCode !== 200) return null;
        return { doc: (await new Response(r.stream).json()) as D, etag };
      } catch (e) {
        if (e instanceof BlobNotFoundError) return null;
        throw e;
      }
    },
    async write(doc, etag) {
      try {
        await put(path, JSON.stringify(doc), {
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
}

/** Device subscriptions and their consent. */
export const blobPushStore = blobDoc<PushDoc>("push/subscriptions.json");
/** Which digest went to which device, kept apart from both subscriptions and monitoring state. */
export const blobDeliveryStore = blobDoc<DeliveryDoc>("push/deliveries.json");
