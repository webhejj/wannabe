import { children, contexts, describe, descend, type Env, locate } from "./project.ts";
import { SELF_COMMANDS } from "./self.ts";

/** Candidates for the last of words, which is the word being completed. */
export function complete(env: Env, all: string[]): string[] {
  const words = all.slice(0, -1);
  const previous = words.at(-1) ?? "";

  if (words[0] === "helped") {
    const rest = words.slice(1);
    const { rel, consumed } = descend(env, rest);
    if (consumed < rest.length) return [];
    return rel ? children(env, rel) : [...children(env, ""), "self"];
  }
  if (words[0] === "self") {
    if (words.length === 1) return SELF_COMMANDS;
    if (previous === "--into") return ["__dirs__"];
    if (words[1] === "installed") return ["--into", "--force"];
    if (words[1] === "uninstalled") return ["--into"];
    if (words[1] === "updated") return ["--check"];
    if (words[1] === "completion" && words.length === 2) return ["zsh", "fish"];
    return [];
  }

  const { rel, consumed } = descend(env, words);
  if (consumed === words.length) return rel ? children(env, rel) : [...children(env, ""), "helped", "self"];
  if (["--to", "--from", "--in"].includes(previous)) return contexts(env);
  const path = locate(env, rel ? `${rel}/${words[consumed]}` : words[consumed]);
  if (!path) return [];
  return [...new Set(describe(path).match(/--[a-z-]+/g) ?? [])].sort();
}
