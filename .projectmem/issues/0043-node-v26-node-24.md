# #0043 交互式终端默认 Node v26 超出项目支持范围，手动执行本项目命令时可能绕过 Node 24 约束

- 2026-08-21T03:12:54Z `issue`: 交互式终端默认 Node v26 超出项目支持范围，手动执行本项目命令时可能绕过 Node 24 约束 [package.json]
- 2026-08-21T03:16:03Z `attempt`: 首次追加 Node 24 PATH 的补丁未匹配 .zshrc 文件末尾上下文，未修改用户 shell 配置。 [/Users/lemeng.shi/.zshrc] (failed)
- 2026-08-21T03:16:17Z `attempt`: 在 zsh PATH 末尾加入 Homebrew node@24/bin 优先路径，保留 Node 26 与全局 npm/corepack，避免 Homebrew 覆盖链接删除现有包。 [/Users/lemeng.shi/.zshrc] (worked)
- 2026-08-21T03:17:15Z `fix`: 安装 Homebrew node@24 并将其 bin 目录置于 zsh PATH 最前；新交互 shell 的 node 为 v24.19.0，npm run check（73 tests）与发布测试均通过。 [/Users/lemeng.shi/.zshrc]
