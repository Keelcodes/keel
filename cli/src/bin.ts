#!/usr/bin/env node
import { createNodeIo } from './io.js';
import { runCli } from './run.js';

process.exitCode = await runCli(process.argv.slice(2), createNodeIo());
