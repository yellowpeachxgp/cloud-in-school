# tools/secret-scan

只读敏感信息扫描器，为 cis-gate 的 secrets 门禁提供仓库内容检查。脚本无第三方依赖，Node.js 22+ 可直接运行。

## 运行

    node tools/secret-scan/scan.mjs --root .
    node tools/secret-scan/scan.mjs --root . --format json
    node tools/secret-scan/scan.mjs --root . --extra-literal <运行时额外字面量>

退出码：0 表示未发现；1 表示有发现；2 表示扫描器自身、仓库状态或 allowlist 格式错误。文本输出只包含文件、行号、规则名和截断 SHA-256 指纹/长度，不打印命中内容，避免把候选秘密再次写入日志。JSON 输出额外包含 allowlist 使用计数，便于删除失效例外。

## 运行时敏感字面量

扫描器不内置、拼接或编码任何真实开发机账号、地址或 campus 根路径。运行时以下输入会参与匹配，且命中后仍只输出指纹：

- CIS_DEVBOX：解析完整值、authority、host 和用户部分；
- CIS_CAMPUS_ROOT：解析校园根路径；
- CIS_SECRET_SCAN_EXTRA_LITERALS：按换行分隔的额外字面量；
- --extra-literal：可重复传入的额外字面量。

cis-gate 或调用方只能在进程环境/命令行参数中传入这些值，不得把真实值写入仓库。没有运行时输入时，扫描器仍执行通用 IP、user@host、Token、私钥、凭据赋值和 .env 检查。/Volumes/... 本机 worktree 路径按 AUTO-007 不属于 D16 秘密，不作为违规扫描目标。

## 覆盖规则

1. IP 字面量：默认扫描所有非白名单 IPv4/IPv6，包括私网、公网、链路本地等可能指向真实基础设施的地址。默认白名单仅限 unspecified、loopback、RFC 3849/5737 文档地址、组播/保留地址。
2. user@host：扫描带点主机名的 user@host 形态；Kotlin 的 this/return/break/continue 标签语义会排除。合成 URL userinfo 安全测试只允许逐指纹、逐行豁免。
3. Token/Key 格式：GitHub、GitLab、OpenAI/Anthropic 风格、Stripe、Slack、AWS、Google API、JWT、npm、PyPI，以及 URI 内嵌用户名和密码。
4. 凭据赋值：扫描 JSON/YAML 中带引号或不带引号的 password/passwd/pwd/passphrase/passcode/token/cookie/secret/apiKey/accessKey 类键；扫描 shell 风格无空格小写或大写 env 赋值；扫描 Authorization: Bearer <值>。模板变量、尖括号占位符、明显拼接片段和 HTTP set-cookie 清除头不作为命中；这不构成对 password/token/cookie 的目录级或宽泛忽略。
5. 私钥头：PEM 私钥 BEGIN 行和 PGP PRIVATE KEY BLOCK 行。
6. .env：跟踪或未跟踪的 .env、.env.local、.env.production 等文件；.env.example、.env.sample、.env.template 视为安全模板，但其中的真实凭据仍应删除。
7. 已知的非网络误报会做语义排除，例如 Chrome User-Agent 中的四位版本号、OpenJDK/JDK 版本号、Kotlin 作用域标签。

这是仓库内容门禁，不替代 Git 历史审计、运行时 secret manager 或人工审阅。压缩包、图片等二进制文件不解析；超过 20 MiB 的文本文件会输出 warning，后续如需覆盖应分块扫描。

## 白名单

allowlist.txt 是唯一的仓库级例外文件；两个仓库各自维护最小集合，不共用并集。每行格式：

    <rule> <sha256-fingerprint> <path-glob> <line> # owner=<owner> expiry=<YYYY-MM-DD> class=<class> reason=<原因>

fingerprint 是命中值本身的 SHA-256 十六进制摘要；因此白名单文件不需要写入 IP、user@host、Token、密码或 Cookie 原文。line 是精确行号；只有经安全审阅的特殊情况才可使用 *。owner、expiry、class、reason 均为必填元数据，过期或格式错误会使扫描器以退出码 2 fail-closed。

规则：

- 必须使用窄路径 + 窄指纹 + 精确行号；禁止用 ** 全仓豁免，禁止按目录、文件或规则宽泛豁免。
- 只允许 INF-01 前已经存在且经证据确认的合成测试夹具、合成 SSRF 输入、或已公开拓扑/服务地址；真实开发机、真实账号/路径、真实凭据不得豁免。
- class=synthetic-fixture 表示合成测试输入；class=topology-pending-user-review 表示生产或公开服务拓扑例外，必须单独列入用户复核。
- 每条都必须写 owner、expiry 和原因；新增或放宽白名单的 PR 需要按凭据/安全相关变更交叉审阅。
- 路径 glob 中 * 不跨目录，** 可跨目录；即使使用 **，指纹和行范围仍只允许精确命中。
- 如果同一测试文件新增另一个密码、Token、Cookie 或 IP，即使路径相同也会再次失败，必须单独审查并单独加指纹。

## 合成自测

运行：

    node tools/secret-scan/selftest.mjs

自测在临时 git 仓库中生成合成正/负例，不使用 node --test，不访问网络，不写入仓库。覆盖：quoted/unquoted JSON/YAML key、lowercase/uppercase env、Authorization Bearer、PGP/PEM private key、运行时 extra literal、模板占位符和非凭据 token 负例。期望输出：

    SECRET_SCAN_SELFTEST_PASS positiveFindings=13 negativeFindings=0

## cis-gate 集成

cis-gate 的 secrets 门禁应在检出待测 SHA 后执行：

    node tools/secret-scan/scan.mjs --root .

如需让动态开发机地址、账号或 campus 根路径检测生效，可在执行前仅在进程环境中传入 CIS_DEVBOX、CIS_CAMPUS_ROOT 或 CIS_SECRET_SCAN_EXTRA_LITERALS，或追加 --extra-literal；不得把真实值写入仓库、allowlist、日志或 PR。