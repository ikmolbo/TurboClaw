#!/usr/bin/env bun

import { main } from "./cli/index";

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
