// Pull-based line reader for JSONL captures.
//
// Why not readline.createInterface: its async iterator provides NO
// backpressure once the consumer awaits. readline is push-based — the
// underlying stream keeps emitting 'line' events while the consumer is parked
// on an await, and the iterator queues them unboundedly. Measured on a live
// 1.5 GB capture (2026-07-29): a consumer that awaited ~40 ms per line held
// 1.2 GB after 25 lines and the ENTIRE remaining file (~2.3 GB as decoded
// strings) by line 75. That is how "stream the capture" (3bcf8ac) still
// peaked at 3.27 GB — the read no longer slurped, the iterator queue did.
// The defect is invisible to a consumer that blocks synchronously (the event
// loop never turns, so the stream cannot run ahead), which is exactly how the
// first probe missed it.
//
// A raw stream's async iterator is pull-based: nothing is read until next()
// is called, so between yields the file position stands still. Buffering here
// is bounded by highWaterMark + the longest single line, whatever the
// consumer does between iterations. The test pins the mechanism: after
// consuming a line with awaits in between, the stream's bytesRead may not
// have run ahead of the consumed bytes by more than that bound.
//
// Encoding is set on the stream so Node's own StringDecoder handles UTF-8
// sequences split across chunk boundaries.

import { createReadStream } from "node:fs";

export const READ_CHUNK_SIZE = 1 << 20; // 1 MiB; capture lines reach several MB

/**
 * Yield lines from a file (or a provided Readable in "utf8" encoding — the
 * injection point the backpressure test uses to watch bytesRead).
 * A trailing "\r" is stripped so CRLF input behaves like readline's
 * crlfDelay: Infinity. A final unterminated line is yielded; a trailing
 * newline yields no empty final line.
 */
export async function* readLines(pathOrStream) {
  const stream =
    typeof pathOrStream === "string"
      ? createReadStream(pathOrStream, { encoding: "utf8", highWaterMark: READ_CHUNK_SIZE })
      : pathOrStream;
  let buf = "";
  for await (const chunk of stream) {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) !== -1) {
      let line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      yield line;
    }
  }
  if (buf.length > 0) yield buf.endsWith("\r") ? buf.slice(0, -1) : buf;
}
