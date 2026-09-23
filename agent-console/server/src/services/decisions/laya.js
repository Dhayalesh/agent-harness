import { Worker } from "node:worker_threads";

/** One resident model; no unbounded queue or simultaneous model copies. */
export class LayaBackend {
  worker;
  busy = false;

  constructor({
    createWorker = (url, options) => new Worker(url, options),
  } = {}) {
    this.createWorker = createWorker;
  }

  async score(request, config, signal) {
    if (signal?.aborted) throw new Error("ABORTED");
    if (this.busy) throw new Error("CAPACITY");
    this.busy = true;
    let worker;
    try {
      if (!this.worker) {
        this.worker = this.createWorker(
          new URL("./laya-worker.js", import.meta.url),
          {
            workerData: { modelDir: config.modelDir, threads: config.threads },
          },
        );
        const created = this.worker;
        // A native error while idle must not crash the console or leave a dead worker cached.
        created.on("error", () => {
          if (this.worker === created) this.worker = undefined;
        });
        created.on("exit", () => {
          if (this.worker === created) this.worker = undefined;
        });
      }
      worker = this.worker;
      worker.ref();
      return await new Promise((resolve, reject) => {
        const finish = (error, result) => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
          worker.off("message", message);
          worker.off("error", failed);
          worker.off("exit", exited);
          error ? reject(error) : resolve(result);
        };
        const abort = () => finish(new Error("ABORTED"));
        const failed = () => finish(new Error("WORKER_FAILED"));
        const exited = () => finish(new Error("WORKER_EXITED"));
        const message = (value) =>
          value.error
            ? finish(new Error("INFERENCE_FAILED"))
            : finish(null, value.scores);
        const timer = setTimeout(
          () => finish(new Error("TIMEOUT")),
          config.timeoutMs,
        );
        worker.once("message", message);
        worker.once("error", failed);
        worker.once("exit", exited);
        signal?.addEventListener("abort", abort, { once: true });
        worker.postMessage(request);
      });
    } catch (error) {
      this.worker = undefined;
      if (worker) await worker.terminate();
      throw error;
    } finally {
      worker?.unref();
      this.busy = false;
    }
  }

  async close() {
    const worker = this.worker;
    this.worker = undefined;
    if (worker) await worker.terminate();
  }
}
