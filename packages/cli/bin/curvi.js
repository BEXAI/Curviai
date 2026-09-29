#!/usr/bin/env node
// The curvi command. The source is TypeScript run on Node's built in type
// stripping (Node 22.18 and later), so there is no build step while the CLI
// lives in this workspace unpublished (PHASE_16 founder decision 6).
import "../src/main.ts";
