#!/usr/bin/env node
// Thin executable wrapper. All command logic lives in ../src/cli.mjs so tests
// can drive it in-process; see docs/PLUGIN_SDK_GUIDE.md for the full manual.
import { runDisPluginCli } from "../src/cli.mjs";

const exitCode = await runDisPluginCli(process.argv.slice(2));
process.exit(exitCode);
