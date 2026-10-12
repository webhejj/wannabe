import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratch, wannabe, write } from "./helpers.ts";

const NAME = "'^app-\\d{8}-\\d{6}\\.sql\\.gz$'";
const dump = (sql = "select 1;\n") => Buffer.from(Bun.gzipSync(Buffer.from(sql))).toString("latin1");
/** A dump cut off half way, as a partly synced file is: random rows, so it does not compress to nothing. */
const truncated = () => {
  const whole = dump(Array.from({ length: 2000 }, () => `insert into t values ('${Math.random()}');`).join("\n"));
  return whole.slice(0, whole.length / 2);
};

/** A project with a local context that may fetch and restore, a prod one whose dumps sit in share/, and test. */
function setup(share: Record<string, string>, localAllow = "[dump fetched]"): string {
  const project = scratch({
    ".wannabe/local/context.yaml": "kind: Context\nspec:\n  endpoints: {}\n",
    ".wannabe/local/database.yaml": `kind: Database\nspec:\n  dumps:\n    dir: data/dumps\n    name: ${NAME}\n  allow: ${localAllow}\n`,
    ".wannabe/prod/context.yaml": "kind: Context\nspec:\n  endpoints: {}\n",
    ".wannabe/prod/database.yaml":
      `kind: Database\nspec:\n  dumps:\n    from: share\n    name: ${NAME}\n    maxTries: 2\n  allow: []\n  otherwise: the operator applies SQL by hand\n`,
    ".wannabe/test/context.yaml": "kind: Context\nspec:\n  endpoints: {}\n",
  });
  mkdirSync(join(project, "share"), { recursive: true });
  for (const [file, content] of Object.entries(share)) writeFileSync(join(project, "share", file), Buffer.from(content, "latin1"));
  return project;
}
const fetched = (project: string, ...more: string[]) => wannabe(project, ["dump", "fetched", "--from", "prod", "--to", "local", ...more]);
const kept = (project: string) => (existsSync(join(project, "data/dumps")) ? readdirSync(join(project, "data/dumps")).sort() : []);

describe("dump fetched", () => {
  test("fetches the newest dated dump, never -latest, and prints its path", () => {
    const project = setup({ "app-20260101-100000.sql.gz": dump(), "app-20260102-100000.sql.gz": dump(), "app-latest.sql.gz": dump() });
    const run = fetched(project);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("data/dumps/app-20260102-100000.sql.gz\n");
    expect(kept(project)).toEqual(["app-20260102-100000.sql.gz"]);
    const again = fetched(project);
    expect(again.stderr).toContain("Already have");
  });

  test("falls back past an incomplete newest dump, leaving no trace of it", () => {
    const project = setup({ "app-20260101-100000.sql.gz": dump(), "app-20260102-100000.sql.gz": truncated() });
    const run = fetched(project);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("data/dumps/app-20260101-100000.sql.gz\n");
    expect(kept(project)).toEqual(["app-20260101-100000.sql.gz"]);
  });

  test("gives up after maxTries incomplete dumps", () => {
    const project = setup({ "app-20260101-100000.sql.gz": dump(), "app-20260102-100000.sql.gz": truncated(), "app-20260103-100000.sql.gz": truncated() });
    const run = fetched(project);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("none of the newest 2 dumps");
    expect(kept(project)).toEqual([]);
  });

  test("with --file, fails on an incomplete dump instead of picking another", () => {
    const project = setup({ "app-20260101-100000.sql.gz": dump(), "app-20260102-100000.sql.gz": truncated() });
    const run = fetched(project, "--file", "app-20260102-100000.sql.gz");
    expect(run.code).toBe(1);
    expect(kept(project)).toEqual([]);
    expect(fetched(project, "--file", "app-latest.sql.gz").code).toBe(2);
  });

  test("replaces an incomplete dump already in the directory", () => {
    const project = setup({ "app-20260101-100000.sql.gz": dump() });
    write(project, { "data/dumps/app-20260101-100000.sql.gz": "not gzip" });
    const run = fetched(project);
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("not complete");
  });

  test("a dry run says what it would fetch and fetches nothing", () => {
    const project = setup({ "app-20260101-100000.sql.gz": dump(), "app-20260102-100000.sql.gz": dump() });
    const run = wannabe(project, ["dump", "fetched", "--from", "prod", "--to", "local"], "wannatry");
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("fetch app-20260102-100000.sql.gz from");
    expect(kept(project)).toEqual([]);
  });

  test("answers 3 for a context that does not allow it, or has no database.yaml", () => {
    const project = setup({ "app-20260101-100000.sql.gz": dump() }, "[]");
    expect(fetched(project).code).toBe(3);
    const intoProd = wannabe(project, ["dump", "fetched", "--from", "prod", "--to", "prod"]);
    expect(intoProd.code).toBe(3);
    expect(intoProd.stderr).toContain("the operator applies SQL by hand");
    const intoTest = wannabe(project, ["dump", "fetched", "--from", "prod", "--to", "test"]);
    expect(intoTest.code).toBe(3);
    expect(intoTest.stderr).toContain("no database.yaml");
  });

  test("needs both contexts", () => {
    const project = setup({});
    expect(wannabe(project, ["dump", "fetched", "--from", "prod"]).code).toBe(2);
  });
});
