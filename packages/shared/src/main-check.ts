import { z } from "zod"

const reading = z.object({ status: z.number(), error: z.string().max(200).optional() })

/**
 * What the worker's check inside an n8n main container prints (apps/worker/src/inside.ts): health and readiness
 * statuses, the execution mode, the state of the metrics with the queue figures and the version. Anything else is
 * not understood, and not used.
 */
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
