import { getDb } from "./db.js";
import type { LaunchRecord } from "../chain/launch.js";

/** Stores a launch record permanently (idempotent — a launch never changes). */
export function saveLaunchRecord(rec: LaunchRecord): void {
  getDb()
    .prepare(`INSERT OR IGNORE INTO launch_records (token, record_json, launch_block) VALUES (?, ?, ?)`)
    .run(
      rec.token.toLowerCase(),
      JSON.stringify({ ...rec, launchConfigId: rec.launchConfigId.toString(), graduationThreshold: rec.graduationThreshold.toString(), launchBlock: rec.launchBlock.toString() }),
      Number(rec.launchBlock)
    );
}

export function getStoredLaunchRecord(token: string): LaunchRecord | null {
  const row = getDb().prepare(`SELECT record_json FROM launch_records WHERE token = ?`).get(token.toLowerCase()) as { record_json: string } | undefined;
  if (!row) return null;
  const r = JSON.parse(row.record_json);
  return { ...r, found: true, launchConfigId: BigInt(r.launchConfigId), graduationThreshold: BigInt(r.graduationThreshold), launchBlock: BigInt(r.launchBlock) };
}
