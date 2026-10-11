import type { MessagePortLike } from "./protocol";
import { runCodemodeWorker } from "./workerMain";

// Built as its own bundle (`codemode-worker.js`) and started as a Web Worker by the sandbox host.
runCodemodeWorker(self as unknown as MessagePortLike);
