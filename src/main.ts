import { dirname } from "node:path";
import { complete } from "./complete.ts";
import { helped, HelpError, listing } from "./help.ts";
import { descend, type Env, isDirectory, isExecutableFile, locate, makeEnv } from "./project.ts";
import { ExitError, FISH_COMPLETION, get, links, selfUsage, version, ZSH_COMPLETION } from "./self.ts";
import { updated } from "./update.ts";

/** wannabe's checkout: bin/ is one level below it. */
const HOME = dirname(import.meta.dir);

/**
 * `<name> <group>... <command> [args]` runs the plugin at <group>/.../<command> with the remaining arguments
 * as given; the built-ins are `helped` and `self`. Returns the exit code.
 */
export async function main(name: string, args: string[]): Promise<number> {
  if (name === "wannatry") process.env.WANNABE_DRY_RUN = "1";
  const env = makeEnv(name, HOME);
  process.env.WANNABE_HOME = env.home;
  if (env.project) {
    process.env.WANNABE_PROJECT_DIR = env.project;
    process.env.WANNABE_DIR = env.wannabeDir;
  }
  try {
    return await dispatch(env, args);
  } catch (error) {
    if (error instanceof ExitError) {
      if (error.message) console.error(error.message);
      return error.code;
    }
    if (error instanceof HelpError) {
      console.error(error.message);
      return 2;
    }
    throw error;
  }
}

async function dispatch(env: Env, args: string[]): Promise<number> {
  switch (args[0]) {
    case undefined:
    case "-h":
    case "--help":
      console.error(listing(env, ""));
      return 2;
    case "helped":
      console.log(helped(env, args.slice(1)));
      return 0;
    case "self":
      return self(env, args.slice(1));
    case "__complete":
      console.log(complete(env, args.slice(1)).join("\n"));
      return 0;
  }

  const { rel, consumed } = descend(env, args);
  const rest = args.slice(consumed);
  if (rest.length > 0) {
    const path = locate(env, rel ? `${rel}/${rest[0]}` : rest[0]);
    if (path && !isDirectory(path) && isExecutableFile(path)) {
      if (!env.project) throw new ExitError(`${env.name}: no .wannabe/ here or in any directory above`, 2);
      return run(path, rest.slice(1));
    }
    console.error(`${env.name}: no command '${rest[0]}' in ${rel ? rel.replaceAll("/", " ") : "the top level"}`);
  }
  console.error(listing(env, rel));
  return 2;
}

async function self(env: Env, args: string[]): Promise<number> {
  switch (args[0]) {
    case "installed":
    case "uninstalled":
      console.error(links(env, args[0], args.slice(1)).join("\n"));
      return 0;
    case "updated":
      console.error((await updated(env, args.slice(1))).join("\n"));
      return 0;
    case "completion": {
      const script = { zsh: ZSH_COMPLETION, fish: FISH_COMPLETION }[args[1] ?? ""];
      if (!script) throw new ExitError(`Usage: ${env.name} self completion zsh | fish`, 2);
      process.stdout.write(script);
      return 0;
    }
    case "get":
      console.log(await get(env, args.slice(1)));
      return 0;
    case "version":
      console.log(await version(env));
      return 0;
    default:
      if (args[0]) console.error(`${env.name}: no command 'self ${args[0]}'`);
      console.error(selfUsage());
      return 2;
  }
}

/** Runs a plugin with the terminal handed over; Ctrl-C reaches the plugin, and its exit code is ours. */
async function run(path: string, args: string[]): Promise<number> {
  const child = Bun.spawn([path, ...args], { stdio: ["inherit", "inherit", "inherit"], env: process.env });
  const ignore = () => {};
  process.on("SIGINT", ignore);
  try {
    return await child.exited;
  } finally {
    process.off("SIGINT", ignore);
  }
}
