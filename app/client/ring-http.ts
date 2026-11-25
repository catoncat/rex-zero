// Ring-channel HTTP transport bridging the Solid UI realm with the worker HTTP realm (`http://zero/*`).

import { onFrame } from "@pocketjs/framework/lifecycle";
import { worker } from "@pocketjs/framework/worker/channels";
import { Answer, HEADER_BYTES, encodeCall, text, type WireCall } from "../wire.ts";

export const MAX_IN_FLIGHT = 6;
export const WAIT_TIMEOUT_MS = 12_000;
export const WAIT_HTTP_TIMEOUT_MS = 16_000;
export const BACKOFF_S = 0.3;
export const BASE_URL = "http://zero";

export type RawHttpTransport = <T>(
  path: string,
  method?: "GET" | "POST",
  body?: unknown,
  timeoutMs?: number,
  maxBytes?: number,
) => Promise<T>;

interface PendingCall {
  status: number;
  body: Uint8Array[];
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

interface QueuedRequest {
  id: number;
  record: Uint8Array;
  pending: PendingCall;
}

export function createRingHttp(): RawHttpTransport {
  const reqChan = worker.channel("request");
  const resChan = worker.channel("response");

  const inFlight = new Map<number, PendingCall>();
  const queue: QueuedRequest[] = [];
  let nextId = 1;
  let frameInstalled = false;

  const pump = () => {
    while (inFlight.size < MAX_IN_FLIGHT && queue.length > 0) {
      const head = queue[0]!;
      if (!reqChan.publish(head.record)) break;
      queue.shift();
      inFlight.set(head.id, head.pending);
    }
  };

  const settle = (id: number, failure: string) => {
    const call = inFlight.get(id);
    if (!call) return;
    inFlight.delete(id);
    pump();

    if (failure) {
      call.reject(new Error(failure));
      return;
    }

    let total = 0;
    for (const chunk of call.body) total += chunk.length;
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of call.body) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    const raw = text(merged);
    let parsed: unknown = {};
    if (raw.length > 0) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        if (call.status >= 200 && call.status < 300) {
          call.reject(new Error("Invalid JSON from host"));
          return;
        }
      }
    }

    if (call.status < 200 || call.status >= 300) {
      const msg =
        parsed &&
        typeof parsed === "object" &&
        "error" in parsed &&
        typeof (parsed as { error?: unknown }).error === "string"
          ? (parsed as { error: string }).error
          : raw || `HTTP ${call.status}`;
      call.reject(new Error(msg));
      return;
    }

    call.resolve(parsed);
  };

  const ensureFrame = () => {
    if (frameInstalled) return;
    frameInstalled = true;
    onFrame(() => {
      pump();
      for (const record of resChan.observe()) {
        const id = record.u32(0);
        const call = inFlight.get(id);
        if (!call) continue;
        const kind = record.u8(4);
        if (kind === Answer.head) {
          call.status = record.u16le(HEADER_BYTES);
        } else if (kind === Answer.body) {
          call.body.push(record.copy().subarray(HEADER_BYTES));
        } else if (kind === Answer.end) {
          const reason = text(record.copy().subarray(HEADER_BYTES));
          settle(id, reason);
        }
      }
    });
  };

  return function request<T>(
    path: string,
    method: "GET" | "POST" = "GET",
    body?: unknown,
    timeoutMs = 8_000,
    maxBytes = 256 * 1024,
  ): Promise<T> {
    ensureFrame();
    return new Promise<T>((resolve, reject) => {
      const id = nextId++;
      const call: WireCall = {
        url: `${BASE_URL}${path}`,
        method,
        headers: body === undefined ? {} : { "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
        timeoutMs,
        maxBytes,
      };
      let record: Uint8Array;
      try {
        record = encodeCall(id, call);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      queue.push({
        id,
        record,
        pending: {
          status: 0,
          body: [],
          resolve: resolve as (v: unknown) => void,
          reject,
        },
      });
      pump();
    });
  };
}
