import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { plugin, scratch, wannabe } from "./helpers.ts";

const project = () =>
  scratch({
    ".wannabe/test/context.yaml": "kind: Context\nspec:\n  endpoints:\n    host: h\n",
    ".wannabe/prod/context.yaml": "kind: Context\nspec: {}\n",
    ".wannabe/plugins/demo/greeted": plugin("--to <context> [--loud] — say hello", 'echo "hello $* dry=${WANNABE_DRY_RUN:-0}"'),
    ".wannabe/plugins/deployment/synced": plugin("--to <context> — the project's own", "echo project-synced"),
    ".wannabe/plugins/self/version": plugin("— hijack", "echo hijacked"),
    ".wannabe/plugins/helped": plugin("— hijack", "echo hijacked"),
    "src/deep/.keep": "",
  });

describe("dispatch", () => {
  test("runs a project plugin with its arguments untouched", () => {
    const run = wannabe(project(), ["demo", "greeted", "--to", "test", "extra"]);
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toBe("hello --to test extra dry=0");
  });

  test("wannatry sets the dry run; wannado is only a name", () => {
    const dir = project();
    expect(wannabe(dir, ["demo", "greeted"], "wannatry").stdout.trim()).toBe("hello  dry=1");
    expect(wannabe(dir, ["demo", "greeted"], "wannado").stdout.trim()).toBe("hello  dry=0");
  });

  test("finds the project from a subdirectory", () => {
    const dir = project();
    expect(wannabe(join(dir, "src", "deep"), ["demo", "greeted"]).stdout).toContain("hello");
  });

  test("a project plugin replaces a shipped one of the same name", () => {
    expect(wannabe(project(), ["deployment", "synced"]).stdout.trim()).toBe("project-synced");
  });

  test("shipped plugins are found when the project has none", () => {
    const run = wannabe(project(), ["deployment", "pulled"]);
    expect(run.stderr).toContain("which context?");
    expect(run.code).toBe(2);
  });

  test("helped and self cannot be taken by plugins", () => {
    const dir = project();
    expect(wannabe(dir, ["self", "version"]).stdout).not.toContain("hijacked");
    expect(wannabe(dir, ["helped"]).stdout).not.toContain("hijacked");
    const listing = wannabe(dir, []).stderr;
    expect(listing.match(/^ {2}self /gm)?.length).toBe(1);
    expect(listing.match(/^ {2}helped /gm)?.length).toBe(1);
  });

  test("an unknown command lists the group and exits 2", () => {
    const run = wannabe(project(), ["deployment", "bogus"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("no command 'bogus' in deployment");
    expect(run.stderr).toContain("synced");
  });

  test("outside a project, commands refuse and exit 2, but listing works", () => {
    const dir = scratch();
    const run = wannabe(dir, ["deployment", "synced", "--to", "test"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("no .wannabe/");
    expect(wannabe(dir, []).stderr).toContain("deployment");
  });
});

describe("helped", () => {
  test("shows a command's header with its full usage and origin", () => {
    const run = wannabe(project(), ["helped", "demo", "greeted"]);
    expect(run.stdout).toContain("Usage: wannabe demo greeted --to <context> [--loud] — say hello");
    expect(run.stdout).toContain("Details.");
    expect(run.stdout).toContain("From this project:");
  });

  test("the overview names the project and its contexts", () => {
    const run = wannabe(project(), ["helped"]);
    expect(run.stdout).toContain("Contexts: prod test");
    expect(run.stdout).toContain("greeted");
  });
});

describe("completion", () => {
  const complete = (...words: string[]) => wannabe(project(), ["__complete", ...words]).stdout.trim().split("\n");

  test("groups and built-ins at the top", () => {
    expect(complete("")).toEqual(expect.arrayContaining(["demo", "deployment", "released", "helped", "self"]));
  });
  test("a group's commands", () => {
    expect(complete("demo", "")).toEqual(["greeted"]);
  });
  test("a command's flags, from its usage line", () => {
    expect(complete("demo", "greeted", "")).toEqual(["--loud", "--to"]);
  });
  test("contexts after --to", () => {
    expect(complete("demo", "greeted", "--to", "")).toEqual(["prod", "test"]);
  });
  test("self and its options", () => {
    expect(complete("self", "")).toContain("installed");
    expect(complete("self", "installed", "--into", "")).toEqual(["__dirs__"]);
    expect(complete("self", "completion", "")).toEqual(["zsh", "fish"]);
  });
});

describe("self completion", () => {
  test("prints a script for each shell it knows, and refuses another", () => {
    const dir = project();
    expect(wannabe(dir, ["self", "completion", "zsh"]).stdout).toContain("compdef _wannabe wannabe wannado wannatry");
    expect(wannabe(dir, ["self", "completion", "fish"]).stdout).toContain("complete -c wannatry");
    const run = wannabe(dir, ["self", "completion", "bash"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("self completion zsh | fish");
  });
});

describe("self get", () => {
  test("prints a value, and exits 1 when it is missing", () => {
    const dir = project();
    expect(wannabe(dir, ["self", "get", "test/context", "spec.endpoints.host"]).stdout.trim()).toBe("h");
    expect(wannabe(dir, ["self", "get", "test/context", "spec.nope"]).code).toBe(1);
  });
});
