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

## skill-sync-service is deployed and tested by hand
- **By hand:** the service behind skill-sync.jive.sh lives in `packages/@jive-sh/skill-sync-service` in the chaine
  checkout, outside git. An agent runs its end-to-end test (`test/e2e.ts`) against a local `wrangler dev`, then
  deploys with `wrangler deploy` from that checkout. It builds against a local `dist/base` of this package, not a
  published version.
- **Should be:** the service in its own repo on the Jive pipeline, with the end-to-end test in its audit hook and
  `wrangler deploy` as its deploy hook, depending on a published @jive-sh/skill-sync.
- **Belongs in:** a new repo for the service, extending an app or service abstract once one exists.

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
