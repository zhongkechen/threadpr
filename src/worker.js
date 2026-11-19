import { propose, reply } from './review.js';

const maxAttempts = 6;

export async function drainJobs({ store, github, botLogin, now = Date.now, logger = console }) {
  for (let job = store.next(now()); job; job = store.next(now())) {
    try {
      const client = await github(job);
      let message = job.message;
      if (message === null) {
        message = await propose(client, job, botLogin);
        if (message !== null) store.saveMessage(job.id, message);
      }
      if (message !== null) await reply(client, job, message, botLogin, job.attempts > 1);
      store.finish(job.id, 'done');
    } catch (error) {
      const retryable = error.retryable === true || error instanceof TypeError ||
        error.name === 'TimeoutError' || error.name === 'AbortError';
      if (retryable && job.attempts < maxAttempts) {
        const delay = Math.max(1000 * 2 ** job.attempts, error.retryAfterMs || 0);
        store.delay(job.id, now() + delay);
        logger.warn(`ThreadPR job ${job.id} will retry after ${delay} ms`);
      } else {
        store.finish(job.id, 'failed');
        logger.error(`ThreadPR job ${job.id} failed on attempt ${job.attempts}`,
          error.status ? `GitHub HTTP ${error.status}` : error.name);
      }
    }
  }
}
