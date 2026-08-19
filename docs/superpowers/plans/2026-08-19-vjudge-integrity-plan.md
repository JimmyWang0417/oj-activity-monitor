# VJudge 分页完整性与损坏缓存恢复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 VJudge 在 `runId` 乱序时间场景下安全分页，并在无法证明完整覆盖或本地缓存损坏时 fail-closed/fail-soft，以最新合法提交数据为准。

**Architecture:** 适配器对每个 100 条窗口验证页内及跨页 `runId` 严格递减和唯一性；基础窗口未饱和才声明完整，饱和窗口即使固定结果切片未饱和也保留 `partial`。服务层继续禁用 VJudge 时间 boundary；存储层按复合提交身份从可读分块中移除旧值后写入最新合法响应。

**Tech Stack:** Node.js 20+, CommonJS source modules, `node:test`, npm build/check scripts, deterministic userscript bundle.

## Global Constraints

- VJudge `time` 仅用于统计窗口过滤，不用于排序、分页或边界剪枝。
- 无法证明完整覆盖时必须返回 `partial`/`coverage.complete=false`。
- 损坏本地状态、索引、分块或单条记录不得阻塞新的合法响应；真实 backend I/O 错误继续传播。
- 修改行为后版本必须从 `0.2.17` 升到 `0.2.18`，并重新生成 dist、manifest 和 candidate。
- 只通过 `/home/jimmywang0417/oj-activity-monitor/cooperation.md` 与 Claude 协作；不得伪造 reviewer 消息或 ACK。

### Task 1: 加入 VJudge 分页结构校验与保守完整性判定

**Files:**
- Modify: `src/adapters/vjudge.js:1-145`
- Test: `test/adapters.test.js:149-215`

**Interfaces:**
- `fetchPage(options, start, resultFilter)` continues returning a record array.
- `fetchSlice(options, resultFilter)` returns `{ records, complete, totalFetched, diagnostics }` and throws `OJMonitorError("schema-changed", ...)` on invalid page ordering/identity.
- `fetchSubmissions(options)` preserves `makeResult` shape and returns `partial` whenever a saturated base/slice lacks proof of exhaustive coverage.

- [ ] **Step 1: Write failing tests for page ordering.** Add tests that mock a page with increasing `runId`, a second page whose first `runId` is not below the previous page tail, and a duplicate ID; assert `status === "schema-changed"` and `coverage.complete === false`.
- [ ] **Step 2: Write failing test for saturated result slices.** Mock base `all` as 200 records and every known result filter as a short valid page; assert `status === "partial"`, `coverage.complete === false`, and `diagnostics.stopReason === "exhaustive-result-slices"`.
- [ ] **Step 3: Implement `validateRunIdPage` and cross-page checks.** Parse each `runId` as a finite comparable value, require strict descent within each page, require cross-page descent and no repeated IDs, and throw `OJMonitorError("schema-changed", ...)` with a diagnostic-safe message.
- [ ] **Step 4: Preserve time filtering without time ordering.** Filter records against `options.from/options.to` only after structural validation; never compare a record time with a pagination boundary.
- [ ] **Step 5: Implement conservative completeness.** Keep base unsaturated as complete; when base is saturated, run fixed slices but force final `complete=false` because the endpoint exposes no reliable exhaustive total. Keep valid records and mark malformed rows partial.
- [ ] **Step 6: Run adapter tests.** Run `node --test test/adapters.test.js`; expected PASS including all new ordering and saturation assertions.
- [ ] **Step 7: Commit.** `git add src/adapters/vjudge.js test/adapters.test.js && git commit -m "收紧 VJudge 分页完整性判定"`.

### Task 2: Add real corrupted-chunk coexistence coverage

**Files:**
- Modify: `test/storage.test.js:85-110`
- Inspect: `src/storage.js:170-220`

**Interfaces:**
- `Store.mergeSubmissions(submissions)` keeps readable chunks and writes incoming valid records despite one corrupt chunk.
- `Store.loadSubmissions()` returns normalized records from readable chunks only.

- [ ] **Step 1: Write the failing storage test.** Seed a valid encoded index naming two chunks, encode one valid chunk, write a checksum-corrupted envelope for the other, merge a new VJudge record, then assert both the old valid record and new record are readable and the corrupt chunk is not rewritten as valid data.
- [ ] **Step 2: Run the focused test.** Run `node --test test/storage.test.js --test-name-pattern "corrupt submission chunk"`; expected FAIL if the implementation blocks or loses the valid chunk.
- [ ] **Step 3: Implement only the needed fail-soft adjustment.** Keep backend calls outside the corruption catch; use `get(name, [])` for each chunk and normalize each item independently. Preserve latest-valid composite-key deletion across months.
- [ ] **Step 4: Run storage tests.** Run `node --test test/storage.test.js`; expected PASS.
- [ ] **Step 5: Commit.** `git add src/storage.js test/storage.test.js && git commit -m "补充损坏分块与合法数据共存测试"`.

### Task 3: Update documentation and release version

**Files:**
- Modify: `README.md:55-115`
- Modify: `package.json:3`

**Interfaces:**
- README accurately states runId ordering validation, conservative partial semantics, and fail-soft cache behavior.
- package version is `0.2.18`.

- [ ] **Step 1: Update README behavior table and caveats.** State that saturated VJudge windows remain partial even after fixed result slices because the endpoint total is not reliable; document runId structural checks and corrupt-chunk recovery.
- [ ] **Step 2: Bump package version.** Change only the package version from `0.2.17` to `0.2.18`.
- [ ] **Step 3: Run README/version checks.** Run `node -e 'const p=require("./package.json"); if(p.version!=="0.2.18") process.exit(1)'` and `git diff --check`.
- [ ] **Step 4: Commit.** `git add README.md package.json && git commit -m "更新 VJudge 完整性说明与版本"`.

### Task 4: Full verification and deterministic release artifacts

**Files:**
- Modify: `dist/oj-monitor.user.js`
- Modify: `dist/oj-monitor.meta.js`
- Modify: `dist/SOURCE-MANIFEST.sha256`
- Modify: `dist/CANDIDATE.sha256`

**Interfaces:**
- Build artifacts embed version `0.2.18` and current source.
- Candidate is the SHA-256 identity of the generated source manifest.

- [ ] **Step 1: Run full check.** Run `npm run check`; expected build, all tests, release verifier, reproducible build, and manifest verification PASS.
- [ ] **Step 2: Verify repository hygiene.** Run `git diff --check`, `git status --short`, and `git rev-parse HEAD`; record output in cooperation log.
- [ ] **Step 3: Freeze candidate.** Read `dist/CANDIDATE.sha256`, use the exact `sha256:<64hex>` value in the new handoff.
- [ ] **Step 4: Commit release artifacts.** `git add dist && git commit -m "发布 0.2.18 版本产物"`.

### Task 5: Push and supersede the reviewer handoff

**Files:**
- Modify: `cooperation.md` (append-only current task message and status evidence)

**Interfaces:**
- New handoff supersedes `TAC-20260819-14/handoff/001` and references the exact new candidate.
- Reviewer receives only a structured handoff; no reviewer message is authored by executor.

- [ ] **Step 1: Confirm current task tail and validator.** Run `python3 /home/jimmywang0417/.cc-switch/skills/two-agent-collaboration/scripts/validate_collaboration_log.py cooperation.md --json`; ensure current task is valid/open and latest activity is executor-owned.
- [ ] **Step 2: Push source and release commits.** Run `git push origin main`; verify `git rev-parse HEAD` equals `git rev-parse origin/main`.
- [ ] **Step 3: Append executor progress and new handoff.** Update candidate/status evidence, then append `executor:004` progress and `executor:005` handoff with `Supersedes-Handoff: TAC-20260819-14/handoff/001`; reread EOF and rerun validator.
- [ ] **Step 4: Start completion-gated monitor.** Run `python3 /home/jimmywang0417/.cc-switch/skills/two-agent-collaboration/scripts/monitor_collaboration.py --watch /home/jimmywang0417/oj-activity-monitor/cooperation.md TAC-20260819-14 any TAC-20260819-14/executor/005 --until closed`; do not ping again.
