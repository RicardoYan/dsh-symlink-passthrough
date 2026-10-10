# dsh-symlink-passthrough

让 DSH 侧边栏「文件」树能展开、打开工作区里的符号链接（含 Windows junction）。指向工作区外的链接，需要工作区已信任才能访问。

DSH 默认按链接的真实路径判断是否在工作区内，所以链接到别处的目录和文件都会报错：展开时报 `outside-workspace`，打开时报 `not-regular-file`。

## 安装

```sh
dsh plugin --profile desktop add github:RicardoYan/dsh-workspace-trust#v0.1.0
dsh plugin --profile desktop add github:RicardoYan/dsh-symlink-passthrough#v0.1.0
```

Web 端把 `desktop` 换成你的 profile 名（一般是 `web`）。装完重启 DSH。

卸载：`dsh plugin --profile desktop remove dsh-symlink-passthrough`

## 规则

按链接**指向的真实路径**判断：

| 链接指向 | 结果 |
|---|---|
| 工作区内 | 放行 |
| 工作区外 | 工作区已信任、且不在禁止访问列表里才放行 |

- 工作区 = 从会话目录往上最近的含 `.dsh/settings.yml` 或 `.git` 的目录；信任和禁止访问列表都由 [dsh-workspace-trust](https://github.com/RicardoYan/dsh-workspace-trust) 管理（`/workspace-trust trust` 信任当前工作区）
- 被拒绝时，侧边栏显示原因，例如「需要先信任工作区」「路径在禁止访问列表中」
- 只处理工作区里的链接本身；带 `..` 的路径、直接写的工作区外路径照旧按 DSH 原规则处理
- 只影响侧边栏，agent 的读写权限不变

## 注意

- 没装 dsh-workspace-trust 时，插件不放行任何链接，等同 DSH 原行为
- 依赖 DSH 的内部方法（`fs.contains`，`workspaceFiles` 的 `confine` / `locateFile` / `feed.follow`），适用于 `@deepseek-ai/dsh` `>=0.2.0-rc.2 <0.3.0-0`；缺失时启动日志出现 `[symlink-passthrough] ... missing` 告警，对应功能不生效，普通文件不受影响
- 在 bundle 配置里写 `enabled: false` 可以关闭插件

## 许可证

MIT
