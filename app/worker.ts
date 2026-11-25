// Worker realm bridge: forwards UI ring-channel HTTP descriptors to the Rust
// host's in-process `http` node (`http://zero/rex/*`, `http://zero/dev/*`,
// `http://zero/quit`) and streams chunked responses back over the ring.
import { io, type HttpRequest } from "@pocketjs/framework/io";
import { FactKind, ResourceStatus, type Inbox, type TurnContext } from "@pocketjs/framework/worker";
import { Answer, HEADER_BYTES, RECORD_BYTES, answer, decodeCall, text, utf8 } from "./wire.ts";

const RETRY_TIMER = 1;
const RETRY_MICROS = 10_000;
const BODY_BYTES = RECORD_BYTES - HEADER_BYTES;

const ENDED: Record<number, string> = {
  [ResourceStatus.failed]: "Host request failed.",
  [ResourceStatus.unknown]: "Request interrupted without response.",
  [ResourceStatus.busy]: "Worker resource pool busy.",
  [ResourceStatus.invalid]: "Invalid host request.",
};

const responses = io.channel("response");
const calls = new Map<number, { resource: HttpRequest; request: number; endStatus: number | null }>();
const unsent: Uint8Array[] = [];

function end(id: number, status: number): void {
  const reason = status === ResourceStatus.ok ? "" : (ENDED[status] ?? `Ended (${status})`);
  unsent.push(answer(id, Answer.end, utf8(reason)));
}

function start(record: Uint8Array): void {
  const { id, call } = decodeCall(record);
  let resource: HttpRequest | null = null;
  try {
    resource = io.http("http").open(call);
    const request = resource.submit();
    if (request < 0) {
      resource.close();
      end(id, ResourceStatus.busy);
    } else {
      calls.set(id, { resource, request, endStatus: null });
    }
  } catch {
    resource?.close();
    end(id, ResourceStatus.invalid);
  }
}

function forward(
  id: number,
  call: { resource: HttpRequest; request: number; endStatus: number | null },
  inbox: Inbox,
): void {
  for (const fact of call.resource.observe(inbox)) {
    if (fact.kind === FactKind.headers) {
      const status = (JSON.parse(text(fact.data.copy())) as { status: number }).status;
      const payload = new Uint8Array(2);
      new DataView(payload.buffer).setUint16(0, status, true);
      unsent.push(answer(id, Answer.head, payload));
    } else if (fact.kind === FactKind.data) {
      const bytes = fact.data.copy();
      for (let at = 0; at < bytes.length; at += BODY_BYTES) {
        unsent.push(answer(id, Answer.body, bytes.subarray(at, at + BODY_BYTES)));
      }
    } else if (fact.kind === FactKind.end) {
      call.endStatus = fact.status;
    }
  }
  const completion = inbox.completion(call.request);
  if (!completion) return;
  call.resource.close();
  calls.delete(id);
  end(id, call.endStatus ?? completion.status);
}

export function turn(context: TurnContext, inbox: Inbox): void {
  for (const [id, call] of calls) forward(id, call, inbox);
  for (const record of inbox.channel("request")) start(record.data.copy());
  while (unsent.length && responses.publish(unsent[0]!)) unsent.shift();
  if (unsent.length) io.timer(RETRY_TIMER, context.nowMicros + RETRY_MICROS);
}
