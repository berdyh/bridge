#!/usr/bin/env node
import { createDefaultDeps, runCli } from "./cli.js";

process.exitCode = await runCli(process.argv.slice(2), createDefaultDeps());
