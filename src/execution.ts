/**
 * The execution primitives the verifier runs checks with, exported so a caller that runs
 * commands of its own (the coding agent's chokepoint) builds child environments and process
 * groups the same way, and scrubs evidence with the same credential detector.
 */

export * from "./evidence/credential-names.ts";
export * from "./evidence/latin-lookalikes.ts";
export type { ChildEnvironment, ChildEnvironmentOptions } from "./exec/child-environment.ts";
export { childEnvironment, UnauthorizableEnvironmentName } from "./exec/child-environment.ts";
export type { ProcessRunOptions, ProcessRunResult } from "./exec/run-process.ts";
export { refusedBeforeSpawn, runProcessGroup } from "./exec/run-process.ts";
