import { describe, expect, it } from "vitest"
import {
  describeLocation,
  destinationView,
  keyFor,
  locationSchemas,
  missingCredentials,
  placeOf,
  placesOverlap,
} from "./index.ts"
import { sftpRoot } from "./sftp.ts"
import { checkKey, cleanFolder } from "./store.ts"

const s3 = (bucket: string, prefix: string, endpoint = "https://s3.example.com") => ({
  endpoint,
  region: "us-east-1",
  bucket,
  prefix,
  forcePathStyle: true,
})

describe("places of destinations", () => {
  it("overlap when one holds the other, so retention could remove the other's archives", () => {
    const root = placeOf("s3", s3("b", ""))
    const a = placeOf("s3", s3("b", "a"))
    const ab = placeOf("s3", s3("b", "a/b"))
    expect(placesOverlap(a, a)).toBe(true)
    expect(placesOverlap(a, ab)).toBe(true)
    expect(placesOverlap(ab, a)).toBe(true)
    expect(placesOverlap(root, ab)).toBe(true)
  })

  it("do not overlap side by side, in another bucket, on another service or for another kind", () => {
    expect(placesOverlap(placeOf("s3", s3("b", "a")), placeOf("s3", s3("b", "ab")))).toBe(false)
    expect(placesOverlap(placeOf("s3", s3("b", "a")), placeOf("s3", s3("c", "a")))).toBe(false)
    expect(placesOverlap(placeOf("s3", s3("b", "a")), placeOf("s3", s3("b", "a", "https://other.example.com")))).toBe(
      false,
    )
    expect(placesOverlap(placeOf("local", { folder: "a" }), placeOf("s3", s3("b", "a")))).toBe(false)
  })

  it("compare host names without case and paths without surrounding slashes", () => {
    expect(
      placesOverlap(
        placeOf("s3", s3("b", "/a/", "https://S3.Example.com")),
        placeOf("s3", s3("b", "a", "https://s3.example.com")),
      ),
    ).toBe(true)
    expect(placesOverlap(placeOf("local", { folder: "" }), placeOf("local", { folder: "nas" }))).toBe(true)
  })

  it("depend on the account for SFTP and WebDAV, where the account decides the folder", () => {
    const sftp = (username: string, path: string) => placeOf("sftp", { host: "nas", port: 22, username, path })
    expect(placesOverlap(sftp("a", "/backups"), sftp("a", "/backups/x"))).toBe(true)
    expect(placesOverlap(sftp("a", "/backups"), sftp("b", "/backups"))).toBe(false)
    const dav = (url: string) => placeOf("webdav", { url, username: "u" })
    expect(
      placesOverlap(dav("https://cloud.example.com/dav/files/u/"), dav("https://cloud.example.com/dav/files/u/n8n")),
    ).toBe(true)
  })
})

describe("archive keys", () => {
  it("go under the S3 key prefix, and as given elsewhere", () => {
    expect(keyFor({ kind: "s3", location: s3("b", "/ops/") }, ["prod", "2026", "x.age"])).toBe("ops/prod/2026/x.age")
    expect(keyFor({ kind: "s3", location: s3("b", "") }, ["prod", "x.age"])).toBe("prod/x.age")
    expect(keyFor({ kind: "local", location: { folder: "nas" } }, ["prod", "x.age"])).toBe("prod/x.age")
  })

  it("never leave the destination's folder", () => {
    for (const bad of ["../x", "a/../../x", "a//b", "/abs", "a/./b", ".."]) expect(() => checkKey(bad)).toThrow()
    expect(checkKey("prod/2026/10/prod-20261022T020000Z-1a2b3c4d.tar.gz.age")).toHaveLength(4)
    expect(cleanFolder(" /team/nas/ ")).toBe("team/nas")
    expect(cleanFolder("")).toBe("")
    expect(() => cleanFolder("a/../b")).toThrow()
  })
})

describe("destination settings", () => {
  it("take WebDAV only over HTTPS, without credentials in the URL", () => {
    const parse = (url: string) => locationSchemas.webdav.safeParse({ url, username: "u" }).success
    expect(parse("https://cloud.example.com/remote.php/dav/files/u/n8n-ops")).toBe(true)
    expect(parse("http://nas.local/dav/")).toBe(false)
    expect(parse("https://u:p@cloud.example.com/dav/")).toBe(false)
  })

  it("refuse folder names that could climb out of /backups", () => {
    expect(locationSchemas.local.safeParse({ folder: "../etc" }).success).toBe(false)
    expect(locationSchemas.local.safeParse({ folder: "nightly" }).data).toEqual({ folder: "nightly" })
  })

  it("need a host key and a password or private key for SFTP", () => {
    expect(missingCredentials("sftp", { passwordEnc: "x" })).toMatch(/host key/)
    expect(missingCredentials("sftp", { hostKey: "SHA256:x" })).toMatch(/password or a private key/)
    expect(missingCredentials("sftp", { hostKey: "SHA256:x", privateKeyEnc: "x" })).toBeNull()
    expect(missingCredentials("local", {})).toBeNull()
  })

  it("show secrets only as set or not, never their ciphertext", () => {
    const view = destinationView({
      id: "d",
      name: "S3",
      kind: "s3",
      location: s3("b", "ops"),
      credentials: { accessKeyId: "AKIA", secretAccessKeyEnc: "v1:secret" },
      retention: { daily: 7, weekly: 4, monthly: 6 },
      objectLock: null,
      enabled: true,
      isDefault: true,
      lockedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    expect(view.credentials).toEqual({ accessKeyId: "AKIA", secretAccessKeySet: true })
    expect(JSON.stringify(view)).not.toContain("v1:secret")
    expect(view.where).toBe("s3://b/ops at s3.example.com")
  })

  it("say in one line where archives are", () => {
    expect(describeLocation({ kind: "local", location: { folder: "nas" } })).toBe("/backups/nas")
    expect(describeLocation({ kind: "sftp", location: { host: "nas", port: 2222, username: "u", path: "/b" } })).toBe(
      "sftp://u@nas:2222/b",
    )
  })
})

describe("sftpRoot", () => {
  it("keeps an absolute folder absolute, the root included; only an empty path is the home folder", () => {
    expect(sftpRoot("/")).toBe("/")
    expect(sftpRoot("//")).toBe("/")
    expect(sftpRoot(" /backups/n8n/ ")).toBe("/backups/n8n")
    expect(sftpRoot("backups/")).toBe("backups")
    expect(sftpRoot("")).toBe(".")
  })
})
