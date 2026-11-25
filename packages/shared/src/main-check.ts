import { z } from "zod"

const reading = z.object({
  status: z.number(),
  error: z.string().max(200).optional(),
  ms: z.number().min(0).max(60_000).optional().catch(undefined),
  code: z.string().max(40).optional().catch(undefined),
})

export const mainCheckOutput = z.object({
  health: reading.optional(),
  readiness: reading.optional(),
  mode: z.enum(["queue", "regular"]).nullable().optional(),
  metrics: z
    .object({
      state: z.enum(["read", "off", "404", "no-queue-figures", "failed", "skipped"]),
      reason: z.string().max(200).optional(),
    })
    .optional(),
  queue: z.object({ waiting: z.number(), active: z.number(), completed: z.number(), failed: z.number() }).optional(),
  version: z.string().max(40).optional(),
  notCollected: z.string().max(300).optional(),
})

export type MainCheckOutput = z.infer<typeof mainCheckOutput>

export const QUEUE_WORKERS_PER_PROBE = 50

export const workerDetails = {
  version: z
    .string()
    .max(40)
    .regex(/^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}([-+.][0-9A-Za-z.+-]*)?$/)
    .optional()
    .catch(undefined),
  uptimeSec: z.number().int().min(0).max(1e10).optional().catch(undefined),
  memory: z
    .object({ used: z.number().min(0).max(1e15), limit: z.number().positive().max(1e18).nullable() })
    .optional()
    .catch(undefined),
}

export const workerCheckOutput = z.object({
  active: z.boolean().optional(),
  health: reading.optional(),
  readiness: reading.optional(),
  notCollected: z.string().max(300).optional(),
  details: z
    .object({
      ...workerDetails,
      concurrencyEnv: z
        .union([z.number().int(), z.literal("absent"), z.literal("unknown")])
        .optional()
        .catch(undefined),
    })
    .optional()
    .catch(undefined),
})

export type WorkerCheckOutput = z.infer<typeof workerCheckOutput>
