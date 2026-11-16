import type { D1Database, ExecutionContext, R2Bucket, ScheduledController } from "@cloudflare/workers-types";
import { handleV2, sweepV2 } from "./handle-v2.ts";
import { PAGE_SCRIPT } from "./page-script.ts";

export interface WorkerBindings {
  DB: D1Database;
  LOCKER_BUCKET: R2Bucket;
  LOCKER_HMAC_SECRET: string;
}

export default {
  async fetch(request: Request, env: WorkerBindings, ctx: ExecutionContext): Promise<Response> {
    return handleV2(request, env, ctx, PAGE_SCRIPT);
  },
  async scheduled(
    _controller: ScheduledController,
    env: WorkerBindings,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(sweepV2(env, Date.now()));
  },
};
