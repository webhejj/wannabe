/**
 * What the app commands share: running an application on this computer from .wannabe/<context>/app.yaml,
 * knowing whether wannabe started it, and whether it answers.
 *
 * State lives in .wannabe/<context>/.state/, which ignores itself in git: the pid of what wannabe started, and
 * the application's log since that start.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capture, die, get, getList, getOptional, projectDir, say, wannabeDir } from "./plugin.ts";

export interface App {
  context: string;
  command: string[];
  readiness: string;
  liveness?: string;
  /** The port the readiness URL is on, where the application listens. */
  port: number;
  startTimeoutSeconds: number;
  /** What a person opens: spec.endpoints.app in context.yaml, or the readiness URL's origin. */
  url: string;
  stateDir: string;
  pidFile: string;
  logFile: string;
}

/** The context's application; exit 3 when the context has no app.yaml. */
export async function app(context: string): Promise<App> {
  if (!existsSync(join(wannabeDir, context, "app.yaml"))) {
    if (existsSync(join(wannabeDir, context, "deployment.yaml"))) {
      die(3, `wannabe does not run the app in '${context}'; it is deployed: wannabe deployment running --to ${context}`);
    }
    die(3, `context '${context}' has no app.yaml; wannabe does not run an app there`);
  }
  const file = `${context}/app`;
  const readiness = await get(file, "spec.readiness");
  const parsed = URL.parse(readiness) ?? die(1, `spec.readiness in .wannabe/${file}.yaml is not a URL: ${readiness}`);
  const port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
  const stateDir = join(wannabeDir, context, ".state");
  return {
    context,
    command: await getList(file, "spec.command"),
    readiness,
    liveness: await getOptional(file, "spec.liveness"),
    port,
    startTimeoutSeconds: Number((await getOptional(file, "spec.startTimeoutSeconds")) ?? 300),
    url: (await getOptional(`${context}/context`, "spec.endpoints.app")) ?? parsed.origin,
    stateDir,
    pidFile: join(stateDir, "app.pid"),
    logFile: join(stateDir, "app.log"),
  };
}

/** The pid wannabe started, while that process is still alive. */
export function ownedPid(a: App): number | undefined {
  if (!existsSync(a.pidFile)) return undefined;
  const pid = Number(readFileSync(a.pidFile, "utf8").trim());
  return pid > 0 && alive(pid) ? pid : undefined;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The pids listening on the application's port, whoever started them. */
export function listeners(a: App): number[] {
  const result = capture(["lsof", "-nP", `-iTCP:${a.port}`, "-sTCP:LISTEN", "-t"]);
  return result.stdout.split("\n").filter(Boolean).map(Number);
}

/**
 * Whether a URL answers 200 within two seconds. curl, not fetch: Bun's fetch to localhost opens a second
 * connection and drops it, which Tomcat logs as an ERROR on every probe.
 */
export async function answers(url: string): Promise<boolean> {
  return capture(["curl", "-s", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "2", url]).stdout === "200";
}

/** Starts the command in the background with a fresh log, records its pid, and returns it. */
export function start(a: App): number {
  mkdirSync(a.stateDir, { recursive: true });
  writeFileSync(join(a.stateDir, ".gitignore"), "*\n");
  const log = openSync(a.logFile, "w");
  // detached: its own process group, so it outlives this plugin and can be stopped as a whole.
  const child = spawn(a.command[0], a.command.slice(1), {
    cwd: projectDir,
    detached: true,
    stdio: ["ignore", log, log],
    env: process.env,
  });
  if (!child.pid) die(1, `could not start: ${a.command.join(" ")}`);
  child.unref();
  writeFileSync(a.pidFile, `${child.pid}\n`);
  return child.pid;
}

/**
 * Waits until the readiness URL answers. Fails as soon as the started process exits, instead of waiting out
 * the timeout. Returns whether it became ready.
 */
export async function waitReady(a: App, pid: number): Promise<boolean> {
  const deadline = Date.now() + a.startTimeoutSeconds * 1000;
  while (Date.now() < deadline) {
    if (await answers(a.readiness)) return true;
    if (!alive(pid)) {
      say(`it exited before it was ready; the log is ${a.logFile}`);
      return false;
    }
    await Bun.sleep(1000);
  }
  say(`not ready after ${a.startTimeoutSeconds}s; the log is ${a.logFile}`);
  return false;
}

/**
 * Stops what wannabe started: its process group, then whatever it left listening on the port (a Gradle bootRun
 * forks the application's JVM from the Gradle daemon, outside that group). Returns whether the port is free.
 */
export async function stop(a: App, pid: number): Promise<boolean> {
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // already gone
  }
  await Bun.sleep(2000);
  for (const listener of listeners(a)) {
    try {
      process.kill(listener, "SIGTERM");
    } catch {
      // already gone
    }
  }
  rmSync(a.pidFile, { force: true });
  for (let i = 0; i < 10; i++) {
    if (listeners(a).length === 0) return true;
    await Bun.sleep(1000);
  }
  return false;
}

const ERROR = /\bERROR\b|^Caused by:|\bFAILED\b/;

/** The log's error lines since the last start, colours stripped. */
export function errorLines(a: App): string[] {
  if (!existsSync(a.logFile)) return [];
  return readFileSync(a.logFile, "utf8")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .split("\n")
    .filter((line) => ERROR.test(line));
}

/** Prints the log's error lines to stderr, under a heading; at most `limit` of them. */
export function reportErrors(a: App, heading: string, limit = 15): void {
  const lines = errorLines(a);
  if (lines.length === 0) return;
  say(heading);
  for (const line of lines.slice(0, limit)) say(`  ${line.slice(0, 400)}`);
  if (lines.length > limit) say(`  … ${lines.length - limit} more: wannabe app errors --in ${a.context}`);
}

/** Exit 3 when something wannabe did not start listens on the port. */
export function refuseForeign(a: App): void {
  const others = listeners(a);
  if (others.length > 0) {
    die(3, `something else listens on :${a.port} (pid ${others.join(", ")}; your IDE's run?). wannabe neither stops it nor starts another: restart it yourself`);
  }
}

/** Starts the app and waits for it; prints its URL on stdout when ready, exits 1 when not. */
export async function startAndWait(a: App): Promise<void> {
  say(`Starting: ${a.command.join(" ")} (log: ${a.logFile})`);
  const pid = start(a);
  const ready = await waitReady(a, pid);
  reportErrors(a, ready ? "Errors logged during startup:" : "Errors in the log:");
  if (!ready) process.exit(1);
  say(`Ready: ${a.readiness}`);
  console.log(a.url);
}
