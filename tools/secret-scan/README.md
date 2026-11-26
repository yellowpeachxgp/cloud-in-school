# tools/secret-scan

只读敏感信息扫描器，为 cis-gate 的 secrets 门禁提供仓库内容检查。脚本无第三方依赖，Node.js 22+ 可直接运行。

## 运行

    node tools/secret-scan/scan.mjs --root .
    node tools/secret-scan/scan.mjs --root . --format json

退出码：0 表示未发现；1 表示有发现；2 表示扫描器自身或仓库状态错误。输出只包含文件、行号、规则名和 SHA-256 指纹/长度，不打印命中内容，避免把候选秘密再次写入日志。

## 覆盖规则

1. 开发机地址：优先匹配运行环境中的 CIS_DEVBOX 值；同时内置检查已知开发机账号和校园根路径字面量。为避免自我暴露，这些字面量在源码中拼接生成，不以完整形式写入仓库。
2. user@host：扫描带点主机名的 user@host 形态；Kotlin 的 this/return/break/continue 标签语义会排除。合成 URL userinfo 安全测试只允许逐指纹豁免。
3. IPv4/IPv6 字面量：默认扫描所有非白名单地址，包括私网、公网、链路本地等可能指向真实基础设施的地址。默认白名单仅限 unspecified、loopback、RFC 3849/5737 文档地址、组播/保留地址。
4. Token/Key 格式：GitHub、GitLab、OpenAI/Anthropic 风格、Stripe、Slack、AWS、Google API、JWT、npm、PyPI，以及 URI 内嵌用户名和密码。
5. password/token/cookie 类赋值：扫描凭据含义明确的键名（例如 password、passwd、pwd、cookie、secret、apiKey/accessKey、accessToken/refreshToken/authToken、rawToken/passToken/serviceToken/sessionToken 等）后直接跟随的字符串字面量，以及环境变量式大写赋值。字符串内部的钥匙名、模板插值和非凭据语义 token（如 matchedToken、mutationToken）不作为命中；这不构成对 password/token/cookie 的目录级或宽泛忽略。
6. 私钥头：PEM 私钥 BEGIN 行。
7. .env：跟踪或未跟踪的 .env、.env.local、.env.production 等文件；.env.example、.env.sample、.env.template 视为安全模板。
8. 已知的非网络误报会做语义排除，例如 Chrome User-Agent 中的四位版本号、OpenJDK/JDK 版本号、Kotlin 作用域标签。

这是仓库内容门禁，不替代 Git 历史审计、运行时 secret manager 或人工审阅。压缩包、图片等二进制文件不解析；超过 20 MiB 的文本文件会输出 warning，后续如需覆盖应分块扫描。

## 白名单

allowlist.txt 是唯一的仓库级例外文件。每行格式：

    <rule> <sha256-fingerprint> <path-glob> # 原因

fingerprint 是命中值本身的 SHA-256 十六进制摘要；因此白名单文件不需要写入 IP、user@host、Token、密码或 Cookie 原文。规则名示例：ip-literal、ip-literal-v6、user-at-host、jwt、sensitive-assignment。

规则：

- 必须使用窄路径 + 窄指纹；禁止用 ** 全仓豁免，禁止按目录、文件或规则宽泛豁免。
- 只允许 INF-01 前已经存在且经证据确认的合成测试夹具、合成 SSRF 输入、或已公开拓扑文档地址；真实开发机、真实账号/路径、真实凭据不得豁免。
- 每条都必须写原因；新增或放宽白名单的 PR 需要按凭据/安全相关变更交叉审阅。
- 路径 glob 中 * 不跨目录，** 可跨目录；即使使用 **，指纹仍只允许一个精确命中值。
- 如果同一测试文件新增另一个密码、Token、Cookie 或 IP，即使路径相同也会再次失败，必须单独审查并单独加指纹。
- 合成测试攻击向量可以按“精确指纹 + 精确测试文件”豁免；真实开发机、生产运维入口和凭据不得豁免。

## cis-gate 集成

cis-gate 的 secrets 门禁应在检出待测 SHA 后执行：

    node tools/secret-scan/scan.mjs --root .

如需让动态开发机地址检测生效，可在执行前仅在进程环境中传入 CIS_DEVBOX；不得把该值写入仓库、命令行、日志或文件。门禁命令中的校园根路径统一通过 CIS_CAMPUS_ROOT 或 <campus-root> 表达。
