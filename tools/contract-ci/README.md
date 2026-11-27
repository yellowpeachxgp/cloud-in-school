# contract-ci：契约校验、同步与一致性检查

cloud-in-school/contracts/ 是唯一权威；day-in-school/contracts/ 只是同步副本。契约线修改契约时，必须先改云端权威副本，再用同步工具镜像到 Android；禁止把 Android 侧当作第二权威反向同步。

## 工具

- validate-contracts.mjs：校验本仓 SYSTEM_CONTRACT.md、OpenAPI 3.1.2、endpoint inventory 与 JSON Schema 的内部一致性，并对 contracts/**/*.yaml 执行 strict duplicate-key 文本层扫描；扫描器每次运行先执行负例/对照自证（重复 path key、plain/single-quoted/double-quoted 三形态等价键与跨 indentless sequence 重复键必须失败；双引号 \\x/\\u/\\U escape 先 canonicalize 再比对；key/value 位置 anchor/tag/alias、merge key 与 flow mapping 均 fail-closed；序列项合法重复、block scalar、plain scalar 占位符/折行/续行内联注释与注释 tab 不得误报；plain scalar 续行中的 mapping 语法必须失败），再严格检查每个 path template 参数都有 in: path 且 required: true 的声明；反向检查已声明 path 参数必须存在于模板。生命周期状态分为 active / planned / reserved：active 必须与运行时 100% 双向一致；planned/reserved 是显式 contract-only，要求 OpenAPI `x-dis-status`、inventory `status` 与 `contract_card` 完整一致，不计入运行时缺失，也不能被运行时装配提前占用。
- sync-contracts.mjs sync：默认先执行 git fetch origin +refs/heads/main:refs/remotes/origin/main，再读取云端 git origin/main；显式 --cloud-ref 或 --use-cloud-worktree 时由调用者自行保证来源新鲜。写入前先校验 cloud-root 是 cloud-in-school 仓库 checkout 或完整导出，再完整 staging 云端树、备份受影响文件；每个文件通过临时文件加 rename 替换，异常时按逆序回滚，避免留下半同步状态。
- sync 在计划/执行前 fail-closed：云端或 Android contracts 内仅大小写/Unicode 规范化不同的 alias、跨仓 case-only rename、file↔directory 冲突都会拒绝；sparse checkout 不支持并明确拒绝，避免把缺失文件误当权威删除。
- sync-contracts.mjs check：递归比较两棵 contracts/ 树的文件清单和 SHA-256；任一缺失、多余或哈希不同都失败。cloud-root 同样必须是 cloud-in-school 仓库 checkout 或完整导出。
- sync-contracts.mjs fingerprint：输出一棵 contracts/ 树的确定性哈希清单和 CONTRACTS_TREE_SHA256。

## 常用命令

在 Android 仓库根目录同步已发布的云端权威契约：

    node tools/contract-ci/sync-contracts.mjs sync \
      --cloud-root ../cloud-in-school \
      --android-root .

只在本地调试云端未提交工作区时，显式使用：

    node tools/contract-ci/sync-contracts.mjs sync \
      --cloud-root ../cloud-in-school \
      --android-root . \
      --use-cloud-worktree

比较两个 checkout：

    node tools/contract-ci/sync-contracts.mjs check \
      --cloud-root ../cloud-in-school \
      --android-root .

## CI 方向

云端仓库的 CI 验证权威契约本身的结构并输出权威哈希清单；Android 仓库的 CI 下载云端 main，再运行 sync-contracts.mjs check 做跨仓逐字节比对。这个方向是有意的：权威侧不等待同步副本，避免成对契约 PR 在合并顺序上死锁；同步副本必须跟上权威 main。
