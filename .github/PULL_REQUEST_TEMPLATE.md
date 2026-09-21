## What this changes

<!-- One or two sentences. Link an issue if there is one. -->

## Why

<!-- The problem this solves, or the gap it closes. -->

## Checklist

- [ ] `npm run lint` passes (warnings OK, no new errors)
- [ ] `npm test` passes
- [ ] If this adds a metric/score/risk finding: it's a real chain read (or
      a real provider), or it ships an explicit `unavailable` state with a
      reason — never a fabricated/estimated value (see `CONTRIBUTING.md`)
- [ ] If this adds a data source: it goes through the `ChainDataProvider`
      interface (`src/data/types.ts`) rather than a parallel code path
- [ ] Docs updated if this changes behavior described in `docs/*.md`

## Screenshots / output

<!-- For anything touching web/ or API responses, paste before/after or a
screenshot. `npm run screenshot` regenerates the dashboard capture if
relevant. -->
