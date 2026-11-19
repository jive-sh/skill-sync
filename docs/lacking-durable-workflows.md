# Lacking durable workflows

Things an agent or a person still does by hand that a durable workflow should do. skill-sync is expected to
grow into agentic-sync, so the list lives here. Add an entry whenever something is done by hand; remove it in
the commit that builds the workflow.

Each entry: what is done by hand, what should replace it, and where that belongs.

## Agent guards run only as prose rules
- **By hand:** rules such as "quote his question before answering", "stay within the reply length cap" and
  "back every claim with a tool result" live only as text in synced skills, so they hold only when an agent
  rereads and obeys them.
- **Should be:** checks that run on every reply (hooks), synced to every machine the way skills are.
- **Belongs in:** skill-sync (agentic-sync), syncing hooks alongside skills.

## Cross-OS tests for daemons and auto-upgrade
- **By hand:** auto-upgrade (jive-abstract-library 0.1.8) was verified once by hand on macOS under launchd and
  in a Docker systemd container; Windows was never run. A package's CI runs on the one machine type its
  `jive.cicd.runsOn` names.
- **Should be:** CI that builds and tests a package on each OS it supports, only when that package changed.
- **Belongs in:** the Jive CI/CD contract and shared pipeline (jive-sh/jive), as a list of machine types to
  test on. Needs Alex's approval: it changes the pipeline every Jive package shares.

## Waiting for npm to serve a release's base package
- **By hand:** a release now waits for its platform packages to download before publishing the base package
  (jive-abstract-library 0.1.9), but not for the base package itself. Before installing jive-abstract-library
  0.1.9 into skill-sync, an agent polled its tarball URL until npm served it, about 6 minutes after the publish.
- **Should be:** the release finishes only once npm serves the base package too, so a dependent can install it
  as soon as the pipeline is green.
- **Belongs in:** jive-abstract-library's deploy code (the `jive:cicd:deploy` hook), after the base publish.

## First upgrade to a self-updating skill-sync
- **By hand:** machines on skill-sync 0.4.4 or older must run `skill-sync upgrade` once; only 0.4.5 and later
  upgrade themselves.
- **Should be:** nothing further once every machine is on 0.4.5. No workflow can reach the older versions.
- **Belongs in:** this list until each machine has upgraded.

## Signing agent socket moves between ozy-cli versions
- **By hand:** after a reboot, git commit signing and GitHub pushes failed because git's `gpg.ssh.program` and
  `~/.ssh/config`'s `IdentityAgent` pointed at the socket path of the globally installed ozy-cli 0.4.9, while
  the running agent (the checkout's 0.5.0 build) listens at `~/.ozy/ozy-signing-agent.sock`. Worked around per
  command with `git -c gpg.ssh.program=…` and `-c core.sshCommand="ssh -o IdentityAgent=…"`.
- **Should be:** the installer that registers the signing agent also writes the git and SSH settings that
  point at it, so they cannot disagree.
- **Belongs in:** ozy-cli's install (and Jive's key handling, which is meant to move server-side).

## ozy-cli's tests never run in CI
- **By hand:** an agent ran `bun test` in ozy-cli before releasing 0.5.0 and found all 4 tests in
  `src/modules/cli/package/package-json.test.ts` failing (the schema requires `$schema` and `license`; the
  fixtures omit them). CI never saw this: ozy-cli's `jive:cicd:audit` runs only `tsc`.
- **Should be:** the audit hook runs the package's tests, so a failing test fails the build.
- **Belongs in:** ozy-cli's `jive:cicd:audit` script, once the tests pass; generally, jive-abstract-library's
  scaffolded audit script.

## Proving a release builds before it publishes
- **By hand:** every push to a deploy branch publishes, so before pushing ozy-cli 0.5.0 to `main` an agent
  copied the package to a temporary directory and ran `CI=true bun run jive:cicd:build` there, to avoid
  burning a version on a broken build.
- **Should be:** releases land through a pull request whose pipeline run (build and audit, no deploy) gates
  the merge to the deploy branch.
- **Belongs in:** the release practice for Jive packages and branch protection on their repos; the pipeline
  already runs on pull requests (`runsOnPullRequests`).

## npm trusted publishers set up per package on npmjs.com
- **By hand:** ozy-cli 0.5.0's first publish through jive-abstract-library failed with `ENEEDAUTH` on every
  platform tarball ([run](https://github.com/ozyman42/ozy-cli/actions/runs/40235464175)). 0.4.9 was published
  over OIDC from the build job, with no GitHub environment; the library publishes from the deploy job in the
  `latest` environment, and the package's npm trusted publisher has to be edited by hand on npmjs.com to match
  (workflow `pipeline.yml`, environment `latest`, "Allow npm publish").
- **Should be:** moving a package onto an abstract, or scaffolding one, writes its trusted publisher to match
  the pipeline, through the custodian (`@jive-sh/app`) so the one npm consent is given once.
- **Belongs in:** jive-abstract-library (it knows the workflow and environment names) calling `@jive-sh/app`.
  ozy-cli's `INpm.ensureTrustedPublisher` already posts to npm's trust endpoint but sets no environment.

## skill-sync-service is tested by hand, with hooks of its own
- **By hand:** jive-sh/skill-sync-service deploys on the Jive pipeline (schema, then `wrangler deploy`), but its
  audit hook only typechecks. An agent runs the end-to-end test (`test/e2e.ts`) against a local `wrangler dev`,
  since the test imports this package's source from a sibling checkout. The test checks the hub's data but not
  the page, so for 0.4.9's account usage an agent connected a test daemon to the local service and screenshotted
  the dashboard in headless Chrome by hand. No abstract covers Cloudflare Workers, so the service writes its six
  hooks itself, and its `get-config` prints its `jive` block without validating it. Its `CLOUDFLARE_API_TOKEN`
  was created in the Cloudflare dashboard and set with `~/.jive/set-secret`.
- **Should be:** a Cloudflare Worker abstract owning the hooks and the manifest schema, whose deploy provisions the
  D1 database and R2 bucket and gets its Cloudflare access from @jive-sh/server. The audit hook runs the
  end-to-end test against the published @jive-sh/skill-sync and drives the dashboard in a headless browser.
- **Belongs in:** a new `jive-abstract-worker-cloudflare`, extended by skill-sync-service.

## Cleaning up daemons registered from a build checkout
- **By hand:** running `dist/base/bin/<command>` to test a local build registers a second daemon from the checkout
  (a LaunchAgent and a `~/.jive/daemons` record) beside the real install; an agent then removes it by hand from
  its record. It has happened at least twice: one such daemon synced skills and then signed the machine out.
- **Should be:** a durable guard so a build checkout never registers start-at-login daemons, or a test entrypoint
  that never registers. This changes how the launcher decides to register, so it is a design for Alex to approve.
- **Belongs in:** jive-abstract-library's launcher (`internal/common/command-launcher.ts`).

## Running a compiled release away from its build machine
- **By hand:** ozy-cli 0.5.0 built and published, then every `ozy` command crashed on install with
  `Cannot find module '/home/runner/work/ozy-cli/ozy-cli/node_modules/playwright-core/package.json'`: a
  dependency read its package.json from its build-time path at load. CI passed because that path exists on the
  runner. An agent found it by installing by hand, then proved the 0.5.1 fix by building in a temp copy,
  deleting its `node_modules`, and running the binary.
- **Should be:** the build runs each compiled command (`--version`) from a directory with no `node_modules`
  and the checkout path absent, and fails the build if it crashes, before anything publishes.
- **Belongs in:** jive-abstract-library's builder, so every package built from it gets the check.

## Checking the live dashboard needs a passkey
- **By hand:** after each service deploy, an agent can confirm sync from daemon logs and D1, but cannot see the
  live dashboard: it needs a passkey session, and a passkey prompt in an agent's browser times out with nobody
  there to approve it.
- **Should be:** a deploy check that reads the live hub's snapshot with a credential the pipeline holds (for
  example a read-only dashboard token), so a broken page fails the deploy instead of being found by Alex.
- **Belongs in:** skill-sync-service's deploy step, once the service is on the Jive pipeline.

## Minting the Convex team access token for a backend's pipeline
- **By hand:** for jive-abstract-backend-convex, an agent called the Convex Management API's
  `create_access_token` for team `jive` with this Mac's Convex CLI login, saved the token to
  `~/.jive/convex-team-token.json` and set it as the repository secret `CONVEX_TEAM_ACCESS_TOKEN` with
  `~/.jive/set-secret`. The token never expires and controls the whole team.
- **Should be:** the credential custodian holds the team credential, and a pipeline proves who it is (GitHub's
  OIDC token) to receive a deploy key for one deployment, so no repository holds a team-wide secret.
- **Belongs in:** the central Jive server (`@jive-sh/server`) as the credential custodian, and the
  `jive:cicd:deploy` hook in jive-abstract-backend-convex as its caller.

## Regenerating a Convex backend's generated code
- **By hand:** `convex codegen` refuses to run without a deployment ("No CONVEX_DEPLOYMENT set"), so to commit
  `convex/_generated` for jive-abstract-backend-convex's test fixture an agent minted a deploy key and pushed
  the fixture to a throwaway deployment.
- **Should be:** the abstract's dev server (`jive-backend-convex dev`) keeps `convex/_generated` current
  against the developer's own deployment, the way `convex dev` does, alongside `package.schema.json`.
- **Belongs in:** jive-abstract-backend-convex's `dev` command.

## Releasing a contract change through every dependent package
- **By hand:** replacing the `jive:cicd:deploy:url` hook with `jive:cicd:deploy:plan` (2026-10-26) meant an
  agent pushed jive-sh/jive's shared pipeline, released jive-abstract-library 0.2.0, waited for npm to serve it,
  then bumped and released each package that depends on it, layer by layer: the other abstracts, then the
  connector abstracts built on them, then skill-sync, ozy-cli and effective-modules. Every one of those pushes
  failed sequencing until its own release landed, because the pipeline runs its actions from jive-sh/jive's
  `main`.
- **Should be:** a release that knows which Jive packages depend on the one just published, and opens or
  pushes their dependency bump in dependency order once npm serves it.
- **Belongs in:** `@jive-sh/jive` (the "topological release gating across packages" planned as its
  direction), reading each package's dependencies on the others.

## Registering an organization, its code repository and its npm connection on @jive-sh/server
- **By hand:** `packages.provision` serves only a repository registered to an organization that has connected an
  npm account. Until the resources' own calls exist, a person runs `convex run seed:organizationWithRepository`
  with the repository's GitHub ids, and `bun run connect-npm` in @jive-sh/server, which prompts for the npm token
  and the authenticator-app secret without echoing them, against the deployment.
- **Should be:** `organizations.create`, `codeRepositories.provision` (reading the ids through a GitHub
  connection and setting up branch protection) and `connections.create` for npm, called by a signed-in person
  (Jive API v1 design doc §3, §7, §8).
- **Belongs in:** @jive-sh/server, with the person's sign-in through `jive.sh`.

## Testing Cli's Tab completion in zsh, fish and PowerShell
- **By hand:** jive-abstract-library's CI runner has only bash, so its real-shell tests
  (`src/internal/modules/shell-completion/scripts.test.ts`) skip zsh, fish and PowerShell there. For the 0.7.0
  release (2026-10-31) an agent ran the suite in a local Debian container after installing zsh, fish, libicu and
  pwsh by hand. Windows (PowerShell profiles, npm's `.cmd` shims) has never run at all.
- **Should be:** the library's pipeline installs zsh, fish and pwsh before `jive:cicd:audit`, and a Windows job
  runs the same tests, so every push checks all four shells.
- **Belongs in:** jive-sh/jive's reusable pipeline (a per-package setup step) or jive-abstract-library's own
  audit hook; a pipeline change, so Alex's decision.

## Regenerating the Jive design page
- **By hand:** someone runs `bun run --cwd design generate` in jive-sh/jive, checked out in the chaine monorepo, to refresh
  `design/jive_design.html`, so the page shows stale versions and packages until then.
- **Should be:** a workflow that regenerates it whenever a package folder changes or a package publishes.
- **Belongs in:** the local Jive daemon, as an `effect/workflow` definition. Needs Alex's yes: it adds a new mechanism to the daemon.

## Creating an Expo app's EAS project before its first deploy
- **By hand:** jive-abstract-app-expo's hooks need `expo.owner` and `expo.extra.eas.projectId` in the app's
  `app.json`, so for @jive-sh/app (2026-11-01) an agent ran `eas init --non-interactive --force` with the `jive-ci`
  robot's token, which created the project `jive-sh/jive-sh` and wrote its id.
- **Should be:** the deploy provisions the project when it is missing, as every deploy provisions what it deploys
  to, and the build reads the id from where the deploy recorded it.
- **Belongs in:** jive-abstract-app-expo's deploy, provisioning through @jive-sh/server (`jive provision`).

## Creating the DNS records a custom domain needs
- **By hand:** jive-abstract-app-expo and jive-abstract-backend-convex print the records a custom domain needs
  (`jive.sh` on EAS Hosting, `api.jive.sh` on Convex) and a person or agent creates them in the domain's DNS zone.
  For jive.sh (2026-11-01) an agent created the three EAS records through Cloudflare's API. The old apex record
  could not be deleted that way: Cloudflare marked it read-only, owned (`meta.origin_worker_id`) by a Worker
  custom domain that no longer existed. Attaching jive.sh to that Worker as a custom domain again, which took the
  same id, then deleting the custom domain removed the record.
- **Should be:** the deploy sets them through the organization's DNS connection, idempotently, and replaces a
  record another product owns by releasing it through that product.
- **Belongs in:** a DNS resource connector (`jive-abstract-resource-connector-dns`, proposed on the design page),
  installed in @jive-sh/server and called by both abstracts' deploys.

## Testing skill-sync's Tab completion in a real shell
- **By hand:** for the move onto jive-abstract-library's `Cli` (2026-11-01) an agent drove an interactive zsh
  with `expect`, its `.zshrc` holding the line `skill-sync --setup-completion` writes and `skill-sync` on PATH
  pointing at the compiled binary, and pressed Tab after `skill-sync `, `show ` and `add ` against the live
  daemon, against no daemon, and against a socket that accepts and never answers. `src/internal/cli.test.ts`
  covers the same cases through `--compgen` with a fake daemon, not a shell.
- **Should be:** a step in the package's audit that runs the compiled binary's Tab in zsh, bash and fish
  against a fake daemon on a short socket path (macOS caps a Unix socket path at 104 bytes).
- **Belongs in:** skill-sync's `jive:cicd:audit`, once jive-abstract-library's pipeline installs those shells
  (the entry above).

## Firebase project and FCM key for an Expo app's Android push
- **By hand:** for `@jive-sh/app`'s phone approval (2026-11-01), an agent created GCP and Firebase project `jive-sh`
  with gcloud and Firebase's REST API, registered Android app `sh.jive.app`, downloaded `google-services.json` into
  the app, created a key for service account `expo-push@jive-sh.iam.gserviceaccount.com` (role
  `firebasecloudmessaging.admin`), and uploaded it to EAS as the app's FCM v1 key through Expo's GraphQL API
  (`createGoogleServiceAccountKey`, `createAndroidAppCredentials`). The Google sign-in for gcloud was Alex's.
- **Should be:** a deploy that provisions what it deploys to: jive-abstract-app-expo's deploy, with Android push
  turned on, makes sure the Firebase app and the EAS FCM key exist, through a Google Cloud connector on
  `@jive-sh/server` that holds the Google credential.
- **Belongs in:** jive-abstract-app-expo (the provisioning step) and a Google Cloud resource connector installed by
  `@jive-sh/server`.

## Checking an Expo app's release on the user's path
- **By hand:** after `@jive-sh/app` 0.5.1 (2026-11-01), an agent downloaded the EAS APK and matched its signing
  certificate against the fingerprint jive.sh's live `assetlinks.json` grants, loaded the live jive.sh in headless
  Chromium at desktop size and as a Pixel 7 to see the install QR code and the Install link, and loaded the EAS build
  page as a phone to confirm it installs with no login.
- **Should be:** a step after jive-abstract-app-expo's production deploy (or a scheduled check) that does the same and
  fails the release when the APK's certificate is missing from `assetlinks.json` or the page shows no install link.
- **Belongs in:** jive-abstract-app-expo's deploy hook, with the browser check in its audit's hook tests.

## Creating a new package's repository and its NPM_TOKEN
- **By hand:** for jive-abstract-app-github-pages (2026-11-04) an agent ran `gh repo create jive-sh/<name> --public`,
  then `~/.jive/set-secret ~/.jive/npm-token.json NPM_TOKEN jive-sh/<name>` so its pipeline could publish, then
  pushed the first commit.
- **Should be:** the package's first deploy provisions its code repository and npm package through @jive-sh/server,
  and publishes with the server's npm connection, so no repository holds `NPM_TOKEN`.
- **Belongs in:** the code repository and package registry connectors (`jive provision`), called by
  jive-abstract-library's deploy.

## Setting a repository's GitHub Pages source
- **By hand:** jive-abstract-app-github-pages publishes a site to `gh-pages` and requests its build, but a repository
  whose Pages site does not exist, or whose source is not `gh-pages` at `/`, fails the deploy until a repository
  administrator sets it at `https://github.com/<owner>/<repo>/settings/pages`. "Enforce HTTPS" is set the same way.
  A job's token cannot have the Administration permission those settings need. jive-sh/docs was set up by hand.
- **Should be:** the deploy creates or corrects the Pages site (`POST`/`PUT /repos/{owner}/{repo}/pages`:
  `build_type: legacy`, source `gh-pages` `/`, `https_enforced` once the certificate exists) through a credential
  that holds Administration and Pages write on the repository.
- **Belongs in:** a GitHub resource connector installed in @jive-sh/server, called by
  jive-abstract-app-github-pages's deploy.

## Building against an unpublished release of a dependency
- **By hand:** to build the service's Skill refinement tab against skill-sync's unreleased wire types, an agent
  copied skill-sync's `dist/base` and current `src` into the service's `node_modules/@jive-sh/skill-sync`, because the
  service's `^0.7.0` is not published and `bun install` fails on it; the service's other packages (React, elkjs,
  `@jive-sh/workflow-platform` 0.3.0) were copied in beside it the same way. Before 0.3.0 was published (2026-11-17),
  skill-sync held such a copy of the platform's open-empires checkout too; it now installs the release. `bun install`
  replaces the copies once skill-sync is published. For `jive create` (2026-11-18), jive-abstract-library and
  @jive-sh/jive depend on jive-abstract-abstraction 0.1.0 before it is published: jive-abstract-library was installed
  from its committed lockfile and built with that devDependency held out of package.json, and @jive-sh/jive's
  `node_modules/jive-abstract-abstraction` was symlinked to its `dist/base` and run with `NODE_PRESERVE_SYMLINKS=1`
  so one copy of `effect` loads.
- **Should be:** the workspace links a package from another workspace's checkout as `jive init` links its own, or a
  release of the dependency is published to a staging tag the dependent can install.
- **Belongs in:** `jive load` and `jive init` in @jive-sh/jive.

## Loading a new, empty repository into a workspace
- **By hand:** `ozyman42/dns` was created empty with `gh repo create --private`. `jive load` reads a repo's package name
  from its `package.json` before placing it, so it can't load an empty repo. An agent cloned it to
  `packages/@ozyman42/dns` with git, set by hand the signing config `jive init` sets, pushed the first commit, and only
  then ran `jive load`, which adopted the checkout. It ran jive 0.9.1 from source (a `git archive` of `b4e0b12`),
  because the droplet's image installs 0.8.0, whose `load` doesn't place packages at `packages/<package name>`.
  The same happened on 2026-11-19 for `ozyman42/agenticloud-connect`, cloned empty to
  `packages/@ozyman42/agenticloud-connect` and filled there, its first commit pushed, then adopted by `jive load`
  run from a `git archive` of jive `b4e0b12`.
- **Should be:** `jive create` (or `jive provision` with a code-repository kind) makes the repo, its first commit and
  its submodule entry in one step, with signing configured from the start; the image installs the current jive.
- **Belongs in:** jive (`jive create`, `jive provision`), and decomp-project-image's `image/provision.sh` for the
  installed version.

## HTTPS for T3 Code on the agentic-workspace droplet
- **By hand:** on 2026-11-19 an agent installed Caddy 2.11.9 (with caddy-dns/acmedns) and acme-dns 2.0.2 on the
  droplet, wrote `/etc/caddy/Caddyfile`, `/etc/acme-dns/config.cfg` and both units, created the `acme-dns` user,
  registered the one acme-dns account, and removed T3's `--tailscale-serve` drop-in so Caddy owns tailnet port 443.
  The files are in `@ozyman42/dns`'s `local/droplet/` (not committed). A rebuild of the droplet wipes all of it except
  the state on the Volume.
- **Should be:** the droplet's image installs both binaries, both configs and units and the user, and runs T3 without
  `--tailscale-serve`; a fresh Volume's acme-dns registration and the CNAME it needs come from a workflow, not by hand.
- **Belongs in:** decomp-project-image (`image/provision.sh`, `image/t3.service`).
- **In flight:** [open-empires/decomp-project-image#1](https://github.com/open-empires/decomp-project-image/pull/1)
  (draft) puts the install in the image; the registration workflow is still missing.

## A Cloudflare deploy token for a new Worker repository
- **By hand:** on 2026-11-19 `@jive-sh/skill-sync-service`'s first pipeline run failed because its repository has no
  `CLOUDFLARE_API_TOKEN` (the only copy sits on `jive-sh/skill-sync`, which does not deploy). An agent ran
  `wrangler login --device` on the droplet, Alex approved the sign-in on his own computer, and the agent stored the
  resulting OAuth access token as the repository secret. That token expires an hour after it is issued.
- **Should be:** a Cloudflare connector in `@jive-sh/server`, so a Worker's deploy job signs in with `jive login --cicd`
  and the server deploys or hands it a short-lived token; no Cloudflare token in any repository.
- **Belongs in:** `@jive-sh/server` (a `jive-resource-*` Cloudflare connector) and `@jive-sh/jive` (`jive provision`).

## Testing a package's daemon install and start
- **By hand:** on 2026-11-19, for `@ozyman42/agenticloud-connect`, an agent installed the built package globally with
  `HOME` set to a scratch folder and fake `systemctl` and `loginctl` first on `PATH`, read the record and unit the
  installer wrote, ran the unit's `ExecStart` with a bare `PATH` against fake `jive` and `jive-ssh`, then removed the
  package and watched the daemon deregister itself.
- **Should be:** a CI test in jive-abstract-library that builds a sample package with a daemon, installs it on each OS
  runner against fake service managers (`systemctl`, `launchctl`, `schtasks`), starts the daemon from its recorded
  registration, and checks it deregisters after an uninstall.
- **Belongs in:** jive-abstract-library's tests, run by its pipeline on Linux, macOS and Windows runners.
