# Meta -> Tweet Genie Truncation Fix (2026-03-06)

## Issue
Cross-posts from Meta Genie (Threads source) to Tweet Genie (X target) were not reliably preserving long content.  
LinkedIn -> Tweet Genie worked, but Meta -> Tweet Genie could send over-280 single text and fail with `X_POST_TOO_LONG`, or lose expected thread behavior.

## Root Cause
Meta cross-post code forwarded source content using Threads-oriented sizing and mode assumptions:
- `single` mode content could exceed X's 280-char hard limit.
- long single content was not converted to thread payload before calling Tweet Genie internal endpoint.

Tweet Genie internal endpoint correctly enforces:
- single post max 280
- thread mode requires valid `threadParts`

## Fix Applied
### 1) Immediate publish path
Updated `server/controllers/postsController.js`:
- Added X-specific payload normalization:
  - `X_MAX_CHARS = 280`
  - `X_MAX_THREAD_PARTS` guard (default `25`)
- Added splitter for X-safe chunks.
- Added `buildXCrossPostPayload(...)`:
  - keeps explicit thread mode when valid
  - auto-converts oversized single content into thread mode
  - guarantees final payload respects X limits
- Cross-post call now uses normalized payload (`postMode`, `content`, `threadParts`).
- Save-to-history now records actual posted mode/content/parts.

### 2) Scheduled publish path
Updated `server/services/scheduledPostWorker.js` with the same X payload normalization:
- Added the same X constants and payload builder.
- `crossPostToX(...)` now always posts X-safe payload.
- Save-to-history now uses actual posted mode/content/parts returned by cross-post step.

## Files Changed
- `server/controllers/postsController.js`
- `server/services/scheduledPostWorker.js`

## Behavior After Fix
- Long single content from Meta -> X is auto-split into thread parts before calling Tweet Genie.
- Existing valid thread posts remain thread posts.
- Content/history consistency is preserved between posted payload and stored history metadata.

## Validation
Syntax checks passed:
- `node --check server/controllers/postsController.js`
- `node --check server/services/scheduledPostWorker.js`

## Notes
- This change is scoped to Meta -> Tweet Genie cross-posting behavior.
- No Tweet Genie server contract change was required; Meta now conforms to existing Tweet Genie internal API constraints.
