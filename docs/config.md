# Configuration reference

A project keeps its configuration in `.wannabe/` at its root. wannabe finds it by walking up from the working
directory, so every command works from anywhere inside the project.

```
.wannabe/
  gradle.yaml            # GradleBuild
  docker.yaml            # DockerImage
  secrets.yaml           # Secrets
  <context>/
    context.yaml         # Context
    deployment.yaml      # Deployment
  plugins/               # optional: the project's own commands
```

Every file is one resource: `apiVersion`, `kind`, `metadata.name`, `spec`. Only `spec` is read today; the other
fields name what the file is and leave room to change a kind's shape later.

Paths are relative to the project root. Nothing in these files may be machine-specific or secret: they are meant
to be committed, and read the same on every checkout.

## Context

`.wannabe/<context>/context.yaml`. The directory's name is the context's name — what `--to`, `--from` and `--in`
take.

```yaml
apiVersion: wannabe/v1alpha1
kind: Context
metadata:
  name: test
spec:
  endpoints:
    app: https://app.test.example.com
    host: deploy@test-host.example.com
```

| Field                 | Used by                                           | Meaning                                                                                                                                    |
|-----------------------|---------------------------------------------------|--------------------------------------------------------------------------------------------------------------------------------------------|
| `spec.endpoints.app`  | `app running`                                     | Where the application is served. `app running` prints it once the app is ready                                                             |
| `spec.endpoints.host` | `deployment synced`, `pulled`, `running`, `ready` | The ssh target running the application. **Without it, the context is not deployed by wannabe**, and those commands answer with exit code 3 |

## Application

`.wannabe/<context>/app.yaml`: how wannabe runs the application on this computer, for the `app` commands. Only a
context run on the developer's own computer has one, usually `local`; in any other context the `app` commands
answer with exit code 3.

```yaml
apiVersion: wannabe/v1alpha1
kind: Application
metadata:
  name: my-app
spec:
  command: [./gradlew, bootRun, "--args=--spring.devtools.restart.trigger-file=reloadtrigger"]
  reloadCommand: [sh, -c, "./gradlew classes -q && date > build/resources/main/reloadstamp && date > build/resources/main/reloadtrigger"]
  readiness: http://localhost:8080/actuator/health/readiness
  liveness: http://localhost:8080/actuator/health/liveness
  startTimeoutSeconds: 300
```

| Field                      | Used by                         | Meaning                                                                                                                                                                       |
|----------------------------|---------------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `spec.command`             | `running`, `reloaded`           | The command that runs the application, as a list, from the project root. It must build what changed itself, as `bootRun` does: without `reloadCommand`, `reloaded` is a stop and a start |
| `spec.reloadCommand`       | `reloaded`                      | Optional. A command that makes the running application restart itself in place, such as compiling and touching a Spring devtools trigger file. `reloaded` runs it, then waits for the readiness URL to stop answering and answer again. When the command fails (a compile error), the application keeps running what it ran before; when the readiness URL never stops answering within 10 seconds, `reloaded` fails with "no restart seen" |
| `spec.readiness`           | `running`, `reloaded`, `ready`  | A URL that answers 200 once the application serves. Its port is where the application listens: wannabe refuses to start a second one when something else is listening there |
| `spec.liveness`            | `ready`                         | Optional. A URL that answers 200 while the application is alive; only used to say why it is not ready                                                                        |
| `spec.startTimeoutSeconds` | `running`, `reloaded`           | How long to wait for readiness; 300 when left out                                                                                                                             |

The commands:

```
wannabe app running --to local    # start in the background and wait until ready; prints the URL. Again: nothing changes
wannabe app ready --in local      # exit 0 when ready, 1 when not, saying whether it runs at all
wannabe app reloaded --to local   # run the reloadCommand, or stop and start again, so it runs the current code
wannabe app stopped --to local    # stop what wannabe started; anything else on the port is left alone
wannabe app errors --in local     # the error lines logged since the last start or reload, on stdout
```

wannabe only stops what it started. When something else listens on the port, such as a run from the IDE,
`running` and `reloaded` answer with exit code 3 and leave it alone. The pid and the log are kept in
`.wannabe/<context>/.state/`, which ignores itself in git.

## Deployment

`.wannabe/<context>/deployment.yaml`: where the context's deployment files are, and how the service runs.

```yaml
apiVersion: wannabe/v1alpha1
kind: Deployment
metadata:
  name: my-app
spec:
  dir: ../my-app-infra/test/app
  files: [compose.yml]
  remoteDir: /opt/docker/app
  service: my-app
  readiness: http://localhost:8080/actuator/health/readiness
  readinessTimeoutSeconds: 180
```

| Field                          | Used by                                | Meaning                                                                                                               |
|--------------------------------|----------------------------------------|-----------------------------------------------------------------------------------------------------------------------|
| `spec.dir`                     | `pinned`, `synced`, `committed`        | The compose directory, usually in a separate infra repository beside the project. Its git repository is found from it |
| `spec.files`                   | `pinned`, `committed`                  | The files in `dir` whose `image:` line a release rewrites, and that `committed` commits                               |
| `spec.remoteDir`               | `synced`, `pulled`, `running`, `ready` | Where `dir` is copied to on the host                                                                                  |
| `spec.service`                 | `pinned`, `pulled`, `running`, `ready` | The compose service                                                                                                   |
| `spec.readiness`               | `ready`                                | A URL polled **on the host** until it answers                                                                         |
| `spec.readinessTimeoutSeconds` | `ready`                                | How long to wait; 180 when left out                                                                                   |

## DockerImage

`.wannabe/docker.yaml`.

```yaml
apiVersion: wannabe/v1alpha1
kind: DockerImage
metadata:
  name: my-app
spec:
  pushTasks: [jib]
  registry:                       # optional
    host: registry.example.com
    usernameSecret: registry-username
    passwordSecret: registry-token
```

| Field                         | Used by         | Meaning                                                                                                                                                                                                  |
|-------------------------------|-----------------|----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `spec.pushTasks`              | `docker pushed` | Gradle tasks that build and push the image. They must write `build/jib-image.json`, as Jib does, from which the image and its tag are read                                                               |
| `spec.registry.host`          | `docker pushed` | The registry to sign in to. Without `spec.registry`, the push uses the Docker login already on the computer                                                                                              |
| `spec.registry.usernameSecret`, `passwordSecret` | `docker pushed` | The names of two [secrets](#secrets), not their values. The push signs in with them from a scratch Docker configuration, which holds the user's own configuration too and is removed afterwards |

## GradleBuild

`.wannabe/gradle.yaml`.

```yaml
apiVersion: wannabe/v1alpha1
kind: GradleBuild
metadata:
  name: my-app
spec:
  tasks:
    built: [bootJar]
    cleaned: [clean]
    tested: [test]
```

| Field                  | Used by            | Meaning                                                                                       |
|------------------------|--------------------|-----------------------------------------------------------------------------------------------|
| `spec.tasks.<command>` | `gradle <command>` | The Gradle tasks `wannabe gradle <command>` runs. A command left out answers with exit code 3 |

The commands wannabe ships are `built`, `cleaned`, `tested` and `unit-tested`.

## Reading values

`wannabe self get <file> <path>` prints one value, for scripts and plugins:

```bash
wannabe self get test/deployment spec.service     # my-app
wannabe self get gradle spec.tasks.built          # one task per line
```

It exits with 1 when the value is missing.

## Secrets

`.wannabe/secrets.yaml`. Names the secrets a project needs, and never holds one: the file is committed.

```yaml
apiVersion: wannabe/v1alpha1
kind: Secrets
metadata:
  name: my-app
spec:
  registry-username: {}
  registry-token:
    description: Registry token with push rights, from the Azure portal
  vault-token:
    command: [op, read, "op://Shelton/registry/token"]
```

| Field                      | Meaning                                                                                              |
|----------------------------|------------------------------------------------------------------------------------------------------|
| `spec.<name>.description`  | Shown when the secret is missing or being stored                                                     |
| `spec.<name>.command`      | A command, as a list, whose output is the value. Only for a secret that something else already keeps |

A secret is looked up in this order, and the first that has it wins:

1. The environment variable `WANNABE_SECRET_<NAME>`: the name upper-cased, anything but letters and digits as `_`
   (`registry-token` is `WANNABE_SECRET_REGISTRY_TOKEN`). For CI.
2. The secret's `command`, when it declares one.
3. This computer's secret store: Keychain on macOS, libsecret on Linux, Credential Manager on Windows.
   `wannabe secret stored <name>` puts a value there. Each project has its own space in it, so two projects can use
   the same name.

```
wannabe secret stored registry-token      # prompts, hidden; or: pbpaste | wannabe secret stored registry-token
wannabe secret checked                    # which declared secrets are found, and where; never prints a value
wannabe secret forgotten registry-token   # removes it from the store
```

On Linux the store needs a desktop session with a running secret service. Without one (a server, a container),
`stored` says so, and the environment variable is the way.
