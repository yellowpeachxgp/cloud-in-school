# tools/secret-scan

只读敏感信息扫描器，为 cis-gate 的 secrets 门禁提供仓库内容检查。脚本无第三方依赖，Node.js 22+ 可直接运行。

## 运行

    node tools/secret-scan/scan.mjs --root .
    node tools/secret-scan/scan.mjs --root . --format json

退出码：0 表示未发现；1 表示有发现；2 表示扫描器自身或仓库状态错误。输出只包含文件、行号、规则名和 SHA-256 指纹/长度，不打印命中内容，避免把候选秘密再次写入日志。

## 覆盖规则

1. 开发机地址：优先匹配运行环境中的 CIS_DEVBOX 值；同时检测 user@IPv4 形式。扫描器和仓库配置不写死真实开发机地址。
2. IPv4/IPv6 字面量：默认扫描所有非白名单地址，包括私网、公网、链路本地等可能指向真实基础设施的地址。默认白名单仅限 unspecified、loopback、RFC 3849/5737 文档地址、组播/保留地址。
3. Token/Key 格式：GitHub、GitLab、OpenAI/Anthropic 风格、Stripe、Slack、AWS、Google API、JWT、npm、PyPI，以及 URI 内嵌用户名和密码。
4. 私钥头：PEM 私钥 BEGIN 行。
5. .env：跟踪或未跟踪的 .env、.env.local、.env.production 等文件；.env.example、.env.sample、.env.template 视为安全模板。
6. 已知的非网络误报会做语义排除，例如 Chrome User-Agent 中的四位版本号、OpenJDK/JDK 版本号。

这是仓库内容门禁，不替代 Git 历史审计、运行时 secret manager 或人工审阅。压缩包、图片等二进制文件不解析；超过 20 MiB 的文本文件会输出 warning，后续如需覆盖应分块扫描。

## 白名单

allowlist.txt 是唯一的仓库级例外文件。每行格式：

    ip <精确IP或IPv4/CIDR> <路径glob> # 原因
    token <规则名> <路径glob> # 原因

示例（文档保留地址，默认其实已允许）：

    ip 198.51.100.10 docs/** # 仅示例，不表示真实主机

规则：

- 必须使用最窄路径 glob；禁止用 ** 全仓豁免，除非主代理和用户明确批准。
- 每条都必须写原因；新增或放宽白名单的 PR 需要按凭据/安全相关变更交叉审阅。
- 路径 glob 中 * 不跨目录，** 可跨目录。
- allowlist.txt 自身的 IP 文本是策略声明，不作为命中内容重复报告；这不意味着可以任意加入真实开发机地址。
- 合成测试攻击向量可以按“精确 IP + 精确测试文件”豁免；真实开发机、生产运维入口和凭据不得豁免。

## cis-gate 集成

cis-gate 的 secrets 门禁应在检出待测 SHA 后执行：

    node tools/secret-scan/scan.mjs --root .

如需让动态开发机地址检测生效，可在执行前仅在进程环境中传入 CIS_DEVBOX；不得把该值写入仓库、命令行、日志或文件。
