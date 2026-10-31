#!/usr/bin/env node
// Check the runtime before loading the command composition.
import "./node-floor-check.ts";

import { verifierCommands } from "./cli-commands.ts";
import { dispatch } from "./cli-main.ts";

// The verifier alone: no model client, no agent loop. The build refuses a closure that reaches
// either.
process.exitCode = await dispatch("swarm-verify", verifierCommands, process.argv.slice(2));
