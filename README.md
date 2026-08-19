# OJ Activity Monitor

OJ Activity Monitor（仓库名：`oj-activity-monitor`）是一个本地优先的油猴脚本，用一个面板按“人”汇总最近若干天的 Online Judge 活动。发布脚本继续使用原有的 `OJ Monitor` 安装标识，以兼容已经安装的版本和本地数据。目前支持：

- Codeforces Problemset
- Codeforces Gym（与 Problemset 全程分开）
- AtCoder
- VJudge
- 洛谷
- 牛客
- QOJ

每个监测分组表示一个人，分组名称和各网站用户名都可编辑。面板提供 GitHub 风格热力图、每日过题数/提交数、跨分组比较、来源筛选和单日提交明细。热力图可在“通过题数/提交次数”间切换，逐日统计可折叠；网站/来源筛选会同时更新热力图、分组比较汇总和提交明细。

## 安装

1. 在浏览器安装 Tampermonkey 或兼容的 userscript 管理器。
2. 打开 [OJ Monitor 安装链接](https://raw.githubusercontent.com/JimmyWang0417/oj-activity-monitor/main/dist/oj-monitor.user.js)，由 userscript 管理器确认安装。
3. 进入 Codeforces、AtCoder、VJudge、洛谷、牛客竞赛或 QOJ 任一受支持页面。
4. 点击右上角“`OJ 监测`”，或从油猴菜单选择“打开 OJ 监测面板”。
5. 创建以被监测者姓名命名的分组，再添加网站用户名或 UID。牛客可填写竞赛用户名或个人主页 URL 中的数字 UID；若公开 Rating 搜索无法唯一解析用户名，请改填 UID。Codeforces 可分别启用 Problemset 和 Gym。

脚本不需要被监测者登录。牛客的公开“TA 的练习 / 编程题”列表无需登录，脚本不会打开需要登录的提交源码详情。洛谷提交记录要求脚本安装者在当前浏览器中登录，并且本地账号有权查看对应记录；QOJ 提交列表和用户页也要求脚本安装者先登录 QOJ。洛谷会话代理只在规范站点 `https://www.luogu.com.cn/` 注册；裸域 `https://luogu.com.cn/` 会跨源跳转到 `www`，不能作为已登录会话标签页。

## 自动更新

- v0.2.15 起，已安装脚本通过 `@updateURL` 检查轻量的 [`dist/oj-monitor.meta.js`](dist/oj-monitor.meta.js)。当其中的 `@version` 更高时，userscript 管理器再从 `@downloadURL` 下载完整的 [`dist/oj-monitor.user.js`](dist/oj-monitor.user.js)。脚本自身不会下载并执行远程代码。
- Tampermonkey 必须允许该脚本检查更新；检查周期由扩展设置决定。需要立即检查时，可在 Tampermonkey 管理面板中对该脚本执行“检查更新”。GitHub raw 文件可能有短暂缓存，因此刚推送后不一定立即可见。
- 从 v0.2.14 或更早版本升级时，建议先手动打开一次上面的安装链接。安装页仍显示同一个 `@name` 与 `@namespace`，会更新原脚本并保留其本地配置和统计数据；此后版本才具备仓库声明的固定自动更新地址。
- 自动更新只跟随 GitHub `main` 中已经提交的发布产物。若仓库里的 metadata、完整 bundle 或版本号不一致，发布校验会失败，不能形成有效候选。
- 自动化校验覆盖更新契约和发布产物一致性，不等同于所有 Firefox/Tampermonkey 版本的真实端到端更新测试。若自动检查没有触发，请先确认扩展允许检查更新，再使用安装链接手动覆盖更新。

### 牛客账号配置与排错

- 推荐直接填写牛客竞赛用户名。脚本会通过公开 Rating 搜索解析数字 UID，再读取该 UID 的公开练习记录。
- 竞赛用户名按 ASCII 大小写不敏感的完整名称匹配，下划线等字符不会被删除；只改变字母大小写可以匹配，删除下划线或只填写名称子串不会匹配。
- 搜索结果必须只对应一个 UID。账号未进入 Rating 索引、搜索结果重名或页面结构无法验证时，脚本会停止并提示改填数字 UID，不会猜测账号或把失败记录成零提交。
- 数字 UID 可从个人练习页地址 `/acm/contest/profile/{uid}/practice-coding` 中取得。直接填写 UID 会跳过 Rating 搜索，适合无法通过竞赛用户名解析的账号。
- 修改已保存的牛客用户名或 UID 后，脚本会清理该账号的旧提交缓存和来源状态；重新获取即可按新标识建立记录。
- 文档和自动化测试只使用合成账号标识，不记录用于人工联调的真实用户名、UID、学校或其他个人资料。

## 浏览器会话与站点验证

选择 userscript 的原因，是让请求从用户已正常访问 OJ 的浏览器环境发出：

- 对洛谷/QOJ 的登录受限请求，脚本在目标标签页注入一个仅允许白名单同源 GET 的主世界请求端点，以该页面的 `fetch(..., { credentials: "include" })` 和第一方 Cookie 发出请求；端点不读取或传递 Cookie 内容。
- 跨域接口使用 `GM_xmlhttpRequest`，并在 Tampermonkey 5.2+ 显式把目标 OJ 作为 Cookie 分区的顶层站点，以尽量复用该站本地会话。
- Codeforces 同源页面会额外尝试浏览器可见的 Gym 提交补充，并与公开 API 按 submission ID 去重。
- QOJ 页面同源请求复用本地 `UOJSESSID` 与已经通过的 Cloudflare 浏览器状态；未登录或未过验证时会给出明确提示。
- 脚本识别 Cloudflare challenge、洛谷网宿 `ws-action: cc` 验证、302 登录跳转及登录/验证 HTML、403 和 429，并显示明确状态，不会把失败解释成零提交或误报为 JSON 结构变化。

这不等于“破解”或保证绕过 Cloudflare。浏览器或扩展版本仍可能限制跨站 Cookie，Cloudflare clearance 也可能要求同源页面环境；遇到验证时，应先直接打开对应 OJ 完成验证，再在该站同源页面重新获取。脚本不会读取、导出或上传 Cookie、密码、Token 或提交源码。

## 数据源与统计口径

| 来源 | 提交数据 | 关键规则 |
| --- | --- | --- |
| Codeforces | 官方 `user.status`、`contest.list`；同源 HTML 仅作 Gym 补充 | 使用两份 contest 集合分类，禁止按 ID 位数猜 Gym；`verdict === "OK"` 才算通过 |
| AtCoder | AtCoderProblems API v3 | 官方用户页独立验证账号；每次 API 请求至少间隔 1 秒；`AC` 才算通过 |
| VJudge | `/status/data` | 基础窗口最多 200 条，必要时按穷尽结果枚举切片；仍饱和则显示 `partial` |
| 洛谷 | 用户搜索 API、旧式 `DataResponse` 记录页 | 固定请求规范域 `www.luogu.com.cn`；记录请求同时使用 `_contentOnly=1` 与 `x-luogu-type: content-only`，登录门禁时自动交给已打开的 `www` 洛谷标签页并在页面主世界以第一方 Cookie 执行；HTML 中存在 `script#lentille-context` 时仍作兼容回退，但不把普通 HTML 误报成退出登录；按时间倒序持续分页到窗口起点/末页且不设默认页数上限；数值 `12`、文本 `AC`/`Accepted` 算通过 |
| 牛客 | 公开 Rating 搜索及 `/acm/contest/profile/{uid}/practice-coding` HTML | 支持竞赛用户名或数字 UID；用户名仅在 Rating 搜索返回大小写折叠后名称精确匹配且唯一 UID 时解析，数字 UID 不增加搜索请求；仅统计“TA 的练习 / 编程题”表格；固定每页 50 条并按时间倒序抓取到窗口起点/末页，不设默认页数上限；只有“答案正确”算通过；页面时间不含 offset，当前按 UTC+8 解释 |
| QOJ | 登录后 `/submissions?submitter=&page=` HTML | Cloudflare 拦截后台请求时自动交给已打开且通过验证的 QOJ 标签页；支持官方连字符团队账号；按时间边界分页且不设默认页数上限；从 `.uoj-username`/用户主页链接读取语义提交者，忽略独立的辅助 `#` 后仍做严格等值校验；能证明筛选身份的空结果页精确记为 0；`AC`/`Accepted`（含站点的勾号）或分数恰为 100 才算通过 |

“过题数”是某自然日内获得 Accepted/AC 的不同题目数；同题同日多次 AC 只算一道。跨网站直接求和，不做跨站题目去重。时区可选浏览器本地或 `Asia/Shanghai`。

热力图颜色档位会直接显示精确区间：通过题数为 `0 / 1 / 2–3 / 4–6 / ≥7`，提交次数为 `0 / 1–2 / 3–5 / 6–9 / ≥10`；悬停每天的格子仍会显示两项精确数值。

洛谷记录按时间降序连续分页；只要页内/跨页顺序正常、没有重复或重叠页，并读到早于统计起点的记录（或经末页/总数证明已读完），窗口内提交数和去重 AC 题数就是精确值，不显示 `≥`。任何来源未能证明完整覆盖时，格子和表格中的数字才作为已知下界，以 `≥` 和 `partial` 展示。VJudge 的未知截断不伪造遗漏数；Codeforces 已读到但无法归类的记录单独计入排除记录。

## 本地数据与多标签页

- `GM_*Value` 是配置、提交缓存、每日统计、来源状态和调度状态的唯一真源，可在六个平台间共享。
- `www.luogu.com.cn` 和 QOJ 标签页会注册同源会话代理；面板可在任意受支持的 OJ 页面打开，登录/验证受限请求通过共享存储交给目标站点标签页的页面主世界执行并返回，不要求在目标页重新打开面板。目标标签页需保持打开并运行同一新版脚本。
- Firefox 的页面 binding 降级会用 `cloneInto`（可用时）或页面 realm 构造器创建 fetch 参数，避免把油猴 sandbox 对象直接传入 Xray 包装的页面函数。普通 GM 请求默认使用 Tampermonkey 的常规 Cookie jar；只有调用者明确给出分区键时才使用 `cookiePartition`。
- 提交按账号/网站/来源/月分块，每日统计按分组/账号/来源/年分块。
- 后续刷新复用最近一次完整覆盖留下的可信提交边界；按时间倒序的来源在重新遇到该 submission ID 且继续读到严格更早的时间后即可停止分页。可信 ID 消失或时间变化时自动回退原有时间下界；AtCoder 继续使用其原生 `from_second` 游标。
- 提交缓存只按 submission ID 合并更新，不会用本轮固定页数或 `partial` 结果覆盖历史记录；同 ID 重判会更新 verdict 而不重复计数。来源状态分别保存“本轮结果”和“最近一次完整可信状态”，失败/截断不会清空可信边界；每 24 小时禁用 ID 快路径并从统计窗口起点校准一次，以捕获迟到记录和重判。
- 全局刷新使用带所有者、代次、到期时间和心跳的共享租约；非 owner 标签页会等待并自动读取共享结果，owner 崩溃且租约过期后自动接管；域名请求串行并共享下一允许请求时间。
- 只有实际打开的面板会自动获取，最短缓存有效期为 15 分钟；获取过程可取消。
- 诊断日志只包含来源、状态、耗时、数量、页面 origin、分页停止原因及脱敏传输链。洛谷的 `transportAttempts` 逐跳记录 requested/actual transport、错误状态、HTTP 状态和去除 query/hash 的最终 origin+pathname；若页面传输因不同源或缺少 DOM/CustomEvent 而根本不能尝试，也会以 `actual: "not-attempted"` 和具体原因留痕。主世界安装失败后回退到 Firefox binding 时保留 `fallback` 原因。不包含 Cookie、Token 或完整请求参数。

第三方 [luogu-api-docs](https://0f-0b.github.io/luogu-api-docs/) 将 `/record/list` 明确标为旧式 `DataResponse`：使用 `_contentOnly` 参数或 `x-luogu-type: content-only`；`x-lentille-request` 只适用于 `LentilleDataResponse`。v0.2.10 的真实已登录 Firefox 结果证明 Lentille 头在记录路由只得到无数据 HTML，因此 v0.2.11 恢复旧式协商。匿名请求会先跳转到 `/auth/login`，其最终页面格式不能用于反推已认证 `/record/list` 的响应契约。

## 开发

项目无运行时或构建依赖，需要 Node.js 20 或更高版本：

```bash
npm test
npm run build
npm run check
```

`package.json` 是发布版本的唯一来源。构建脚本会把版本写入 metadata，将 `src/` 中的 CommonJS 模块打成单个 [`dist/oj-monitor.user.js`](dist/oj-monitor.user.js)，并同时生成只含同一 metadata block 的 [`dist/oj-monitor.meta.js`](dist/oj-monitor.meta.js)。校验会检查两个产物的身份、版本、自动更新 URL、授权域名、运行时 API 版本以及是否残留本地 `require()`。

发布新版本时：

1. 只提升 `package.json` 的 `version`，不要手工编辑构建产物中的版本。
2. 运行 `npm run check`，确认完整测试、release verifier 和 `SOURCE-MANIFEST.sha256` 均通过。
3. 检查并在同一个提交中纳入源码、`package.json`、`dist/oj-monitor.meta.js`、`dist/oj-monitor.user.js`、`dist/SOURCE-MANIFEST.sha256` 与 `dist/CANDIDATE.sha256`。
4. 将该提交推送到 GitHub `main`；轻量 metadata 和完整脚本必须一起发布，避免客户端先看到新版本却下载到旧 bundle。

测试包含 URL/命名空间、判题映射、时区聚合、存储校验、租约/限速、六个平台 fixture、分页完整性/截断、刷新隔离和视图模型。`test/browser-smoke.html` 可在本地浏览器中加载构建产物，使用模拟 GM 存储检查完整面板布局。

## 已知限制

- AtCoder 提交依赖第三方 AtCoderProblems；数据源不可用时不会遍历全站比赛页降级。
- VJudge 的单过滤窗口硬上限为 200，极高频用户即使切片仍可能只得到下界。
- Codeforces 私有/受限 Gym 能否补充取决于本地账号权限和浏览器同源会话；页面补充被明确标成降级数据。
- 洛谷数据可见性由本地登录状态、被监测者设置和站点权限共同决定。
- 牛客仅覆盖公开个人页的“TA 的练习 / 编程题”HTML，不保证包含比赛榜单、笔面试或其他产品线的提交；竞赛用户名通过公开 Rating 搜索解析，未进入该索引、重名或无法唯一匹配的账号必须改填数字 UID。Rating 与练习页 HTML 都没有版本化接口承诺，页面时间也不携带时区 offset，当前实现明确假设为 UTC+8。身份、表头、空态或分页证据不足时会失败关闭，不把未知页面记为零。
- QOJ 目前关闭匿名提交列表；没有登录或 Cloudflare 会话时无法采集。解析契约依据 QOJ 当前页面行为与其 UOJ 开源基线；只有同时确认 `/submissions` 筛选表单、目标用户名和空结果页面身份时才显示精确零，任意无表头 HTML 仍标记为结构变化。
- 首期不支持 Codeforces Group、Polygon、Acmsguru 等额外命名空间。

## 许可证与来源

项目采用 [GPL-3.0-only](LICENSE)。跨域 Promise 包装器参考并改写自 GPL-3.0 的 OJBetter/Codeforces Better/AtCoder Better；完整说明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
