import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { installOutputStreamGuards } from "../src/main/outputStreams.ts";

function fakeStream() {
  return new EventEmitter();
}

test("stdout 的管道关闭时不崩溃", () => {
  const stream = fakeStream();
  installOutputStreamGuards([stream]);

  const error = Object.assign(new Error("broken pipe"), { code: "EPIPE" });

  assert.doesNotThrow(() => stream.emit("error", error));
});

test("别的流错误照常抛，不被守卫吞掉", () => {
  const stream = fakeStream();
  installOutputStreamGuards([stream]);

  const error = new Error("permission denied");

  assert.throws(() => stream.emit("error", error), error);
});
