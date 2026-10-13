import { existsSync, lstatSync, mkdirSync, readlinkSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { formatValue, readValue } from "./config.ts";
import type { Env } from "./project.ts";

export const SELF_COMMANDS = ["installed", "uninstalled", "updated", "completion", "get", "version"];
const COMMANDS = ["wannabe", "wannado", "wannatry"];

export function selfUsage(): string {
  return [
    "Commands in self (built-in):",
    "  installed    [--into <dir>] [--force] — link wannabe, wannado and wannatry into <dir>, ~/.local/bin by default",
    "  uninstalled  [--into <dir>] — remove those links, when they point to this checkout",
    "  updated      [--check] — fast-forward this checkout to its upstream, then run what the change needs",
    "  completion   zsh | fish — print that shell's completion; 'self installed' names the line to add",
    "  get          <file> <path> — a value from .wannabe/<file>.yaml, e.g. get test/deployment spec.dir",
    "  version      — this checkout's version and commit, and whether it has local changes",
  ].join("\n");
}

/** An error carrying the exit code wannabe should end with. */
export class ExitError extends Error {
  constructor(
    message: string,
    readonly code: number,
  ) {
    super(message);
  }
}

function linkTarget(path: string): string | undefined {
  try {
    return lstatSync(path).isSymbolicLink() ? readlinkSync(path) : undefined;
  } catch {
    return undefined;
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/** self installed / uninstalled: each command linked, into a directory, to this checkout's bin/. */
export function links(env: Env, action: "installed" | "uninstalled", args: string[]): string[] {
  let into = join(homedir(), ".local", "bin");
  let force = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--into" && args[i + 1]) into = args[++i];
    else if (args[i] === "--force" && action === "installed") force = true;
    else throw new ExitError(`${env.name} self ${action}: unknown argument: ${args[i]}`, 2);
  }
  const report: string[] = [];
  if (action === "installed") mkdirSync(into, { recursive: true });
  for (const command of COMMANDS) {
    const link = join(into, command);
    const target = join(env.home, "bin", command);
    const current = linkTarget(link);
    if (action === "installed") {
      if (current === target) {
        report.push(`${link}: already linked`);
      } else if (exists(link)) {
        if (!force) {
          throw new ExitError(
            `${env.name} self installed: ${link} exists${current ? ` and points to ${current}` : ""}; pass --force to replace it`,
            1,
          );
        }
        rmSync(link);
        symlinkSync(target, link);
        report.push(`${link}: replaced, -> ${target}`);
      } else {
        symlinkSync(target, link);
        report.push(`${link} -> ${target}`);
      }
    } else if (current === target) {
      rmSync(link);
      report.push(`${link}: removed`);
    } else if (exists(link)) {
      report.push(`${link}: left alone, it is not a link to this checkout`);
    }
  }
  if (action === "installed") {
    if (!(process.env.PATH ?? "").split(delimiter).includes(into)) report.push(`Warning: ${into} is not on PATH`);
    report.push(
      (process.env.SHELL ?? "").endsWith("/fish")
        ? "For completion, add to ~/.config/fish/config.fish: wannabe self completion fish | source"
        : "For completion, add to ~/.zshrc: source <(wannabe self completion zsh)",
    );
  }
  return report;
}

export const ZSH_COMPLETION = `# wannabe completion for zsh: asks the wannabe being completed, so one registration serves every project.
_wannabe() {
    local -a candidates
    candidates=("\${(@f)$(\${words[1]} __complete "\${(@)words[2,CURRENT]}" 2>/dev/null)}")
    if [[ "\${candidates[1]}" == __dirs__ ]]; then
        _path_files -/
    else
        compadd -a candidates
    fi
}
# compdef comes with zsh's completion system; load it when this shell has not.
(( $+functions[compdef] )) || { autoload -Uz compinit && compinit; }
compdef _wannabe wannabe wannado wannatry
`;

export const FISH_COMPLETION = `# wannabe completion for fish: asks the wannabe being completed, so one registration serves every project.
function __wannabe_complete
    set -l words (commandline -opc)
    set -q words[1]; or return
    # The word being completed is passed along too, empty or not: it is the position being asked about.
    set -l current (commandline -ct)
    set -l candidates ($words[1] __complete $words[2..] "$current" 2>/dev/null | string match -er .)
    if test "$candidates[1]" = __dirs__
        __fish_complete_directories
    else
        string join \\n -- $candidates
    end
end
complete -c wannabe -f -a '(__wannabe_complete)'
complete -c wannado -f -a '(__wannabe_complete)'
complete -c wannatry -f -a '(__wannabe_complete)'
`;

/** self version: the package version, and the checkout's commit when it is a git checkout. */
export async function version(env: Env): Promise<string> {
  const pkg = await Bun.file(join(env.home, "package.json")).json();
  if (!existsSync(join(env.home, ".git"))) return pkg.version;
  const described = Bun.spawnSync(["git", "-C", env.home, "describe", "--always", "--dirty"]);
  if (described.exitCode !== 0) return `${pkg.version} (no commits yet)`;
  return `${pkg.version} (${described.stdout.toString().trim()})`;
}

/** self get <file> <path>. */
export async function get(env: Env, args: string[]): Promise<string> {
  if (!env.wannabeDir) throw new ExitError(`${env.name}: no .wannabe/ here or in any directory above`, 2);
  if (args.length !== 2) throw new ExitError(`Usage: ${env.name} self get <file> <path>`, 2);
  const value = await readValue(env.wannabeDir, args[0], args[1]);
  if (value === undefined) throw new ExitError("", 1);
  return formatValue(value);
}
