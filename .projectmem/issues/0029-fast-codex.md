# #0029 历史问题：模型、推理强度和 Fast 状态没有跟随本机 Codex

- 2026-08-14T10:48:10Z `issue`: 历史问题：模型、推理强度和 Fast 状态没有跟随本机 Codex [BUG_LOG.md]
- 2026-08-14T10:48:11Z `attempt`: 历史根因：模型列表虽来自 App Server，但“当前值”只读取项目数据库覆盖或目录默认项；未读取 `config/read` 的本机有效配置，也没有保存和传递 App Server 的 `serviceTier`。 [BUG_LOG.md] (worked)
- 2026-08-14T10:48:11Z `fix`: 历史修复：菜单与 `/status` 按“项目覆盖 → 当前工作区的本机 Codex 配置 → 模型目录默认”解析有效状态；Fast 档位直接读取当前模型的 `serviceTiers`，项目级选择存入 SQLite 并传给 thread/turn。清除项目覆盖后恢复跟随本机。；验证：交互测试覆盖本机模型、`low` 推理强度和 `default` 服务档位的展示；真实 App Server 合约检查确认本机 Fast 档位为 `priority`。 [BUG_LOG.md]
- 2026-08-14T10:52:41Z `fix`: 历史修复与验证详情已完整归档 [Projectmem 历史问题]
