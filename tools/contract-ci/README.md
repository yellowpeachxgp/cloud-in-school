# contract-ci：契约校验、同步与一致性检查

cloud-in-school/contracts/ 是唯一权威；day-in-school/contracts/ 只是同步副本。契约线修改契约时，必须先改云端权威副本，再用同步工具镜像到 Android；禁止把 Android 侧当作第二权威反向同步。

## 工具

- validate-contracts.mjs：校验本仓 SYSTEM_CONTRACT.md、OpenAPI 3.1.2、endpoint inventory 与 JSON Schema 的内部一致性。
- sync-contracts.mjs sync：先刷新云端 origin/main（默认），再把 contracts/ 逐字节镜像到 Android 工作区，包括删除 Android 侧多余文件；显式 --cloud-ref 或 --use-cloud-worktree 时由调用者自行保证来源新鲜。写入前先校验 cloud-root 是 cloud-in-school 仓库 checkout 或完整导出，再完整 staging 云端树、备份受影响文件；每个文件通过临时文件加 rename 替换，异常时按逆序回滚，避免留下半同步状态。
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
