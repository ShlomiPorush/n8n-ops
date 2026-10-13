import { z } from "zod"

/** Response of the server's health endpoints. */
export const healthSchema = z.object({
  status: z.enum(["ok", "error"]),
  version: z.string(),
  checks: z.record(z.string(), z.enum(["ok", "error"])),
})

export type Health = z.infer<typeof healthSchema>
