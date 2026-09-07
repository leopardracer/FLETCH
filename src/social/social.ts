export interface SocialAvailable {
  available: true;
  value: number; // 0-100 aggregate social component score
  mentions: number;
  mentionsGrowthPercent: number | null;
}

export interface SocialUnavailable {
  available: false;
  reason: string;
}

export type SocialReport = SocialAvailable | SocialUnavailable;

/**
 * No reliable social-mentions/sentiment source for Robinhood Chain tokens
 * was found during data-source research (see /areas — no free or verified
 * API surfaced social data the way Bitquery/Blockscout cover onchain
 * data). Rather than fabricate a mentions count or sentiment score, this
 * stays an explicit UNAVAILABLE. Wiring the X/Twitter API (or a social
 * listening vendor) is a real scope + cost decision — flag it back to
 * product before building against one.
 */
export async function getSocialSignalForToken(_tokenAddress: `0x${string}`): Promise<SocialReport> {
  return {
    available: false,
    reason: "no social data source is wired up — none was found to be reliable for Robinhood Chain tokens yet",
  };
}
