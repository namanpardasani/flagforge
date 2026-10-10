import { describe, expect, it } from "vitest";
import { SseParser } from "../src/index.js";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("SseParser", () => {
  it("parses an event with event, id and data", () => {
    const p = new SseParser();
    expect(p.push(bytes('event: change\nid: 7\ndata: {"version":7}\n\n'))).toEqual([
      { event: "change", id: "7", data: '{"version":7}' },
    ]);
  });

  it("parses several events delivered in one chunk", () => {
    const p = new SseParser();
    const out = p.push(bytes("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n"));
    expect(out.map((m) => [m.event, m.data])).toEqual([["a", "1"], ["b", "2"]]);
  });

  it("waits for the blank line: an incomplete event produces nothing yet", () => {
    const p = new SseParser();
    expect(p.push(bytes("event: change\ndata: {}"))).toEqual([]);
    expect(p.push(bytes("\n"))).toEqual([]);
    expect(p.push(bytes("\n"))).toEqual([{ event: "change", data: "{}" }]);
  });

  it("is correct when the stream is cut into single bytes (split anywhere, even inside a character)", () => {
    const text = 'event: change\ndata: {"name":"héllo 😀 ü"}\n\nevent: hello\ndata: 2\n\n';
    const p = new SseParser();
    const out = [...bytes(text)].flatMap((b) => p.push(new Uint8Array([b])));
    expect(out).toEqual([
      { event: "change", data: '{"name":"héllo 😀 ü"}' },
      { event: "hello", data: "2" },
    ]);
  });

  it("handles CRLF and lone CR line endings", () => {
    const p = new SseParser();
    expect(p.push(bytes("event: a\r\ndata: 1\r\n\r\n"))).toEqual([{ event: "a", data: "1" }]);
    expect(p.push(bytes("event: b\rdata: 2\r\r"))).toEqual([{ event: "b", data: "2" }]);
  });

  it("ignores comments (heartbeats) and does not emit empty messages", () => {
    const p = new SseParser();
    expect(p.push(bytes(": ping\n\n"))).toEqual([]);
    expect(p.push(bytes(": ping\n\n: another\n\n"))).toEqual([]);
    expect(p.push(bytes("retry: 3000\n\n"))).toEqual([]);
    expect(p.push(bytes(": ping\nevent: x\ndata: 1\n\n"))).toEqual([{ event: "x", data: "1" }]);
  });

  it("joins multi-line data with newlines and strips one leading space only", () => {
    const p = new SseParser();
    expect(p.push(bytes("data: line1\ndata:  line2\ndata:line3\n\n"))).toEqual([{ data: "line1\n line2\nline3" }]);
  });

  it("ignores unknown fields and handles a field with no colon", () => {
    const p = new SseParser();
    expect(p.push(bytes("foo: bar\nevent: e\ndata\n\n"))).toEqual([{ event: "e", data: "" }]);
  });
});
