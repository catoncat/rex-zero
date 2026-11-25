// Shared 1024-byte ring-channel wire framing between Solid UI and Worker realm.
export const RECORD_BYTES = 1024;
export const HEADER_BYTES = 5;
export const Answer = { head: 1, body: 2, end: 3 } as const;

export interface WireCall {
  url: string;
  method: string;
  headers?: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
}

export function encodeCall(id: number, call: WireCall): Uint8Array {
  const json = utf8(JSON.stringify(call));
  if (json.length > RECORD_BYTES - 4) {
    throw new RangeError("Request descriptor exceeds 1020 bytes");
  }
  const record = new Uint8Array(4 + json.length);
  new DataView(record.buffer).setUint32(0, id, true);
  record.set(json, 4);
  return record;
}

export function decodeCall(record: Uint8Array): { id: number; call: WireCall } {
  const id = new DataView(record.buffer, record.byteOffset, record.byteLength).getUint32(0, true);
  return { id, call: JSON.parse(text(record.subarray(4))) as WireCall };
}

export function answer(id: number, kind: number, payload: Uint8Array): Uint8Array {
  const record = new Uint8Array(HEADER_BYTES + payload.length);
  const view = new DataView(record.buffer);
  view.setUint32(0, id, true);
  view.setUint8(4, kind);
  record.set(payload, HEADER_BYTES);
  return record;
}

export function utf8(value: string): Uint8Array {
  const out: number[] = [];
  for (const char of value) {
    let cp = char.codePointAt(0)!;
    if (cp >= 0xd800 && cp <= 0xdfff) cp = 0xfffd;
    if (cp < 0x80) out.push(cp);
    else if (cp < 0x800) out.push(0xc0 | (cp >> 6), 0x80 | (cp & 63));
    else if (cp < 0x10000) out.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
    else out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 63), 0x80 | ((cp >> 6) & 63), 0x80 | (cp & 63));
  }
  return Uint8Array.from(out);
}

export function text(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; ) {
    const lead = bytes[i]!;
    const length = lead < 0x80 ? 1 : lead >= 0xf0 && lead < 0xf5 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc2 ? 2 : 0;
    let cp = length === 1 ? lead : length === 2 ? lead & 0x1f : length === 3 ? lead & 0x0f : lead & 0x07;
    let ok = length > 0 && i + length <= bytes.length;
    for (let k = 1; ok && k < length; k++) {
      const next = bytes[i + k]!;
      if ((next & 0xc0) !== 0x80) ok = false;
      else cp = (cp << 6) | (next & 63);
    }
    if (ok && length === 3 && (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff))) ok = false;
    if (ok && length === 4 && (cp < 0x10000 || cp > 0x10ffff)) ok = false;
    out += ok ? String.fromCodePoint(cp) : "\ufffd";
    i += ok ? length : 1;
  }
  return out;
}
