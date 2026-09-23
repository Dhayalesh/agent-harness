import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { LayaBackend } from "../src/services/decisions/laya.js";

class FakeWorker extends EventEmitter {
  terminated = false;
  ref() {}
  unref() {}
  postMessage() {}
  async terminate() {
    this.terminated = true;
    this.emit("exit", 1);
  }
}
const settings = { timeoutMs: 1000, threads: 2, modelDir: "/fixture" };

test("reuses a resident worker, rejects concurrency and cleans request listeners", async () => {
  let creations = 0;
  const worker = new FakeWorker();
  const backend = new LayaBackend({
    createWorker: () => {
      creations++;
      return worker;
    },
  });
  const first = backend.score({}, settings);
  await assert.rejects(backend.score({}, settings), /CAPACITY/);
  worker.emit("message", { scores: [{ id: "a", score: 0.9 }] });
  assert.deepEqual(await first, [{ id: "a", score: 0.9 }]);
  const next = backend.score({}, settings);
  worker.emit("message", { scores: [] });
  await next;
  assert.equal(creations, 1);
  assert.equal(worker.listenerCount("message"), 0);
  await backend.close();
  assert.equal(worker.terminated, true);
});

test("timeout terminates worker and next request creates a fresh one", async () => {
  const workers = [];
  const backend = new LayaBackend({
    createWorker: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
  });
  await assert.rejects(
    backend.score({}, { ...settings, timeoutMs: 5 }),
    /TIMEOUT/,
  );
  assert.equal(workers[0].terminated, true);
  const next = backend.score({}, settings);
  workers[1].emit("message", { scores: [] });
  await next;
  await backend.close();
});

test("cancellation kills in-flight worker and sanitized errors do not leak native details", async () => {
  const worker = new FakeWorker();
  const backend = new LayaBackend({ createWorker: () => worker });
  const abort = new AbortController();
  const pending = backend.score({}, settings, abort.signal);
  abort.abort();
  await assert.rejects(pending, /ABORTED/);
  assert.equal(worker.terminated, true);
  const failed = backend.score({}, settings);
  worker.emit("error", new Error("private path or prompt"));
  await assert.rejects(failed, { message: "WORKER_FAILED" });
});
