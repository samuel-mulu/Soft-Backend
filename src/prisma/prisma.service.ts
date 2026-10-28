import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(PrismaService.name);

  async onModuleInit() {
    const maxAttempts = 6;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.$connect();
        if (attempt > 1) this.log.log(`Database connected on attempt ${attempt}`);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (attempt >= maxAttempts) throw err;
        const waitMs = attempt * 2500;
        this.log.warn(
          `Database not reachable (attempt ${attempt}/${maxAttempts}). Retrying in ${waitMs / 1000}s… ${message}`,
        );
        await new Promise((r) => setTimeout(r, waitMs));
      }
    }
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
