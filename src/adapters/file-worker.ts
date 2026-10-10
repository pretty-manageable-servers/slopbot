import { parentPort, workerData } from 'node:worker_threads';
import { defaultFileReaders } from './file-readers.js';
defaultFileReaders().read(workerData.name, workerData.mime, workerData.data).then(value => parentPort!.postMessage({ value }), error => parentPort!.postMessage({ error: String(error.message ?? error) }));
