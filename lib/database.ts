/**
 * What the database commands share: which commands a context allows, dumps (where they come from, which is
 * the newest, whether one is complete), and running the project's psql and Flyway.
 *
 * Reads .wannabe/<context>/database.yaml. The project says how to reach its tools (spec.psql, spec.flyway);
 * wannabe keeps the rules that hold for any project.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { readValue } from "../src/config.ts";
import { capture, commandName, die, get, getOptional, projectDir, say, wannabeDir } from "./plugin.ts";

/** Exit 3 unless the context's database.yaml allows this command, with the context's own reason when it has one. */
export async function requireAllowed(context: string): Promise<void> {
  if (!existsSync(join(wannabeDir, context, "database.yaml"))) {
    die(3, `context '${context}' has no database.yaml; wannabe does not touch its database`);
  }
  const allow = ((await readValue(wannabeDir, `${context}/database`, "spec.allow")) as unknown[] | undefined) ?? [];
  if (allow.map(String).includes(commandName)) return;
  const otherwise = await getOptional(`${context}/database`, "spec.otherwise");
  die(3, `not allowed in '${context}'${otherwise ? `: ${otherwise}` : ` (spec.allow in .wannabe/${context}/database.yaml)`}`);
}

/** The pattern a context's dumps are named by, spec.dumps.name. */
export async function dumpName(context: string): Promise<RegExp> {
  return new RegExp(await get(`${context}/database`, "spec.dumps.name"));
}

/** A context's dump directory, spec.dumps.dir, resolved against the project. */
export async function dumpDir(context: string): Promise<string> {
  const dir = await get(`${context}/database`, "spec.dumps.dir");
  return isAbsolute(dir) ? dir : join(projectDir, dir);
}

/** Where a context's dumps are fetched from, spec.dumps.from: "host:dir" over ssh, or a directory. */
export interface DumpSource {
  host?: string;
  dir: string;
}

export async function dumpSource(context: string): Promise<DumpSource> {
  const from = await getOptional(`${context}/database`, "spec.dumps.from");
  if (!from) die(3, `context '${context}' has no dumps to fetch (spec.dumps.from in .wannabe/${context}/database.yaml)`);
  const remote = /^([^/:]+):(.*)$/.exec(from);
  return remote ? { host: remote[1], dir: remote[2] } : { dir: isAbsolute(from) ? from : join(projectDir, from) };
}

/** The dump names at a source matching the pattern, newest first: names sort by their timestamp. */
export function sourceDumps(source: DumpSource, name: RegExp): string[] {
  let names: string[];
  if (source.host) {
    const listing = capture(["ssh", source.host, `ls '${source.dir}'`]);
    if (listing.code !== 0) die(1, `cannot list ${source.host}:${source.dir}: ${listing.stderr.trim()}`);
    names = listing.stdout.split("\n");
  } else {
    if (!existsSync(source.dir)) die(1, `${source.dir} not found`);
    names = readdirSync(source.dir);
  }
  return names.filter((n) => name.test(n)).sort().reverse();
}

/** The dumps in a directory matching the pattern, newest first. Read from the directory, never from ls output. */
export function localDumps(dir: string, name: RegExp): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => name.test(n)).sort().reverse();
}

/**
 * Whether a dump is complete: a .gz dump passes gzip -t; anything else is taken as it is. Judged by the dump's
 * name, not the path, which may be a download's .part file.
 */
export function complete(path: string, name = path): boolean {
  return !name.endsWith(".gz") || capture(["gzip", "-t", path]).code === 0;
}

/**
 * Leaves a complete copy of the named dump in dir and returns true, or leaves nothing and returns false. A dump
 * already there is kept when complete; a fetched one is checked before it takes the name.
 */
export function fetchDump(source: DumpSource, file: string, dir: string): boolean {
  const target = join(dir, file);
  if (existsSync(target)) {
    if (complete(target)) {
      say(`Already have ${target}`);
      return true;
    }
    say(`Removing ${target}: not complete`);
    rmSync(target);
  }
  mkdirSync(dir, { recursive: true });
  const part = `${target}.part`;
  rmSync(part, { force: true });
  if (source.host) {
    say(`Fetching ${file} from ${source.host}`);
    const copy = Bun.spawnSync(["scp", "-q", `${source.host}:${source.dir}/${file}`, part], { stdio: ["ignore", 2, 2] });
    if (copy.exitCode !== 0) die(1, `scp failed for ${file}`);
  } else {
    say(`Copying ${file} from ${source.dir}`);
    copyFileSync(join(source.dir, file), part);
  }
  if (complete(part, file)) {
    renameSync(part, target);
    return true;
  }
  rmSync(part, { force: true });
  say(`${file} is not complete at the source (still being written or synced there?)`);
  return false;
}

/** A path for people and for stdout: relative to the project when it is inside it. */
export function shown(path: string): string {
  return path.startsWith(projectDir + "/") ? path.slice(projectDir.length + 1) : path;
}
