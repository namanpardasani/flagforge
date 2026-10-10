export interface SseMessage {
  event?: string;
  data?: string;
  id?: string;
}

/**
 * Incremental Server-Sent Events parser. Network chunks can split an event anywhere (even in the
 * middle of a line or of a UTF-8 character), so we buffer and only emit complete blocks, which
 * end with a blank line. Comment lines (":ping", our heartbeats) produce no message.
 */
export class SseParser {
  #buffer = "";
  readonly #decoder = new TextDecoder();

  /** Feed raw bytes; returns every complete message found so far. */
  push(chunk: Uint8Array): SseMessage[] {
    this.#buffer += this.#decoder.decode(chunk, { stream: true }).replace(/\r\n?/g, "\n");
    const messages: SseMessage[] = [];
    let end: number;
    while ((end = this.#buffer.indexOf("\n\n")) !== -1) {
      const block = this.#buffer.slice(0, end);
      this.#buffer = this.#buffer.slice(end + 2);
      const message = parseBlock(block);
      if (message) messages.push(message);
    }
    return messages;
  }
}

function parseBlock(block: string): SseMessage | null {
  const message: SseMessage = {};
  let any = false;
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) continue; // comment / heartbeat
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") message.event = value;
    else if (field === "id") message.id = value;
    else if (field === "data") message.data = message.data === undefined ? value : `${message.data}\n${value}`;
    else continue; // retry: and unknown fields are ignored
    any = true;
  }
  return any ? message : null;
}
