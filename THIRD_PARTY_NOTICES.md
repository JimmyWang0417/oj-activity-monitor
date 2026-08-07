# Third-party notices

## OJBetter / Codeforces Better / AtCoder Better

- Project: OJBetter
- Upstream: <https://github.com/beijixiaohu/OJBetter>
- License: GNU General Public License v3.0
- Usage in this project: `src/request.js` 的 `gmRequest` 采用了 OJBetter `OJB_GMRequest` 的 settle-once Promise 包装思路并重新实现；Codeforces/AtCoder userscript 的同源访问和错误处理方式也作为设计参考。

本项目整体以 GPL-3.0-only 发布，因此该派生部分与项目许可证兼容。发布源码和 userscript 均保留此归属说明。

## Codeforces Grinding Heatmap Extension

- Upstream: <https://github.com/harrySquires123/Codeforces-Grinding-Heatmap-Extension>
- License: MIT
- Usage in this project: 仅参考“按日期显示活动热力图”的产品交互；没有复制其源代码或素材。热力图视图模型、DOM 和 CSS 均在本项目中独立实现。

## UniversalOJ / UOJ-System

- Upstream: <https://github.com/UniversalOJ/UOJ-System>
- License: MIT
- Usage in this project: QOJ HTML 适配器的路径、分页和语义表头契约参考了 QOJ 页脚指向的 UOJ-System 开源实现；解析器代码与测试 fixture 在本项目中独立编写，没有复制 PHP 源码。

## Public services

本项目在用户浏览器中读取 Codeforces API、AtCoderProblems API、VJudge、洛谷和 QOJ 的公开或当前会话可见数据。这些服务及其商标不属于本项目，也不表示其对本项目的认可。用户应遵守各站点的服务条款和请求频率限制。
