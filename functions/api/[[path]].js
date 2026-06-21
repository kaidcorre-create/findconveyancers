import workerHandler from '../../worker.js';

export async function onRequest(context) {
  return workerHandler.fetch(context.request, context.env);
}
