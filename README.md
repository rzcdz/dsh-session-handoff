# @rzcdz/dsh-session-handoff

DSH 插件：每日会话交接。侧边栏加一个「每日交接」页面，按全局 cron 定时把交接清单里的启用条目依次执行——新建会话、按所选工作区落位、用「前缀 + 明天的月日」命名、**置顶**、发送交接指令。

## 安装

DSH 里打开**插件管理 → 添加插件**，把下面任意一个地址粘进输入框：

```
github:rzcdz/dsh-session-handoff
```

也可以直接用仓库地址：

```
https://github.com/rzcdz/dsh-session-handoff
```

或者克隆到本地后选目录安装：

```bash
git clone https://github.com/rzcdz/dsh-session-handoff.git
```

安装后侧边栏出现「每日交接」，不需要额外配置。

> 只支持 DSH 桌面版 / 带 Web GUI 的版本（插件有 Web 界面）。

## 更新

插件市场（dsh-market）能直接更新它：在「已安装」里找到本插件，点更新即可。

市场对 GitHub 来源比较的是 **commit SHA** 而不是版本号，所以只要本仓库有新的提交，市场就会认为有更新——不需要为了更新去改 `package.json` 的 version。手动更新等价于「卸载后重新安装」。

如果「更新检查」里没出现本插件，点一次刷新；市场带有短时缓存。

## 用法

1. 顶部填 cron（默认 `40 15 * * 1-5`，即周一到周五 15:40），点保存，下方显示未来三个具体时间。
2. 「+ 新建」添加交接：交接指令、名字前缀、工作区。
3. 到点自动执行；也可以随时点「立即交接」。

新会话名 = 你填的前缀 + 触发时刻**明天**的月日。今天 15:40 触发、前缀 `任务`，得到 `任务1124`。

### cron 表达式

5 段：`分 时 日 月 周`，本地时区。

| 例子 | 含义 |
|---|---|
| `40 15 * * 1-5` | 周一到周五 15:40 |
| `30 9,15 * * 1-5` | 周一到周五 9:30 和 15:30 |
| `0 20 * * *` | 每天 20:00 |

支持 `*`、`*/n`、`a-b`、`a-b/n`、`a,b`、`jan-mar`、`mon-fri`。日和周同时写死时按「任一满足」判定。

## 限制

- 定时只在命中那一分钟执行，错过的触发不补跑。
- 定时依赖 DSH 处于运行状态。
- 状态存在 `%LOCALAPPDATA%\dsh-session-handoff\state.json`（macOS/Linux 为临时目录下的 `dsh-session-handoff`），不写进插件配置。
- 置顶是全局的：DSH 的置顶集合不区分工作区。

## 给 Agent 的工具

插件注册了 `handoff` 工具，可 `list` / `create` / `update` / `delete` / `toggle` / `run`，改的是同一份数据。例如：

> 帮我加一条交接，指令 `@docs/HANDOFF.md run the handoff section`，前缀 `任务`

该工具启用延迟加载（`deferLoading`），定义平时不占上下文，只有真的用到时才读入。交接本身不依赖它：定时、建会话、命名、置顶、发送指令都走独立路径。

## 开发

```bash
node test-cron.mjs        # cron 解析与下次时间
node tests/host.test.mjs  # 状态、路由、交接流程
```

两个脚本都不依赖第三方包，用任何 Node 18+ 直接跑。

## 许可

MIT
