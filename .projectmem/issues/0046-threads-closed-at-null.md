# #0046 归档会话自动替代后，旧 threads 记录仍为 closed_at NULL；同一项目/权限可能出现两个本地活跃会话，导致会话菜单状态失真。

- 2026-08-22T03:20:22Z `issue`: 归档会话自动替代后，旧 threads 记录仍为 closed_at NULL；同一项目/权限可能出现两个本地活跃会话，导致会话菜单状态失真。 [src/orchestrator/app-task-executor.ts:259]
- 2026-08-22T03:22:35Z `attempt`: 首次实现会话替代账本关闭时，saveThread 的可选旧会话参数接收到 string | null | undefined，TypeScript 类型检查失败；需在调用处规范为 undefined。 [src/orchestrator/app-task-executor.ts:260] (failed)
- 2026-08-22T03:22:55Z `attempt`: 修正可选旧会话 ID 后类型检查通过，但新增 SQLite 回归测试直接断言 .all() 的 any 返回值，被 ESLint 拒绝；需显式标注查询行类型。 [test/storage/database.test.ts:49] (failed)
- 2026-08-22T03:23:24Z `attempt`: 显式 SQLite 行类型后，Vitest expect.any(Number) 仍因严格 no-unsafe-assignment 被 ESLint 拒绝；改为直接断言 closed_at 的运行时类型。 [test/storage/database.test.ts:49] (failed)
- 2026-08-22T03:24:06Z `attempt`: 将替代会话持久化改为同一 SQLite 事务：先关闭旧活跃会话，再保存新会话；执行器与存储层回归测试、全量检查和发布测试均通过。 [src/runtime/store-adapter.ts:103] (worked)
- 2026-08-22T03:24:06Z `fix`: 归档会话自动替代时，saveThread 在事务内关闭旧活跃 threads 记录后保存替代会话，恢复每项目/权限档位一个活跃会话的账本一致性。 [src/runtime/store-adapter.ts:103]
