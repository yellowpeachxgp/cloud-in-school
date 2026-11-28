# packages/content-catalog（W5-02）

CT-06 内容包目录运行时。覆盖 10 个 active 端点：目录、版本列表/详情、artifact 下载、提交、提交状态、审核队列、审核决策、发布与下架。

## 安全边界

- 提交 artifact 是**未签名候选**；服务端只做严格解包/Schema/provenance/digest/体积校验并接受进入审核队列。接受提交不代表发布、验证或学校认可。
- 发布时必须由独立 content_pack.publish 授权主体提交 detached Ed25519 signature；服务端重新读取 artifact、重新做 exact-byte/Schema/格式/kind/provenance/版本顺序校验，再用宿主固定信任根验签。信任根为空或签名者不在根内一律 fail-closed。
- reviewer 必须持有匹配 school_id 的 content_pack.review operations grant，且不可审核自己提交的包；publish/retire 分别是独立 operations grant。三项运营权限均可由 CLOUD_OPERATIONS_SCHOOL_GRANTS bootstrap 按 user+school+permission 显式下发。
- artifact bytes 不进入 JSON snapshot，也不由 submission/read/export API 返回；运行时写入 content-addressed sidecar，下载和发布前都做 digest+size 读取校验。
- RETIRED 只追加生命周期元数据；版本详情仍可审计，下载 fail-closed 为 410，catalog 默认不再选择该版本。

## 信任根配置

createCampusCloudApp 可注入：

- contentPackTrustedKeys：{ [rawEd25519PublicKeySha256Hex]: spkiOrRawPublicKeyBase64 }，用于 dis-datapack/v1，也可作为 legacy fallback。
- contentPackLegacyPublisherKeys：{ [manifest.publisher]: { [fingerprint]: publicKeyBase64 } }，用于按 legacy manifest publisher 进一步限定信任根。

生产/开发机也可用环境变量 CONTENT_PACK_TRUST_ROOT_JSON 注入同一结构：{ "trusted_keys": { fingerprint: publicKeyBase64 }, "legacy_publisher_keys": { publisher: { fingerprint: publicKeyBase64 } } }。启动时会校验 fingerprint 与 raw public key 一致；一旦配置 legacy publisher 映射，未列名 publisher 不得回退到全局密钥。

密钥材料只能是**公钥**；私钥不得进入云端配置、日志、快照或仓库。没有配置匹配信任根时发布失败，这是故意 fail-closed，不是隐式信任 artifact、catalog 或提交者提供的数据。

## 签名载荷

- dis-datapack/v1 复用 packages/datapack：dis-datapack/v1 + LF + canonical artifact sha256 + LF。
- dis-campus-plugin/v1：dis-campus-plugin/v1 + LF + canonical manifest sha256 + LF + files digest + LF；files digest 与 Android 既有的排序 path=sha256 长度前缀拼接算法一致。

## 数据权利

/me/data-export 只导出提交/审核/发布元数据，不导出 artifact bytes。/me/data-delete 删除未发布提交及其审核行；已发布历史保留公共 artifact 与 digest，但 submitter/reviewer/publisher/retire 操作者引用全部假名化，operations grant 与速率窗口删除。
