# pd-helper-cli Method Reference

Call form: `node ./scripts/main.mjs call <method> [--param k=v ...]`

Three execution hosts:
- **site tab**: dispatched to an already-open tab of the matching site (content script).
- **pd-runtime page**: hosted by the extension's `runtime.html` page, which then dispatches to an independent execution tab.
- **SW-only**: Service Worker only, no site tab needed.

Login: **TikTok needs no login** (public web API); **Instagram / NoxInfluencer require login** (private authenticated API).

Any business method supports `--param __probe=true`: a zero-side-effect check that it is registered.

## Exit Code Table

| code | exit | meaning |
|---|---|---|
| (success) | 0 | result / normal terminal state |
| UNKNOWN_ERROR | 1 | unclassified error |
| LOGIN_REQUIRED | 2 | login required |
| RATE_LIMITED | 3 | rate limited |
| TAB_CLOSED | 4 | target tab missing / closed |
| INVALID_PARAM | 5 | invalid parameter |
| SW_DEAD | 10 | failed to wake the SW |
| CDP_DISCONNECTED | 11 | CDP disconnected |
| TIMEOUT | 12 | timeout |
| CHROME_NOT_FOUND | 13 | cannot reach CDP |
| TASK_LOST | 14 | task lost after reconnect / orphaned |
| CAPTCHA | 15 | human verification / risk control |
| CANCELLED | 130 | cancelled |
| RUNTIME_TAB_ERROR | 16 | extension runtime page unavailable |

---

## Builtin

### ping
- Host: SW-only
- Params: `count` (1–20, default 3), `interval` (100–5000ms, default 500)
- Side effects: none. Emits progress per tick; used for connectivity self-check.
- probe: `call ping --param count=1`

### csTest
- Host: site tab (any of the three platform tabs with the content script injected; no page-content requirement)
- Params: `count` (1–5, default 3)
- Purpose: dev self-check of content-script messaging. The CS logs one tick every 300ms, `count` times. Returns `{from, href, ticks}`.

---

## TikTok

No login required. Except for `tkBatchCollect`, all dispatch to an already-open `*.tiktok.com` tab.

### tkProfileMetrics
- Host: site tab
- Params: `username` (required), `minLikeRate` (default 0.02), `maxDurationSec` (default 60)
- Behavior: does not download videos; computes two metrics.
  - `qualifyingRate`: share of qualifying videos on the hot first page. Qualifying = playCount ≥ threshold AND commentCount ≥ threshold AND duration ≤ `maxDurationSec` AND like rate (diggCount/playCount) ≥ `minLikeRate`.
  - `postRate`: number of videos posted in the last 30 days (not affected by the two params above).

### tkCollect
- Host: site tab
- Params: `username` (required), `maxVideoCount` (target selected count, default 10), `fromTs?`, `toTs?` (ms-timestamp filter range), `startYear?`, `endYear?` (fallback only when fromTs/toTs are absent, mapped to that year's 1/1–12/31; default is the last 90 days), `minLikeRate` (default 0.02), `maxDurationSec` (default 60), `filenamePrefix?`, `sortType` (`recent`|`hot`, default recent)
- Behavior: collects one account's videos and packages a download, auto-loading already-collected IDs for dedup. Produces an archive (per-video json + top5 comments).

### tkBatchCollect
- Host: **pd-runtime page**. The extension's `runtime.html` hosts the long task and creates its own independent TikTok execution tab (no pre-opened tiktok tab needed).
- Build requirement: the extension build must include `runtime.html` / `runtime.js`.
- Input source: claims unused influencers from Apps Script / Google Sheets `claimUnusedBatch(platform:tiktok)` (**not manually specified accounts**).
- Params: `batchSize?` (claim count), `maxVideoCount?`, `sortType` (recent|hot), `minLikeRate?`, `maxDurationSec?`, `fromTs?`, `toTs?`
- Automatic behavior:
  - Batch-wide shared video dedup (closure-level, automatic; the agent need not and cannot pass `excludeVideoIds`).
  - CAPTCHA: **consecutive** hits across influencers reaching 3 → abort the whole batch (one successful collection resets the counter, hence "consecutive"). Below 3, it clears TikTok cookies, rebuilds the execution tab, and retries.
- Per-influencer failures (marked failed, **do not abort the batch**): metric estimation failed / still failed on retry, influencer has comments disabled, TikTok execution page unavailable (PREPARE_TK_TAB), TK tab rebuild failed / reset_tk_tab no response, cookie removal failed (cookie_remove_failed), collection failed, no qualifying video (NO_QUALIFYING_VIDEO, marked used, not counted as failure).
- Aborts the whole batch: only `BatchAbortError` (currently the sole source = 3 consecutive CAPTCHAs, exit 15).
- Error codes: `RUNTIME_TAB_ERROR`, `CAPTCHA`, `CANCELLED`, `INVALID_PARAM`, `UNKNOWN_ERROR`.
- Response: when CAPTCHA aborts the batch, advise the user to wait and retry later or switch IP / browser environment; do not retry immediately.

### tkDownloadVideo
- Host: site tab
- Params: none
- Behavior: downloads the video currently open in the tab (URL must contain `/video/<id>`, otherwise `parse_error:missing_video_detail`).

### tkBridgeToIg (DEPRECATED)
- Host: site tab
- Params: `caption?`
- Behavior: downloads the current TikTok video and relays/uploads it to Instagram.
- Status: marked for removal; do not depend on it in new flows.

---

## Instagram

Requires login to `instagram.com` (private API, depends on sessionid / ds_user_id; missing → `LOGIN_REQUIRED`). Dispatches to an already-open `*.instagram.com` tab.

### igCollectReels
- Host: site tab
- Params: `username` (required, missing → INVALID_PARAM), `order` (`asc`|`desc`, default asc), `rangeFrom?`, `rangeTo?` (**ordinal positions, not dates**; sliced by sorted position; both empty = all)
- Behavior: collects the account's full reels list plus per-item details (incl. first-page comments), outputs JSON `{filename, totalPosts}`.

### igManualAnalyze
- Host: site tab
- Params: none
- Precondition: the current tab must be on an IG post detail page (shortcode read from URL).
- Behavior: extracts post data and downloads fallback files (`shortcode.txt` + media) for manual AI analysis; aborts if comments are disabled.

### igGenerateScript
- Host: site tab
- Params: none
- Precondition: the current tab must be on an IG post detail page (re-fetches data itself, does not depend on running analyze first).
- Behavior: calls the script-generation API, returns `{ok:true}` (no local file).

---

## NoxInfluencer

Requires login to `noxinfluencer.com` (private authenticated API; on failure → `session_expired` notice). Dispatches to an already-open `*.noxinfluencer.com` tab.
Nox task mutex: rejects a new task while another nox task is running.

### noxAutoCollect
- Host: site tab
- Params: `targetCount` (default 5000), `startPageNum` (default 1), `collectProfile` (default true)
- Precondition: the current tab must be on a Nox search / ranking page carrying a `p=`-encoded query (`searchUrl` / `platform` read from the URL).
- Behavior: paginates and scrapes influencers → pushes to Google Sheets; when `collectProfile`, fetches audience profiles one by one.

### noxCollectAudience
- Host: site tab
- Params: none
- Precondition: the current tab = Nox search-results page with influencers manually selected.
- Behavior: collects audience profiles for the selected influencers and upserts to Sheets.

### noxBackfillProfiles
- Host: site tab (does not depend on current page content)
- Params: `batchSize` (default 100)
- Behavior: backfills profiles for tiktok influencers already in Sheets but with empty genderTag. Produces `{batchSize, processed, succeeded, failed}`.

### noxCollectTikTokPool (DEPRECATED)
- Host: site tab (triggered on nox)
- Status: same executor and input source as `tkBatchCollect` (Sheets `claimUnusedBatch`); the only difference is the execution host (Nox tab instead of the runtime page). Overlapping functionality — **use `tkBatchCollect` instead**.
- Params: same as `tkBatchCollect` (`batchSize?`, `maxVideoCount?`, `sortType`, `minLikeRate?`, `maxDurationSec?`, `fromTs?`, `toTs?`).

### noxPauseAutoCollect / noxResumeAutoCollect
- Host: site tab
- Params: none
- Behavior: pauses / resumes the running `noxAutoCollect` long task (flips the in-memory checkpoint state); a no-op when no task is running.
