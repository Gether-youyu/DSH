# <DSH永不眠>

**把 DSH 智能体装进手机:飞书对话、邮件推送、远程审批,和电脑共享同一会话。**

一套让 DSH(DeepSeek Harness)接入手机飞书的消息网关:手机发消息 → DSH 执行 → 回复回手机,电脑端同一会话实时同步。内置邮件通道与每日工作总结推送,附一键安装、崩溃自愈、运行监控。

---

## 功能一览

| 功能 | 说明 |
|---|---|
| 飞书对话 | 手机私聊机器人,消息进入 PC 当前任务会话,回复回飞书 |
| 任务切换 | 「任务列表」查看/「数字」切换/「跟随」恢复,与 PC 会话一一对应 |
| 模型选择 | 「选择模型」切换模型与推理强度(off/high/max) |
| 任务遥控 | 「停」终止任务、「继续」恢复被终止任务、忙时 30 秒提示语 |
| **飞书审批** | DSH 需要授权时,飞书收到通知,回复「同意/拒绝」决定任务走向 |
| 邮件通道 | 已内置(发邮件到配置邮箱与 DSH 对话),当前默认未启用,飞书为主通道 |
| 每日推送 | 每天 19:59 自动发一封「DSH提醒+日期」邮件,总结你今天在 DSH 上做的事,语气生动、会夸奖;工作超 6 小时或仍在忙会提醒放松休息 |
| 运行监控 | 心跳检测 + 队列积压告警(飞书通知),桥崩溃自动重启 |

## 快速开始(约 20 分钟)

**前提**:Mac + Node.js ≥22 + DSH(web 模式运行中)+ 一个支持 IMAP/SMTP 的邮箱

```bash
# 1. 解压本项目
unzip dsh-mobile-v0.1.zip && cd dsh-mobile

# 2. 复制配置模板并填写(唯一要改的文件)
cp config.example.json config.json
#   - installDir: 本目录绝对路径
#   - feishu.appId/appSecret: 飞书应用凭证(见下)
#   - mail.*: 邮箱与授权码
#   - daily.recipient: 接收每日总结的邮箱

# 3. 一键安装(自动:装SDK/注册DSH插件/装守护/自检;定时任务随桥内置,无需 cron)
bash install.sh

# 4. 重启 DSH(使插件生效):
kill $(lsof -tiTCP:3080 -sTCP:LISTEN)   # 系统自动拉起

# 5. 手机飞书搜索机器人,发「使用说明」验证
```

### 飞书应用创建(一次性,约 10 分钟)

1. `open.feishu.cn` → 创建**企业自建应用**
2. 应用能力 → 开启**机器人**
3. 权限:开通 `im:message`、`im:message.p2p_msg:readonly`(**私聊必需**)、`im:message:send_as_bot`
4. 事件与回调 → 添加 `im.message.receive_v1` → 订阅方式选**长连接**
5. 版本管理与发布 → 发布(可用范围"仅创建者")
6. 记录 App ID / App Secret 填入 config.json

> 详细步骤见 [DEPLOY.md](DEPLOY.md)

## 指令手册

```
📋 任务列表 / 列表     查看可切换任务
3                     切换到第3个任务
跟随                   恢复跟随电脑最近任务
当前                   查看消息去向
选择模型               切换模型和推理强度(off/high/max)
停                     终止正在执行的任务
继续                   恢复被终止的任务
使用说明               查看本说明
```

普通消息 → 进入当前任务会话;任务执行超 30 秒无正文 → 自动回复活泼提示语。

## 架构

```
手机飞书 ──-> feishu-bridge.js(长连接/命令/心跳/内置定时调度)
手机邮件 ──-> bridge.js(IMAP/SMTP,已内置,默认未启用;install.sh 默认不安装,如需启用见 install.sh 注释)
每日19:59 ─-> daily-summary.js(桥内置调度拉起)
每分钟   ──> monitor.js(桥内置调度拉起)
        ↘ 文件队列 bridge/in/ ↗
        -> mailbridge-plugin.js(DSH 进程内)
          消息注入会话 / 任务切换 / 模型选择 / 停·继续 / 审批桥 / 30秒提示
        -> 回复写回队列 -> 桥发送 -> 飞书/邮件
```

## 项目结构

```
dsh-mobile/
├── config.json          统一配置(唯一需要修改的文件)
├── config.example.json  配置模板(脱敏)
├── feishu-bridge.js     飞书桥(长连接+命令+单实例锁+心跳)
├── bridge.js            邮件桥(备用通道)
├── mailbridge-plugin.js DSH 插件(核心:会话注入/审批/任务控制)
├── daily-summary.js     每日19:59工作总结推送
├── monitor.js           心跳/积压监控告警
├── install.sh           一键安装
├── uninstall.sh         卸载(移除守护/cron/插件注册)
├── DEPLOY.md            部署文档
├── FEATURES.md          功能清单(含回复样式)
├── TROUBLESHOOTING.md   排障手册
├── CHANGELOG.md         更新日志
├── VERSION              版本号
└── bridge/              队列与状态目录
```

## 运维

| 事项 | 方法 |
|---|---|
| 桥日志 | 桥自身: `/tmp/feishu-bridge.log`(始终有效);launchd 重定向: `bridge/feishu-bridge.log` |
| 桥崩溃 | launchd KeepAlive 自动重启 |
| 监控告警 | 桥内置调度每分钟拉起 monitor.js,异常发飞书 |
| 每日推送日志 | `/tmp/daily-summary.log` |

## 版本与卸载

- 当前版本: `v0.2`(更新记录见 CHANGELOG.md)
- 卸载:`bash uninstall.sh`(移除守护/旧cron/插件注册,保留项目文件)
- 发布包:zip 为 v0.1 时期产物已过期,分发前请重新打包

## 常见问题

- **机器人搜不到**:应用未发布/可用范围不含你
- **私聊无事件**:没开 `im:message.p2p_msg:readonly` 或未重新发布
- **回复收不到**:`launchctl list | grep dsh` 看桥是否运行;日志 `/tmp/feishu-bridge.log`(桥自身,始终有效)
- **审批不弹**:确认 DSH 已重启(插件 v12+ 生效)
- **登录项异常**:正常应只有「DSH」「DSH feishu」两项;若见「Node.js Foundation」等旧项,重跑 `bash install.sh` 自动清理;若开关删不掉,`sudo sfltool resetbtm` 后重启(代价:所有后台项开关状态重置,需手动关回不要的)

## 许可

个人项目,按需使用。
