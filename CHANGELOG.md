# Changelog

## 0.1.0 — unreleased

First version, used for one application's releases and test deployments.

- Commands: `gradle built` · `cleaned` · `tested` · `unit-tested`, `docker pushed`, `deployment pinned` ·
  `synced` · `pulled` · `running` · `ready` · `committed`, and the shortcuts `released` and `deployed`.
- Plugins looked up in the project's `.wannabe/plugins/`, then in wannabe's own.
- `wannatry` for dry runs, `wannado` as another name.
- Built-ins: `helped`, and `self installed` · `uninstalled` · `updated` · `completion` · `get` · `version`.
- Completion for zsh and fish, both asking the wannabe being completed.
- Tests for dispatch, completion, compose editing and the deployment commands.
- Secrets: `.wannabe/secrets.yaml` names them and never holds them; a value comes from `WANNABE_SECRET_<NAME>`, the
  secret's own command, or the computer's secret store (Keychain, libsecret, Credential Manager, through
  `Bun.secrets`). `secret stored` · `checked` · `forgotten`, and `getSecret()` for plugins.
- `docker pushed` signs in to the registry named in `spec.registry` with two secrets, through a scratch Docker
  configuration for that push, instead of needing a Docker login on the computer.
- `app running` · `ready` · `reloaded` · `stopped` · `errors`: run the application on the developer's computer
  from `.wannabe/<context>/app.yaml`, wait for its readiness URL, stop only what wannabe started, and refuse
  (exit 3) when something else, such as an IDE's run, holds the port. With `spec.reloadCommand`, `reloaded`
  restarts the app in place and waits for its readiness URL to go down and come back.
- `database restored` · `refreshed` · `dump fetched` · `flyway applied` · `listed` · `validated` · `repaired`, from
  `.wannabe/<context>/database.yaml`: the project says how psql and Flyway reach its database; wannabe picks the
  newest complete dump by name, restores it, and answers 3 for any change the context does not `allow`.
- `deployment stopped`: `docker compose stop` for the service on the context's host, the counterpart of
  `deployment running`; like the other deployment commands, a context without a host answers 3.
- `database sql applied` · `package applied`: SQL files in the order given, or a directory's in file-name order, each with
  `ON_ERROR_STOP=1`, stopping at the first failing file and naming the ones not run.
