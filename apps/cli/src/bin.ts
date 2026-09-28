#!/usr/bin/env node
import { run } from "./cli.js";
import { realIo } from "./io.js";

/** `petty` (PETTY-274). See cli.ts; `petty help` lists the commands. */
process.exit(await run(process.argv.slice(2), realIo()));
