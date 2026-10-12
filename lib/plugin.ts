/**
 * What wannabe's own plugins share, and what a plugin written in TypeScript can import:
 * argument parsing, configuration, dry runs, the exit codes, and running other commands.
 *
 * Exit codes: 0 success, 1 failure, 2 wrong call, 3 not possible in this context.
 */
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { formatValue, readValue } from "../src/config.ts";

export const home = process.env.WANNABE_HOME ?? join(import.meta.dir, "..");
export const projectDir = process.env.WANNABE_PROJECT_DIR ?? "";
export const wannabeDir = process.env.WANNABE_DIR ?? "";

/** The command's own name, e.g. "deployment synced", from where the plugin file sits. */
export const commandName = (() => {
  const script = process.argv[1] ?? "";
  for (const root of [join(wannabeDir, "plugins"), join(home, "plugins")]) {
    if (script.startsWith(root + "/")) return relative(root, script).split("/").join(" ");
  }
  return script;
})();

/** Prints to stderr, where everything meant for people goes. */
export function say(message: string): void {
  console.error(message);
}

/** Prints a message named for the command and exits with the code. */
export function die(code: number, message: string): never {
  say(`${commandName}: ${message}`);
  process.exit(code);
}

export interface Args {
  /** From --to, --from or --in: the last one given. */
  context: string;
  /** Each of --to, --from and --in that was given, for a command that reads one context and changes another. */
  contexts: Record<string, string>;
  dryRun: boolean;
  /** Flags that were given, of those declared. */
  flags: Set<string>;
  /** Values of options that take one, of those declared. */
  values: Record<string, string>;
  /** Words that are not options, when the plugin declares `positional`. */
  rest: string[];
}

/**
 * Parses --to/--from/--in <context> and --dry-run, plus the flags and options the plugin declares;
 * anything else is a wrong call. A dry run set here is passed on to commands run by step().
 */
export function parseArgs(
  argv: string[] = process.argv.slice(2),
  declared: { flags?: string[]; options?: string[]; positional?: boolean; context?: "required" | "none" } = {},
): Args {
  const args: Args = { context: "", contexts: {}, dryRun: process.env.WANNABE_DRY_RUN === "1", flags: new Set(), values: {}, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (["--to", "--from", "--in"].includes(arg) && declared.context !== "none") args.context = args.contexts[arg] = argv[++i] ?? "";
    else if (arg === "--dry-run") args.dryRun = true;
    else if (declared.flags?.includes(arg)) args.flags.add(arg);
    else if (declared.options?.includes(arg)) args.values[arg] = argv[++i] ?? die(2, `${arg} needs a value`);
    else if (declared.positional && !arg.startsWith("-")) args.rest.push(arg);
    else die(2, `unknown argument: ${arg}`);
  }
  if (args.dryRun) process.env.WANNABE_DRY_RUN = "1";
  if (declared.context !== "none") {
    if (!args.context) die(2, "which context? --to <context>");
    for (const context of Object.values(args.contexts)) {
      if (!existsSync(join(wannabeDir, context))) die(2, `no context '${context}' in ${wannabeDir}`);
    }
  }
  return args;
}

/** A value from .wannabe/<file>.yaml, as text; exits 1 when missing. */
export async function get(file: string, path: string): Promise<string> {
  const value = await readValue(wannabeDir, file, path);
  if (value === undefined) die(1, `no ${path} in .wannabe/${file}.yaml`);
  return formatValue(value);
}

/** The same, undefined when missing. */
export async function getOptional(file: string, path: string): Promise<string | undefined> {
  const value = await readValue(wannabeDir, file, path);
  return value === undefined ? undefined : formatValue(value);
}

/** A list value; a single value becomes a list of one. */
export async function getList(file: string, path: string): Promise<string[]> {
  const value = await readValue(wannabeDir, file, path);
  if (value === undefined) die(1, `no ${path} in .wannabe/${file}.yaml`);
  return Array.isArray(value) ? value.map(String) : [String(value)];
}

export interface Result {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command and captures its output; never prints, never exits. */
export function capture(command: string[], cwd = projectDir || process.cwd()): Result {
  const result = Bun.spawnSync(command, { cwd, stdout: "pipe", stderr: "pipe", env: process.env });
  return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
}

/**
 * Runs a command with its output on stderr, as progress for people; in a dry run only prints it.
 * Returns the exit code; fails the plugin on a non-zero one unless allowFailure.
 */
export async function run(command: string[], options: { cwd?: string; allowFailure?: boolean; tty?: boolean } = {}): Promise<number> {
  if (process.env.WANNABE_DRY_RUN === "1") {
    say(`dry run: ${command.join(" ")}`);
    return 0;
  }
  const child = Bun.spawn(command, {
    cwd: options.cwd ?? (projectDir || process.cwd()),
    stdio: ["inherit", options.tty ? "inherit" : 2, "inherit"],
    env: process.env,
  });
  const code = await child.exited;
  if (code !== 0 && !options.allowFailure) die(1, `failed (exit ${code}): ${command.join(" ")}`);
  return code;
}

/** The context's host, spec.endpoints.host in context.yaml; exit 3 without one. */
export async function host(context: string): Promise<string> {
  const value = await getOptional(`${context}/context`, "spec.endpoints.host");
  if (!value) die(3, `context '${context}' has no host; it is not deployed by wannabe`);
  return value;
}

/** The context's deployment directory, spec.dir in deployment.yaml, resolved against the project. */
export async function deployDir(context: string): Promise<string> {
  const dir = join(projectDir, await get(`${context}/deployment`, "spec.dir"));
  if (!existsSync(dir)) die(1, `deployment directory for ${context} not found: ${dir}`);
  return dir;
}

/** The root of the git repository holding a directory. */
export function repoRoot(dir: string): string {
  const result = capture(["git", "-C", dir, "rev-parse", "--show-toplevel"]);
  if (result.code !== 0) die(1, `${dir} is not in a git repository`);
  return result.stdout.trim();
}

/** Fetches the repository holding a directory; exits 1 when it has commits its checkout lacks. */
export function requireUpToDate(dir: string): string {
  const repo = repoRoot(dir);
  if (capture(["git", "-C", repo, "fetch", "--quiet"]).code !== 0) die(1, `cannot fetch ${repo}`);
  const incoming = capture(["git", "-C", repo, "log", "--oneline", "HEAD..@{u}"]);
  if (incoming.code === 0 && incoming.stdout.trim()) {
    say(incoming.stdout.trim());
    die(1, `${repo} has incoming commits; pull them first`);
  }
  return repo;
}

/** Runs another wannabe command; on failure names it and stops. Its stdout passes through. */
export async function step(...words: string[]): Promise<void> {
  say(`── wannabe ${words.join(" ")}`);
  const child = Bun.spawn([join(home, "bin", "wannabe"), ...words], { stdio: ["inherit", "inherit", "inherit"], env: process.env });
  if ((await child.exited) !== 0) {
    say(`Stopped at: wannabe ${words.join(" ")}`);
    say("Fix it, then continue from that step by hand.");
    process.exit(1);
  }
}

/** Runs the Gradle tasks .wannabe/gradle.yaml lists for a command of the gradle group. */
export async function gradle(command: string): Promise<void> {
  parseArgs(process.argv.slice(2), { context: "none" });
  const tasks = await readValue(wannabeDir, "gradle", `spec.tasks.${command}`);
  if (tasks === undefined) die(3, `no Gradle tasks for '${command}' in .wannabe/gradle.yaml`);
  const list = Array.isArray(tasks) ? tasks.map(String) : [String(tasks)];
  const gradlew = existsSync(join(projectDir, "gradlew")) ? "./gradlew" : "gradle";
  await run([gradlew, ...list]);
}
