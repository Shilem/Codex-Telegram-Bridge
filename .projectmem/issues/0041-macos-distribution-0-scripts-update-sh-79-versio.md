# #0041 macOS distribution 测试退出 0 但输出 scripts/update.sh:79 的 VERSION 变量 unbound 错误，需单独复现和修复。

- 2026-08-21T02:43:50Z `issue`: macOS distribution 测试退出 0 但输出 scripts/update.sh:79 的 VERSION 变量 unbound 错误，需单独复现和修复。 [scripts/update.sh:79]
- 2026-08-21T02:49:19Z `attempt`: 已最小复现：在 bash set -u 下，中文全角逗号紧跟未加花括号的 $VERSION 时被并入变量名，导致 VERSION� unbound；改为 ${VERSION} 可避免。 [scripts/update.sh:79] (worked)
- 2026-08-21T02:58:31Z `attempt`: 将中文标点前的未加花括号变量改为 ${VERSION}；发布测试现在输出测试模式版本且不再出现 unbound variable。 [scripts/update.sh:79] (worked)
- 2026-08-21T02:58:35Z `fix`: 已用 ${VERSION} 明确变量边界，并由发布测试断言测试模式更新输出不含 unbound variable；macOS 复现已消失。 [scripts/update.sh:79]
