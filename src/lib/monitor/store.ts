import { BlobNotFoundError, BlobPreconditionFailedError, get, put } from "@vercel/blob";
import type { MonitorState } from "../domain/monitor";
import type { MonitorStore } from "./run";

const PATH = "monitor/state.json";

/**
 * One small JSON document in a private Blob store: run records, event summaries and links, never filing text.
 * Writes are conditional on the version read. Public reads may lag a write by up to 60 seconds.
 */
export const blobStore: MonitorStore = {
  async read(fresh) {
    try {
      const r = await get(PATH, { access: "private", useCache: !fresh });
      if (!r || r.statusCode !== 200) return null;
      return { state: (await new Response(r.stream).json()) as MonitorState, etag: r.blob.etag };
    } catch (e) {
      if (e instanceof BlobNotFoundError) return null;
      throw e;
    }
  },
  async write(state, etag) {
    try {
      await put(PATH, JSON.stringify(state), {
        access: "private", allowOverwrite: true, addRandomSuffix: false, contentType: "application/json", cacheControlMaxAge: 60,
        ...(etag ? { ifMatch: etag } : {}),
      });
      return true;
    } catch (e) {
      if (e instanceof BlobPreconditionFailedError) return false;
      throw e;
    }
  },
};
