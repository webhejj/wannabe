import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { scratch, wannabe } from "./helpers.ts";

/** An application to run: serves /ready and /live on its port, as its mode says, and logs like a real one. */
const FAKE = `
const [port, mode] = process.argv.slice(2);
console.log("INFO starting");
if (mode === "crash") { console.log("ERROR could not start: bad config"); process.exit(1); }
await Bun.sleep(500);
console.log("\\x1b[31mERROR\\x1b[0m something went wrong along the way");
Bun.serve({ port: Number(port), fetch(req) {
  const path = new URL(req.url).pathname;
  if (path === "/live") return new Response("UP");
  if (path === "/ready") return new Response(mode === "unready" ? "OUT" : "UP", { status: mode === "unready" ? 503 : 200 });
  return new Response("hello");
} });
console.log("INFO Started FakeApplication");
`;

function freePort(): number {
  const server = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = server.port!;
  server.stop(true);
  return port;
}

const projects: string[] = [];
const strays: Bun.Subprocess[] = [];

/** A project whose local context runs the fake app in a mode, with test a deployed context. */
function setup(mode = "ok", extra = ""): { project: string; port: number } {
  const port = freePort();
  const project = scratch({
    "fake.ts": FAKE,
    ".wannabe/local/context.yaml": "kind: Context\nspec:\n  endpoints:\n    app: http://localhost:" + port + "/\n",
    ".wannabe/local/app.yaml":
      `kind: Application\nspec:\n  command: [${JSON.stringify(process.execPath)}, fake.ts, "${port}", ${mode}]\n` +
      `  readiness: http://localhost:${port}/ready\n  liveness: http://localhost:${port}/live\n  startTimeoutSeconds: 20\n${extra}`,
    ".wannabe/test/context.yaml": "kind: Context\nspec:\n  endpoints: {}\n",
    ".wannabe/test/deployment.yaml": "kind: Deployment\nspec:\n  service: app\n",
  });
  projects.push(project);
  return { project, port };
}

afterEach(() => {
  for (const project of projects.splice(0)) wannabe(project, ["app", "stopped", "--to", "local"]);
  for (const stray of strays.splice(0)) stray.kill();
});

/** Something wannabe did not start, listening on the port: the user's own run. */
async function foreign(project: string, port: number): Promise<void> {
  strays.push(Bun.spawn([process.execPath, "fake.ts", String(port), "ok"], { cwd: project, stdout: "ignore" }));
  for (let i = 0; i < 50 && !(await fetch(`http://localhost:${port}/ready`).then((r) => r.ok, () => false)); i++) await Bun.sleep(100);
}

describe("app running", () => {
  test("starts, waits until ready, prints the URL and the errors logged on the way; again changes nothing", () => {
    const { project, port } = setup();
    const run = wannabe(project, ["app", "running", "--to", "local"]);
    expect(run.code).toBe(0);
    expect(run.stdout.trim()).toBe(`http://localhost:${port}/`);
    expect(run.stderr).toContain("Errors logged during startup:");
    expect(run.stderr).toContain("ERROR something went wrong");
    expect(readFileSync(join(project, ".wannabe/local/.state/.gitignore"), "utf8")).toBe("*\n");

    const pid = readFileSync(join(project, ".wannabe/local/.state/app.pid"), "utf8");
    const again = wannabe(project, ["app", "running", "--to", "local"]);
    expect(again.code).toBe(0);
    expect(again.stderr).toContain("Already started by wannabe");
    expect(readFileSync(join(project, ".wannabe/local/.state/app.pid"), "utf8")).toBe(pid);
  }, 30000);

  test("fails as soon as the app exits, with its error lines", () => {
    const { project } = setup("crash");
    const started = Date.now();
    const run = wannabe(project, ["app", "running", "--to", "local"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("exited before it was ready");
    expect(run.stderr).toContain("ERROR could not start: bad config");
    expect(Date.now() - started).toBeLessThan(10000);
  }, 30000);

  test("refuses with 3, and leaves alone, an app it did not start", async () => {
    const { project, port } = setup();
    await foreign(project, port);
    const run = wannabe(project, ["app", "running", "--to", "local"]);
    expect(run.code).toBe(3);
    expect(run.stderr).toContain(`something else listens on :${port}`);
    expect(existsSync(join(project, ".wannabe/local/.state/app.pid"))).toBe(false);
    expect(strays[0].killed).toBe(false);
  }, 30000);

  test("a dry run starts nothing", () => {
    const { project } = setup();
    const run = wannabe(project, ["app", "running", "--to", "local"], "wannatry");
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("dry run:");
    expect(existsSync(join(project, ".wannabe/local/.state"))).toBe(false);
  });

  test("a context without app.yaml answers 3, naming the deployment when it has one", () => {
    const { project } = setup();
    const run = wannabe(project, ["app", "running", "--to", "test"]);
    expect(run.code).toBe(3);
    expect(run.stderr).toContain("wannabe deployment running --to test");
  });
});

describe("app ready", () => {
  test("1 and why when nothing runs, 0 once started", () => {
    const { project } = setup();
    const down = wannabe(project, ["app", "ready", "--in", "local"]);
    expect(down.code).toBe(1);
    expect(down.stderr).toContain("not running");
    wannabe(project, ["app", "running", "--to", "local"]);
    expect(wannabe(project, ["app", "ready", "--in", "local"]).code).toBe(0);
  }, 30000);

  test("tells live but not ready apart", async () => {
    const { project, port } = setup("unready");
    strays.push(Bun.spawn([process.execPath, "fake.ts", String(port), "unready"], { cwd: project, stdout: "ignore" }));
    for (let i = 0; i < 50 && !(await fetch(`http://localhost:${port}/live`).then((r) => r.ok, () => false)); i++) await Bun.sleep(100);
    const run = wannabe(project, ["app", "ready", "--in", "local"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("live but not ready (not started by wannabe)");
  }, 30000);

  test("answers for an app it did not start", async () => {
    const { project, port } = setup();
    await foreign(project, port);
    const run = wannabe(project, ["app", "ready", "--in", "local"]);
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("not started by wannabe");
  }, 30000);
});

describe("app stopped", () => {
  test("stops what it started and frees the port; again does nothing", async () => {
    const { project, port } = setup();
    wannabe(project, ["app", "running", "--to", "local"]);
    const run = wannabe(project, ["app", "stopped", "--to", "local"]);
    expect(run.code).toBe(0);
    expect(await fetch(`http://localhost:${port}/ready`).then(() => true, () => false)).toBe(false);
    const again = wannabe(project, ["app", "stopped", "--to", "local"]);
    expect(again.code).toBe(0);
    expect(again.stderr).toContain("nothing started by wannabe");
  }, 30000);

  test("leaves an app it did not start running", async () => {
    const { project, port } = setup();
    await foreign(project, port);
    expect(wannabe(project, ["app", "stopped", "--to", "local"]).code).toBe(0);
    expect(await fetch(`http://localhost:${port}/ready`).then((r) => r.ok, () => false)).toBe(true);
  }, 30000);
});

describe("app reloaded", () => {
  test("restarts what it started with a new pid", () => {
    const { project } = setup();
    wannabe(project, ["app", "running", "--to", "local"]);
    const before = readFileSync(join(project, ".wannabe/local/.state/app.pid"), "utf8");
    const run = wannabe(project, ["app", "reloaded", "--to", "local"]);
    expect(run.code).toBe(0);
    expect(readFileSync(join(project, ".wannabe/local/.state/app.pid"), "utf8")).not.toBe(before);
  }, 30000);

  test("refuses with 3 an app it did not start", async () => {
    const { project, port } = setup();
    await foreign(project, port);
    expect(wannabe(project, ["app", "reloaded", "--to", "local"]).code).toBe(3);
  }, 30000);
});

describe("app errors", () => {
  test("prints the error lines since the last start, colours stripped, on stdout", () => {
    const { project } = setup();
    expect(wannabe(project, ["app", "errors", "--in", "local"]).stdout).toBe("");
    wannabe(project, ["app", "running", "--to", "local"]);
    const run = wannabe(project, ["app", "errors", "--in", "local"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("ERROR something went wrong along the way\n");
  }, 30000);
});
