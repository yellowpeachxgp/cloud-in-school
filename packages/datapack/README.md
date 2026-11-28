# dis-datapack/v1 加载器与签名边界（W5-01）

本实现对齐 CT-06fix2 分支中 `contracts/schemas/dis-datapack-v1.schema.json` 的当前形状；本卡**不修改、不复制、不覆盖** `contracts/**`。CT-06 合入前，运行时校验器是手工镜像；CT-06fix2 若改变形状，必须由契约线先改权威契约，再同步更新两仓实现。

## 验收链

1. 输入必须是 exact UTF-8 bytes；非法 UTF-8、孤立代理项、重复键、超限嵌套和非有限 IEEE-754 数字全部 fail-closed。
2. 必须满足 exact-byte 链：`bytes == RFC8785(parse(bytes))`。空白、键序、字符串转义或数字写法语义等价但字节不同的输入一律拒绝，而不是规范化后接受。
3. RFC-8785 数字使用 IEEE-754 double 的 ECMAScript Number::toString 语义；Android 既有 `Json.canonical` 的 BigDecimal 归一化不得复用。
4. 通过 exact-byte 链后才做 Schema 形状校验：六类 item、必填/额外字段、枚举、日期、HTTPS source、packId 首段与 dot-free schoolId 一致性。

## detached Ed25519 签名

签名载荷唯一格式：

```text
dis-datapack/v1\n<canonical sha256 lowercase hex>\n
```

其中 canonical sha256 是 exact artifact bytes 的 SHA-256（exact-byte 链成立后二者相同）。detached signature 使用 CT-06 的 `algorithm/scheme/public_key_fingerprint/value/signed_payload_sha256` 形状；`public_key_fingerprint` 是 raw Ed25519 public key 的 SHA-256 lowercase hex。验签方只能使用宿主/发布流水线固定的信任根，不能把 catalog 或 artifact 自带数据当信任根。

## 状态边界

- artifact 本身没有独立 hard-expiry 字段。
- `today > reviewBy` 时加载结果为 `REVIEW_DUE`；等于 `reviewBy` 仍是 `CURRENT`。
- catalog `RETIRED`/下架是 W5-02 生命周期状态，不混入 artifact freshness。
- 篡改、schema 违例、签名无效、签名者不受信任都抛出结构化失败，不返回“可用但警告”的包。

## Android 对接边界（记录于配对实现）

`DisDatapackCampusGraphDecoder` 只把已验证 datapack 投影到 Campus Graph。当前无损支持：`procedure-guide`（placeRef 为 service/campus，或调用方显式 defaultCampusId）和 `facility-catalog`（placeRef 为 campus/building）。`indoor-graph` 的 edge/level、`opportunity-catalog`、`period-preset`、`pharmacy-catalog` 以及语义未明确的 `dependsOn` 全部 fail-closed；不得静默丢弃边、层级或依赖语义。

Room v18 已评估但**本卡不消耗**：当前 main 的 Room 迁移链仍处低位版本且 v12–v17 由前置/在途卡片按 D14 串行使用；W5-01 没有首个真实安装消费方，catalog lifecycle、签名信任与回滚语义也依赖 W5-02/CT-06 才能定稿。此时新增“已安装数据包表”会形成无消费者死 schema 并抢跑迁移顺序。v18 继续保留，待首个安装/回滚消费卡重新评估；当前加载器保持纯 JVM、无持久化副作用。
