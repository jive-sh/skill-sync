import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Effect, pipe } from "effect";
import { Cli } from "jive-abstract-library";
import { runSkillSync } from "../internal/cli";
import { DaemonControlLive } from "../internal/daemon-control/impl";

BunRuntime.runMain(pipe(
  runSkillSync(),
  Effect.provide(DaemonControlLive),
  Effect.provide(Cli.terminalLogger),
  Effect.provide(BunServices.layer),
));
