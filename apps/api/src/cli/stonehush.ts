#!/usr/bin/env node
import { runStonehushCli } from "./stonehush-cli.js";

const exitCode = await runStonehushCli(process.argv.slice(2), process.env);
process.exitCode = exitCode;
