import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, scratch, wannabe, write } from "./helpers.ts";

const COMPOSE = "services:\n  app:\n    image: registry.example.com/app:1\n";

/** A project beside an infra repository with an upstream, the way wannabe expects to find them. */
function setup(): { project: string; infra: string; origin: string } {
  const root = scratch();
  const seed = join(root, "seed");
  write(seed, { "test/app/compose.yml": COMPOSE, "prod/app/compose.yml": COMPOSE });
  git(seed, "init", "-q", "-b", "main");
  git(seed, "add", ".");
  git(seed, "commit", "-q", "-m", "seed");
  git(root, "clone", "-q", "--bare", seed, "origin.git");
  git(root, "clone", "-q", join(root, "origin.git"), "infra");
  const project = join(root, "app");
  write(project, {
    ".wannabe/test/context.yaml": "kind: Context\nspec:\n  endpoints: {}\n",
    ".wannabe/test/deployment.yaml":
      "kind: Deployment\nspec:\n  dir: ../infra/test/app\n  files: [compose.yml]\n  service: app\n  remoteDir: /x\n  readiness: http://x\n",
  });
  return { project, infra: join(root, "infra"), origin: join(root, "origin.git") };
}

const pin = (infra: string, tag: string, env = "test") => {
  const path = join(infra, env, "app", "compose.yml");
  writeFileSync(path, readFileSync(path, "utf8").replace(/app:\S+/, `app:${tag}`));
};

describe("deployment pinned", () => {
  test("pins to --tag, and refuses a last build of another image", () => {
    const { project, infra } = setup();
    expect(wannabe(project, ["deployment", "pinned", "--to", "test", "--tag", "2"]).code).toBe(0);
    expect(readFileSync(join(infra, "test/app/compose.yml"), "utf8")).toContain("app:2");

    write(project, { "build/jib-image.json": JSON.stringify({ image: "local/app:3", imagePushed: true }) });
    const refused = wannabe(project, ["deployment", "pinned", "--to", "test"]);
    expect(refused.code).toBe(1);
    expect(refused.stderr).toContain("the last build is local/app:3");
  });

  test("refuses when the infra repo is behind its upstream", () => {
    const { project, infra, origin } = setup();
    const other = join(origin, "..", "other");
    git(join(origin, ".."), "clone", "-q", origin, "other");
    pin(other, "5", "prod");
    git(other, "commit", "-q", "-am", "someone else");
    git(other, "push", "-q");
    const run = wannabe(project, ["deployment", "pinned", "--to", "test", "--tag", "2"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("incoming commits");
    expect(readFileSync(join(infra, "test/app/compose.yml"), "utf8")).toContain("app:1");
  });
});

describe("deployment committed", () => {
  test("commits only the context's files, even with others staged", () => {
    const { project, infra } = setup();
    pin(infra, "2");
    pin(infra, "9", "prod");
    git(infra, "add", "prod/app/compose.yml");
    expect(wannabe(project, ["deployment", "committed", "--to", "test"]).code).toBe(0);
    expect(git(infra, "log", "-1", "--format=%s")).toBe("Release app:2 to TEST");
    expect(git(infra, "show", "--name-only", "--format=", "HEAD")).toBe("test/app/compose.yml");
    expect(git(infra, "diff", "--cached", "--name-only")).toBe("prod/app/compose.yml");
  });

  test("--push pushes, and a rerun has nothing to do", () => {
    const { project, infra } = setup();
    pin(infra, "2");
    expect(wannabe(project, ["deployment", "committed", "--to", "test", "--push"]).code).toBe(0);
    expect(git(infra, "rev-list", "--count", "@{u}..HEAD")).toBe("0");
    const again = wannabe(project, ["deployment", "committed", "--to", "test", "--push"]);
    expect(again.code).toBe(0);
    expect(again.stderr).toContain("Nothing to commit");
    expect(again.stderr).toContain("Nothing to push");
  });

  test("--push refuses an unpushed commit that touches other files", () => {
    const { project, infra } = setup();
    pin(infra, "9", "prod");
    git(infra, "commit", "-q", "-am", "prod change");
    pin(infra, "2");
    const run = wannabe(project, ["deployment", "committed", "--to", "test", "--push"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("prod/app/compose.yml");
    expect(git(infra, "log", "-1", "--format=%s")).toBe("Release app:2 to TEST");
    expect(git(infra, "rev-list", "--count", "@{u}..HEAD")).toBe("2");
  });

  test("a context without a host is not deployed by wannabe", () => {
    const { project } = setup();
    const run = wannabe(project, ["deployment", "synced", "--to", "test"]);
    expect(run.code).toBe(3);
    expect(run.stderr).toContain("has no host");
  });

  test("deployment stopped, too, leaves a context without a host alone", () => {
    const { project } = setup();
    const run = wannabe(project, ["deployment", "stopped", "--to", "test"]);
    expect(run.code).toBe(3);
    expect(run.stderr).toContain("has no host");
  });
});
