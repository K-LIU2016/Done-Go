#!/usr/bin/env node
import { main } from './src/cli.mjs';

const code = await main();
process.exitCode = code;
