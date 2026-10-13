# wannabe

Desired-state operations without a cluster: say what you want to be true of an environment, in commands shaped
like Kubernetes' model — a context per environment, small typed resources, a plugin per command.

```bash
wannabe released --to test                    # gradle built, docker pushed, deployment pinned
wannabe deployed --to test                    # deployment synced, pulled, running, ready
wannabe deployment committed --to test --push # once test is verified
wannatry deployed --to test                   # the same, as a dry run
```

Every step is also its own command, so a chain that fails half-way is continued by hand from where it stopped.
`wannabe helped` explains them all, and `wannabe helped deployment synced` one in detail.

## Why

Deploy scripts tend to hard-code their environment: the host, the directory, the service, the URL, written again
in every script. wannabe keeps those facts in one place per environment, in the application's repository, and
gives each operation a small command that reads them. It borrows Kubernetes' shape — contexts, typed
resources, plugins — so the configuration and the habits carry over if the application moves to a cluster.
[docs/design.md](docs/design.md) has the reasoning, and the tools weighed against it.

**Status: early.** It runs one application's releases and test deployments: a Gradle build, an image pushed with
Jib, Docker Compose on a host reached over ssh. Command names and the configuration may still change.

## Install

Requires [Bun](https://bun.sh), and git, ssh and rsync for the commands that use them. From a checkout:

```bash
~/path/to/wannabe/bin/wannabe self installed [--into <dir>] [--force]
source <(wannabe self completion zsh)      # in ~/.zshrc
wannabe self completion fish | source      # in ~/.config/fish/config.fish
```

This links `wannabe`, `wannado` and `wannatry` into `~/.local/bin`, or `<dir>`. Running it again changes
nothing; `wannabe self uninstalled` removes the links, only where they point to this checkout.

`wannabe self updated` fast-forwards the checkout to its upstream, runs `bun install` when the dependencies
changed and the repository's `scripts/post-update` when there is one; `--check` only says whether there is an
update. It refuses local changes, and a checkout that has diverged.

## A project

A project keeps its configuration in `.wannabe/` at its root, found by walking up from the working directory:

```
.wannabe/
  gradle.yaml          # which Gradle tasks gradle built, cleaned and tested run
  docker.yaml          # which Gradle tasks build and push the image, and the secrets to sign in with
  secrets.yaml         # the names of the secrets the project needs (never their values)
  test/
    context.yaml       # where test is: the application's URL, the host to deploy to
    deployment.yaml    # the compose directory, the service, how readiness is checked
  plugins/             # optional: the project's own commands
```

[examples/compose-jib](examples/compose-jib) is a complete one to start from.

## Documentation

- [Concepts](docs/concepts.md) — contexts, resources, groups and commands, shortcuts, exit codes
- [Configuration](docs/config.md) — every file and field
- [Plugins](docs/plugins.md) — writing a command, and the contract it follows
- [Design](docs/design.md) — why it is shaped this way

`wannabe helped` and `wannabe self` are the two built-ins; every other name belongs to plugins.

## License

[Apache License 2.0](LICENSE).
