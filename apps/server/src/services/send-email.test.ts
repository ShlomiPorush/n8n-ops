import { randomBytes } from "node:crypto"
import { createServer, type Server } from "node:net"
import { afterEach, describe, expect, it } from "vitest"
import type { Ctx } from "../context.ts"
import { defaults, type Section } from "../lib/settings.ts"
import { sendEmail } from "./reports.ts"

/**
 * A plain-text SMTP server on 127.0.0.1 that records the command of every line it receives. It never encrypts:
 * `starttls` says whether it advertises STARTTLS (then refuses it with 454) or not at all (502 when asked).
 */
async function smtpServer(starttls: "none" | "refused") {
  const commands: string[] = []
  const server: Server = createServer((socket) => {
    socket.write("220 smtp.test ESMTP\r\n")
    let buffer = ""
    let data = false
    socket.on("data", (chunk) => {
      buffer += chunk.toString("latin1")
      for (let end = buffer.indexOf("\r\n"); end >= 0; end = buffer.indexOf("\r\n")) {
        const line = buffer.slice(0, end)
        buffer = buffer.slice(end + 2)
        if (data) {
          if (line === ".") {
            data = false
            socket.write("250 queued\r\n")
          }
          continue
        }
        const command = line.split(" ")[0]?.toUpperCase() ?? ""
        commands.push(command)
        if (command === "EHLO")
          socket.write(`250-smtp.test\r\n${starttls === "refused" ? "250-STARTTLS\r\n" : ""}250 AUTH PLAIN LOGIN\r\n`)
        else if (command === "STARTTLS")
          socket.write(starttls === "refused" ? "454 TLS not available\r\n" : "502 command not implemented\r\n")
        else if (command === "AUTH") socket.write("235 accepted\r\n")
        else if (command === "MAIL" || command === "RCPT") socket.write("250 ok\r\n")
        else if (command === "DATA") {
          data = true
          socket.write("354 go ahead\r\n")
        } else if (command === "QUIT") socket.end("221 bye\r\n")
        else socket.write("502 command not implemented\r\n")
      }
    })
    socket.on("error", () => {})
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  servers.push(server)
  return { port, commands }
}

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))))
})

/** The parts of the context sendEmail reads: the Email settings in effect, the environment's values, decryption. */
function ctxWith(email: Partial<Section<"email">>, env: { smtpAllowUnencrypted?: boolean } = {}) {
  const password = randomBytes(12).toString("hex")
  const value: Section<"email"> = {
    ...defaults.email,
    recipients: ["ops@example.com"],
    from: "n8n-ops@example.com",
    smtpHost: "127.0.0.1",
    ...email,
  }
  const ctx = {
    settings: {
      get: async () => value,
      fromEnv: () => env,
    },
    secrets: { decrypt: () => password },
  } as unknown as Ctx
  return { ctx, password }
}

const report = { subject: "Daily report", text: "Nothing open.", html: "<p>Nothing open.</p>" }

describe("sending email without TLS from the start", () => {
  it("sends nothing when the server offers no STARTTLS: no password, no message", async () => {
    const smtp = await smtpServer("none")
    const { ctx } = ctxWith({ smtpPort: smtp.port, smtpUser: "reports", smtpPasswordEnc: "stored" })
    await expect(sendEmail(ctx, report)).rejects.toMatchObject({
      code: "ETLS",
      message: expect.stringContaining("No encrypted connection could be made with the SMTP server"),
    })
    expect(smtp.commands).not.toContain("AUTH")
    expect(smtp.commands).not.toContain("MAIL")
    expect(smtp.commands).not.toContain("DATA")
  })

  it("sends no message without a user either", async () => {
    const smtp = await smtpServer("none")
    const { ctx } = ctxWith({ smtpPort: smtp.port })
    await expect(sendEmail(ctx, report)).rejects.toMatchObject({ code: "ETLS" })
    expect(smtp.commands).not.toContain("MAIL")
    expect(smtp.commands).not.toContain("DATA")
  })

  it("sends nothing when the server offers STARTTLS but refuses it", async () => {
    const smtp = await smtpServer("refused")
    const { ctx } = ctxWith({ smtpPort: smtp.port, smtpUser: "reports", smtpPasswordEnc: "stored" })
    await expect(sendEmail(ctx, report)).rejects.toMatchObject({ code: "ETLS" })
    expect(smtp.commands).toEqual(["EHLO", "STARTTLS"])
  })

  it("sends without encryption only when that is allowed", async () => {
    const smtp = await smtpServer("none")
    const { ctx } = ctxWith({
      smtpPort: smtp.port,
      smtpUser: "reports",
      smtpPasswordEnc: "stored",
      smtpAllowUnencrypted: true,
    })
    await expect(sendEmail(ctx, report)).resolves.toEqual(["ops@example.com"])
    expect(smtp.commands).toEqual(expect.arrayContaining(["AUTH", "MAIL", "RCPT", "DATA"]))
  })

  it("a test cannot allow it while the environment forbids it", async () => {
    const smtp = await smtpServer("none")
    const { ctx } = ctxWith({ smtpPort: smtp.port }, { smtpAllowUnencrypted: false })
    await expect(sendEmail(ctx, report, { smtpAllowUnencrypted: true })).rejects.toMatchObject({ code: "ETLS" })
    expect(smtp.commands).not.toContain("MAIL")
  })

  it("a test may allow it when the environment leaves it to Settings", async () => {
    const smtp = await smtpServer("none")
    const { ctx } = ctxWith({ smtpPort: smtp.port })
    await expect(sendEmail(ctx, report, { smtpAllowUnencrypted: true })).resolves.toEqual(["ops@example.com"])
  })
})
