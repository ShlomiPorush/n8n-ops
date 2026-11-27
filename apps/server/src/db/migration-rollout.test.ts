import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

const LAST_UNMARKED = 35
const folder = join(import.meta.dirname, "../../drizzle")

const NEW_TABLE = /^CREATE TABLE (?:IF NOT EXISTS )?"(\w+)"\s*\(/i
const NEW_INDEX = /^CREATE (?:UNIQUE )?INDEX (?:IF NOT EXISTS )?"\w+" ON "(\w+)"/i
const NEW_FOREIGN_KEY =
  /^ALTER TABLE "(\w+)" ADD CONSTRAINT "\w+" FOREIGN KEY \([^)]*\) REFERENCES "(?:public"\.")?(\w+)"/i

function statements(text: string) {
  return text
    .split("--> statement-breakpoint")
    .map((part) =>
      part
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter(Boolean)
}

function rolloutProblems(text: string): string[] {
  const marker = text.split("\n", 1)[0]
  if (marker === "-- rollout: downtime") return []
  if (marker !== "-- rollout: expand") return ["the first line is neither -- rollout: expand nor -- rollout: downtime"]
  const all = statements(text)
  const created = new Set(all.map((s) => NEW_TABLE.exec(s)?.[1]).filter((t): t is string => Boolean(t)))
  const problems: string[] = []
  for (const statement of all) {
    if (statement.replace(/;\s*$/, "").includes(";")) {
      problems.push(`more than one statement between breakpoints: ${statement.split("\n", 1)[0]}`)
      continue
    }
    const table = NEW_TABLE.exec(statement)
    if (table) {
      if (/\b(PARTITION OF|INHERITS|GENERATED|REFERENCES)\b/i.test(statement))
        problems.push(`${table[1]}: a new table may not be a partition, inherit, have generated columns or references`)
      continue
    }
    const index = NEW_INDEX.exec(statement)
    if (index?.[1] && created.has(index[1])) continue
    const key = NEW_FOREIGN_KEY.exec(statement)
    if (key?.[1] && key[2] && created.has(key[1]) && created.has(key[2])) continue
    problems.push(`not an expand statement: ${statement.split("\n", 1)[0]}`)
  }
  return problems
}

describe("a migration", () => {
  it("after 0035 says whether the release before it keeps working, and expand allows only new tables", () => {
    const marked = readdirSync(folder)
      .filter((f) => f.endsWith(".sql") && Number(f.slice(0, 4)) > LAST_UNMARKED)
      .map((f) => [f, rolloutProblems(readFileSync(join(folder, f), "utf8"))] as const)
      .filter(([, problems]) => problems.length)
    expect(marked).toEqual([])
  })

  it.each([
    ['CREATE TABLE "a" (\n\t"id" text PRIMARY KEY NOT NULL\n);', "a new table"],
    [
      'CREATE TABLE "a" ("id" text PRIMARY KEY NOT NULL);\n--> statement-breakpoint\nCREATE TABLE "b" ("a_id" text);\n--> statement-breakpoint\nCREATE INDEX "b_a_idx" ON "b" USING btree ("a_id");\n--> statement-breakpoint\nALTER TABLE "b" ADD CONSTRAINT "b_a_fk" FOREIGN KEY ("a_id") REFERENCES "public"."a"("id") ON DELETE cascade ON UPDATE no action;',
      "new tables with their index and a key between them",
    ],
  ])("marked expand is accepted: %s (%s)", (sql) => {
    expect(rolloutProblems(`-- rollout: expand\n${sql}`)).toEqual([])
  })

  it.each([
    ['ALTER TABLE "instances" ADD COLUMN "x" text;', "a column on a table in use"],
    ['ALTER TABLE "instances" DROP COLUMN "name";', "a dropped column"],
    ['CREATE INDEX "i" ON "instances" USING btree ("name");', "an index on a table in use"],
    ['CREATE TABLE "a" ("i" text REFERENCES "instances"("id"));', "a reference to a table in use"],
    ['CREATE TABLE "a" ("i" integer GENERATED ALWAYS AS (1) STORED);', "a generated column"],
    ['CREATE TABLE "a" PARTITION OF "audit_log" FOR VALUES IN (1);', "a partition of a table in use"],
    ['UPDATE "instances" SET "name" = "name";', "rewritten rows"],
    ['CREATE TABLE "a" ("i" text) INHERITS ("instances");', "a child of a table in use"],
    ['CREATE TABLE "a" ("i" text); DROP TABLE "instances";', "a second statement behind a new table"],
    [
      'CREATE TABLE "a" ("i" text);\n--> statement-breakpoint\nALTER TABLE "a" ADD CONSTRAINT "f" FOREIGN KEY ("i") REFERENCES "public"."instances"("id");',
      "a key to a table in use",
    ],
  ])("marked expand is refused: %s (%s)", (sql) => {
    expect(rolloutProblems(`-- rollout: expand\n${sql}`)).not.toEqual([])
  })

  it("without a marker is refused, and downtime accepts anything", () => {
    expect(rolloutProblems('CREATE TABLE "a" ("id" text);')).not.toEqual([])
    expect(rolloutProblems('-- rollout: downtime\nALTER TABLE "instances" DROP COLUMN "name";')).toEqual([])
  })
})
