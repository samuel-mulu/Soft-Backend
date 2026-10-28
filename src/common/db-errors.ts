import { ServiceUnavailableException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

export const DB_UNAVAILABLE = 'Could not reach the database. Try again in a moment.';

export function isRetryableDatabaseError(err: unknown): boolean {
  return err instanceof Prisma.PrismaClientKnownRequestError &&
    (err.code === 'P1001' || err.code === 'P1002' || err.code === 'P2024' || err.code === 'P2028');
}

export async function withDatabaseRetries<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      last = err;
      if (!isRetryableDatabaseError(err) || i >= attempts) break;
      await new Promise((r) => setTimeout(r, 400 * i));
    }
  }
  rethrowDatabaseError(last);
}

export function rethrowDatabaseError(err: unknown): never {
  if (isRetryableDatabaseError(err)) {
    throw new ServiceUnavailableException(DB_UNAVAILABLE);
  }
  throw err;
}
