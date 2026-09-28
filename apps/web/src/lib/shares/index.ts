/**
 * Share store entry point: the database store in db mode, the in memory
 * demo store otherwise, decided at call time like getServices().
 */

import { getServices, isDbMode } from "@/lib/services";
import { getDb } from "@/lib/services/db";
import { DbShareStore } from "./db-store";
import { DemoShareStore } from "./demo-store";
import type { ShareStore } from "./types";

export * from "./types";

export function getShareStore(): ShareStore {
  if (isDbMode()) {
    return new DbShareStore(getDb());
  }
  return new DemoShareStore(getServices());
}
