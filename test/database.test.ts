import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
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
const fetched = (project: string, ...more: string[]) => wannabe(project, ["database", "dump", "fetched", "--from", "prod", "--to", "local", ...more]);
const kept = (project: string) => (existsSync(join(project, "data/dumps")) ? readdirSync(join(project, "data/dumps")).sort() : []);

describe("database dump fetched", () => {
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
    const run = wannabe(project, ["database", "dump", "fetched", "--from", "prod", "--to", "local"], "wannatry");
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("fetch app-20260102-100000.sql.gz from");
    expect(kept(project)).toEqual([]);
  });

  test("answers 3 for a context that does not allow it, or has no database.yaml", () => {
    const project = setup({ "app-20260101-100000.sql.gz": dump() }, "[]");
    expect(fetched(project).code).toBe(3);
    const intoProd = wannabe(project, ["database", "dump", "fetched", "--from", "prod", "--to", "prod"]);
    expect(intoProd.code).toBe(3);
    expect(intoProd.stderr).toContain("the operator applies SQL by hand");
    const intoTest = wannabe(project, ["database", "dump", "fetched", "--from", "prod", "--to", "test"]);
    expect(intoTest.code).toBe(3);
    expect(intoTest.stderr).toContain("no database.yaml");
  });

  test("needs both contexts", () => {
    const project = setup({});
    expect(wannabe(project, ["database", "dump", "fetched", "--from", "prod"]).code).toBe(2);
  });
});

/** A psql that records its arguments and stdin in calls.log; a statement containing "boom" is an error. */
const PSQL = `#!/bin/sh
input=$(cat)
printf '%s\\n' "psql $*" "$input" "--" >> calls.log
case "$input" in *boom*) echo "psql:<stdin>:1: ERROR:  boom" >&2; case "$*" in *ON_ERROR_STOP=1*) exit 3 ;; esac ;; esac
case "$input" in *notice*) echo "psql:<stdin>:1: NOTICE:  42 rows checked" >&2 ;; esac
case "$input" in *fatal*) exit 2 ;; esac
exit 0
`;
const FLYWAY = `#!/bin/sh
printf '%s\\n' "flyway $*" "--" >> calls.log
[ "$1" = info ] && echo "Schema version: 82"
[ "$1" = validate ] && [ -f invalid ] && { echo "validate failed" >&2; exit 1; }
exit 0
`;

function dbSetup(
  dumps: Record<string, string>,
  allow = "[restored, refreshed, flyway applied, flyway repaired, sql applied, package applied]",
): string {
  const project = setup({}, allow);
  write(project, {
    "bin/psql": PSQL,
    "bin/flyway": FLYWAY,
    ".wannabe/local/database.yaml":
      `kind: Database\nspec:\n  name: app\n  psql: [bin/psql, -U, app]\n  flyway: [bin/flyway]\n` +
      `  dumps:\n    dir: data/dumps\n    name: ${NAME}\n  allow: ${allow}\n`,
  });
  mkdirSync(join(project, "data/dumps"), { recursive: true });
  for (const [file, content] of Object.entries(dumps)) writeFileSync(join(project, "data/dumps", file), Buffer.from(content, "latin1"));
  return project;
}
const calls = (project: string) => (existsSync(join(project, "calls.log")) ? readFileSync(join(project, "calls.log"), "utf8") : "");

describe("database restored", () => {
  test("drops and creates with ON_ERROR_STOP, then streams the newest dated dump in; prints its path", () => {
    const project = dbSetup({
      "app-20260101-100000.sql.gz": dump("old;\n"),
      "app-20260102-100000.sql.gz": dump("create table t();\n"),
      "app-latest.sql.gz": dump("latest;\n"),
    });
    const run = wannabe(project, ["database", "restored", "--to", "local"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("data/dumps/app-20260102-100000.sql.gz\n");
    expect(calls(project)).toBe(
      'psql -U app -d postgres -v ON_ERROR_STOP=1\nDROP DATABASE IF EXISTS "app" WITH (FORCE);\nCREATE DATABASE "app";\n--\n' +
        "psql -U app -d app\ncreate table t();\n--\n",
    );
  });

  test("counts and shows the errors psql reports, without stopping", () => {
    const project = dbSetup({ "app-20260101-100000.sql.gz": dump("boom;\n") });
    const run = wannabe(project, ["database", "restored", "--to", "local"]);
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("ERROR:  boom");
    expect(run.stderr).toContain("psql reported 1 error(s)");
  });

  test("fails when psql itself fails", () => {
    const project = dbSetup({ "app-20260101-100000.sql.gz": dump("fatal;\n") });
    expect(wannabe(project, ["database", "restored", "--to", "local"]).code).toBe(1);
  });

  test("--dump must match the dump name, exist and be complete", () => {
    const project = dbSetup({ "app-latest.sql.gz": dump(), "app-20260101-100000.sql.gz": truncated() });
    expect(wannabe(project, ["database", "restored", "--to", "local", "--dump", "data/dumps/app-latest.sql.gz"]).code).toBe(2);
    expect(wannabe(project, ["database", "restored", "--to", "local", "--dump", "data/dumps/app-20990101-100000.sql.gz"]).code).toBe(1);
    const incomplete = wannabe(project, ["database", "restored", "--to", "local", "--dump", "data/dumps/app-20260101-100000.sql.gz"]);
    expect(incomplete.code).toBe(1);
    expect(incomplete.stderr).toContain("not a complete dump");
    expect(calls(project)).toBe("");
  });

  test("no dump is a failure that says to fetch one", () => {
    const run = wannabe(dbSetup({}), ["database", "restored", "--to", "local"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("wannabe database dump fetched first");
  });

  test("a dry run names the dump and runs nothing", () => {
    const project = dbSetup({ "app-20260101-100000.sql.gz": dump() });
    const run = wannabe(project, ["database", "restored", "--to", "local"], "wannatry");
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("restore data/dumps/app-20260101-100000.sql.gz into app");
    expect(run.stderr).toContain("DROP DATABASE");
    expect(calls(project)).toBe("");
  });

  test("answers 3 where it is not allowed", () => {
    const project = dbSetup({ "app-20260101-100000.sql.gz": dump() }, "[flyway applied]");
    expect(wannabe(project, ["database", "restored", "--to", "local"]).code).toBe(3);
    const prod = wannabe(project, ["database", "restored", "--to", "prod"]);
    expect(prod.code).toBe(3);
    expect(prod.stderr).toContain("the operator applies SQL by hand");
    expect(calls(project)).toBe("");
  });
});

describe("database flyway", () => {
  test("applied runs migrate; listed prints info on stdout; validated fails with Flyway", () => {
    const project = dbSetup({});
    expect(wannabe(project, ["database", "flyway", "applied", "--to", "local"]).code).toBe(0);
    const listed = wannabe(project, ["database", "flyway", "listed", "--in", "local"]);
    expect(listed.stdout).toBe("Schema version: 82\n");
    expect(wannabe(project, ["database", "flyway", "validated", "--in", "local"]).code).toBe(0);
    write(project, { invalid: "" });
    expect(wannabe(project, ["database", "flyway", "validated", "--in", "local"]).code).toBe(1);
    expect(wannabe(project, ["database", "flyway", "repaired", "--to", "local"]).code).toBe(0);
    expect(calls(project)).toBe("flyway migrate\n--\nflyway info\n--\nflyway validate\n--\nflyway validate\n--\nflyway repair\n--\n");
  });

  test("applied and repaired answer 3 where not allowed; reading needs only a database.yaml", () => {
    const project = dbSetup({}, "[]");
    expect(wannabe(project, ["database", "flyway", "applied", "--to", "local"]).code).toBe(3);
    expect(wannabe(project, ["database", "flyway", "repaired", "--to", "local"]).code).toBe(3);
    expect(wannabe(project, ["database", "flyway", "listed", "--in", "local"]).code).toBe(0);
    expect(wannabe(project, ["database", "flyway", "listed", "--in", "test"]).code).toBe(3);
    expect(wannabe(project, ["database", "flyway", "listed", "--in", "prod"]).code).toBe(3);
  });

  test("a dry run of applied runs nothing", () => {
    const project = dbSetup({});
    const run = wannabe(project, ["database", "flyway", "applied", "--to", "local"], "wannatry");
    expect(run.stderr).toContain("dry run: bin/flyway migrate");
    expect(calls(project)).toBe("");
  });
});

describe("database refreshed", () => {
  test("restores, then migrates", () => {
    const project = dbSetup({ "app-20260101-100000.sql.gz": dump("create table t();\n") });
    const run = wannabe(project, ["database", "refreshed", "--to", "local"]);
    expect(run.code).toBe(0);
    expect(calls(project)).toMatch(/^psql -U app -d postgres[\s\S]*psql -U app -d app\ncreate table t\(\);\n--\nflyway migrate\n--\n$/);
  });

  test("does not migrate when the restore fails", () => {
    const project = dbSetup({ "app-20260101-100000.sql.gz": dump("fatal;\n") });
    expect(wannabe(project, ["database", "refreshed", "--to", "local"]).code).toBe(1);
    expect(calls(project)).not.toContain("flyway");
  });

  test("answers 3 unless allowed itself", () => {
    const project = dbSetup({ "app-20260101-100000.sql.gz": dump() }, "[restored, flyway applied]");
    expect(wannabe(project, ["database", "refreshed", "--to", "local"]).code).toBe(3);
    expect(calls(project)).toBe("");
  });
});

describe("database sql applied", () => {
  test("applies the files in the order given, with ON_ERROR_STOP, showing psql's notices", () => {
    const project = dbSetup({});
    write(project, { "b.sql": "select 'b'; notice\n", "a.sql": "select 'a';\n" });
    const run = wannabe(project, ["database", "sql", "applied", "--to", "local", "b.sql", "a.sql"]);
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("NOTICE:  42 rows checked");
    expect(run.stderr).toContain("Applied 2 file(s)");
    expect(calls(project)).toBe(
      "psql -U app -d app -v ON_ERROR_STOP=1\nselect 'b'; notice\n--\npsql -U app -d app -v ON_ERROR_STOP=1\nselect 'a';\n--\n",
    );
  });

  test("stops at the first failing file and names the ones not run", () => {
    const project = dbSetup({});
    write(project, { "1.sql": "one;\n", "2.sql": "boom;\n", "3.sql": "three;\n", "4.sql": "four;\n" });
    const run = wannabe(project, ["database", "sql", "applied", "--to", "local", "1.sql", "2.sql", "3.sql", "4.sql"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("FAILED: 2.sql (psql exit 3)");
    expect(run.stderr).toContain("Not run, 2 of 4:\n  3.sql\n  4.sql");
    expect(calls(project)).not.toContain("three");
  });

  test("applies nothing when a file is missing, and needs at least one", () => {
    const project = dbSetup({});
    write(project, { "1.sql": "one;\n" });
    expect(wannabe(project, ["database", "sql", "applied", "--to", "local", "1.sql", "nope.sql"]).code).toBe(1);
    expect(wannabe(project, ["database", "sql", "applied", "--to", "local"]).code).toBe(2);
    expect(calls(project)).toBe("");
  });

  test("reads files from where wannabe is run, not the project root", () => {
    const project = dbSetup({});
    write(project, { "sub/x.sql": "from sub;\n" });
    expect(wannabe(join(project, "sub"), ["database", "sql", "applied", "--to", "local", "x.sql"]).code).toBe(0);
    expect(calls(project)).toContain("from sub;");
  });

  test("a dry run lists what it would apply and applies nothing; 3 where not allowed", () => {
    const project = dbSetup({}, "[]");
    write(project, { "1.sql": "one;\n" });
    expect(wannabe(project, ["database", "sql", "applied", "--to", "local", "1.sql"]).code).toBe(3);
    const allowed = dbSetup({});
    write(allowed, { "1.sql": "one;\n" });
    const dry = wannabe(allowed, ["database", "sql", "applied", "--to", "local", "1.sql"], "wannatry");
    expect(dry.code).toBe(0);
    expect(dry.stderr).toContain("dry run: bin/psql -U app -d app -v ON_ERROR_STOP=1 < 1.sql");
    expect(calls(allowed)).toBe("");
  });
});

describe("database package applied", () => {
  test("applies the directory's .sql files in file-name order", () => {
    const project = dbSetup({});
    write(project, { "pkg/02-b.sql": "two;\n", "pkg/01-a.sql": "one;\n", "pkg/10-c.sql": "ten;\n", "pkg/README.md": "not sql" });
    const run = wannabe(project, ["database", "package", "applied", "--to", "local", "pkg"]);
    expect(run.code).toBe(0);
    expect(calls(project).match(/^(one|two|ten);$/gm)).toEqual(["one;", "two;", "ten;"]);
  });

  test("stops at the first failure, naming the files not run", () => {
    const project = dbSetup({});
    write(project, { "pkg/01.sql": "one;\n", "pkg/02.sql": "boom;\n", "pkg/03.sql": "three;\n" });
    const run = wannabe(project, ["database", "package", "applied", "--to", "local", "pkg"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("Not run, 1 of 3:\n  pkg/03.sql");
  });

  test("an empty or missing package is an error", () => {
    const project = dbSetup({});
    write(project, { "empty/README.md": "" });
    expect(wannabe(project, ["database", "package", "applied", "--to", "local", "empty"]).code).toBe(1);
    expect(wannabe(project, ["database", "package", "applied", "--to", "local", "missing"]).code).toBe(1);
    expect(calls(project)).toBe("");
  });

  test("answers 3 where only sql applied is allowed", () => {
    const project = dbSetup({}, "[sql applied]");
    write(project, { "pkg/01.sql": "one;\n" });
    expect(wannabe(project, ["database", "package", "applied", "--to", "local", "pkg"]).code).toBe(3);
    expect(wannabe(project, ["database", "sql", "applied", "--to", "local", "pkg/01.sql"]).code).toBe(0);
  });
});
