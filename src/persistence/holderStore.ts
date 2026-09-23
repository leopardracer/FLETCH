import { getDb } from "./db.js";

/** Last block whose transfers are already applied to this token's stored balances, or null. */
export function getHolderCoverage(token: string): { launchBlock: number; throughBlock: number } | null {
  const row = getDb().prepare(`SELECT launch_block, through_block FROM holder_scan_coverage WHERE token = ?`).get(token.toLowerCase()) as
    | { launch_block: number; through_block: number }
    | undefined;
  return row ? { launchBlock: row.launch_block, throughBlock: row.through_block } : null;
}

/** Applies balance deltas and advances coverage atomically — a crash can't leave balances and coverage out of step. */
export function applyHolderDeltas(token: string, launchBlock: number, throughBlock: number, deltas: Map<string, bigint>): void {
  const db = getDb();
  const t = token.toLowerCase();
  const get = db.prepare(`SELECT balance FROM token_balances WHERE token = ? AND holder = ?`);
  const put = db.prepare(`INSERT INTO token_balances (token, holder, balance) VALUES (?, ?, ?) ON CONFLICT(token, holder) DO UPDATE SET balance = excluded.balance`);
  db.exec("BEGIN");
  try {
    for (const [holder, d] of deltas) {
      if (d === 0n) continue;
      const cur = get.get(t, holder) as { balance: string } | undefined;
      put.run(t, holder, (BigInt(cur?.balance ?? "0") + d).toString());
    }
    db.prepare(`INSERT INTO holder_scan_coverage (token, launch_block, through_block) VALUES (?, ?, ?)
                ON CONFLICT(token) DO UPDATE SET through_block = excluded.through_block`).run(t, launchBlock, throughBlock);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function getPositiveBalances(token: string): { holder: string; balance: bigint }[] {
  const rows = getDb().prepare(`SELECT holder, balance FROM token_balances WHERE token = ?`).all(token.toLowerCase()) as { holder: string; balance: string }[];
  return rows.map((r) => ({ holder: r.holder, balance: BigInt(r.balance) })).filter((r) => r.balance > 0n);
}
