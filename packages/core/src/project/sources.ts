import { join } from "node:path";
import { TurtleDb } from "../db/db.js";
import { GitStore } from "../git/store.js";
import type { SourceHandle } from "../run/companion.js";
import type { Project } from "./project.js";

export interface RunSources {
  /** Source id of the repository the run is driven from (null: not one of the project's). */
  primaryId: string | null;
  companions: SourceHandle[];
  close(): void;
}

/**
 * The other sources of `project` for a run whose primary repository is `primaryPath`
 * (docs/phase2-spec.md §7.1). `only` restricts the companions (a task's `sources`).
 */
export async function openRunSources(
  project: Project | null,
  primaryPath: string,
  only?: readonly string[],
): Promise<RunSources> {
  const none: RunSources = { primaryId: null, companions: [], close() {} };
  if (!project) return none;
  const primary = project.config.sources.find((s) => s.path === primaryPath);
  if (!primary) return none;
  const companions: SourceHandle[] = [];
  const dbs: TurtleDb[] = [];
  for (const s of project.config.sources) {
    if (s.id === primary.id || (only && !only.includes(s.id))) continue;
    const store = await GitStore.open(s.path);
    const db = TurtleDb.open(join(store.turtleDir, "turtle.db"));
    dbs.push(db);
    companions.push({ id: s.id, store, db });
  }
  return {
    primaryId: primary.id,
    companions,
    close() {
      for (const db of dbs) db.close();
    },
  };
}
