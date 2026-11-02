import { BlobNotFoundError, BlobPreconditionFailedError, get, head, put } from "@vercel/blob";
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
      // A delivered copy's ETag doesn't match for ifMatch, so the version comes from metadata. It is read first: if the
      // blob changes in between, the write is refused and retried, never applied over newer data.
      const version = fresh ? (await head(PATH)).etag : "";
      const r = await get(PATH, { access: "private", useCache: !fresh });
      if (!r || r.statusCode !== 200) return null;
      return { state: (await new Response(r.stream).json()) as MonitorState, etag: version };
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
