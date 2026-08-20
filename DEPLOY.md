# <DSH永不眠> · 部署文档

> 目标:让 DSH 通过**飞书机器人**在手机上对话,并每天 19:59 收到工作总结邮件。内置邮件对话通道(默认未启用)。
> 预计部署时间:**20 分钟**。本文档面向有一定命令行基础的使用者。

---

## 一、你需要准备

| 项目 | 说明 |
|---|---|
| Mac 电脑 | 已安装 Node.js(≥22,建议 24)与 DSH(web 模式运行中) |
| 飞书账号 | 公司/个人飞书,可创建应用(见下文) |
| 邮箱 | 任意支持 IMAP/SMTP 的邮箱(QQ/163 均可),用于收发消息与每日推送 |

## 二、飞书机器人创建(约 10 分钟)

1. 打开 `open.feishu.cn`,登录后 **创建企业自建应用**(名字随意,如"DSH助手")
2. **应用能力 → 机器人**:开启
3. **权限管理** → 开通:
   - `im:message`(获取与发送单聊、群组消息)
   - `im:message.p2p_msg:readonly`(获取用户发给机器人的单聊消息)——**私聊必需**
   - `im:message:send_as_bot`(以应用身份发消息)
4. **事件与回调 → 事件订阅**:
   - 添加事件 `im.message.receive_v1`
   - 订阅方式选择 **"使用长连接接收事件"**(不是 webhook)
   - 保存
5. **版本管理与发布**:创建版本 → 发布(可用范围选"仅创建者"最快)
6. **凭证与基础信息**:记下 **App ID** 和 **App Secret**

## 三、安装 DSH永不眠(约 10 分钟)

```bash
# 1. 下载项目到任意目录(假设 ~/dsh-mobile)
cd ~/dsh-mobile

# 2. 复制配置模板并填写
cp config.example.json config.json
# 编辑 config.json:
#   - installDir: 本项目绝对路径
#   - feishu.appId / appSecret: 第二步拿到的凭证
#   - mail.*: 你的邮箱与授权码(邮箱设置里开启 IMAP/SMTP 后生成)
#   - daily.recipient: 接收每日总结的邮箱
#   - notify.alertChatId: 可留空(监控告警可选)

# 3. 一键安装(自动:装SDK/注册DSH插件/装守护/自检;定时任务随桥内置,无需 cron)
bash install.sh

# 4. 重启 DSH 使插件生效:
#    - 若 DSH 由 launchd 托管(服务名 com.dsh.web): launchctl kickstart -k gui/$(id -u)/com.dsh.web
#    - 若为手动启动: kill $(lsof -tiTCP:3080 -sTCP:LISTEN) 后重新启动 DSH

# 5. 手机飞书搜索你的机器人,发「使用说明」验证
```

## 四、使用

| 指令 | 作用 |
|---|---|
| `任务列表` / `列表` | 查看可切换的任务 |
| `3`(数字) | 切换到对应任务 |
| `跟随` | 恢复跟随电脑最近任务 |
| `当前` | 查看消息去向 |
| `选择模型` | 切换模型与推理强度(off/high/max) |
| `停` | 终止正在执行的任务 |
| `继续` | 恢复被终止的任务 |
| `使用说明` | 查看本说明 |

- 普通消息 → 进入当前任务会话,PC 端同步可见
- 任务执行超 30 秒无正文 → 自动回复活泼提示语
- 邮件通道:已内置,默认未启用(发邮件到配置的邮箱可对话,仅普通对话)
- 每日 19:59:自动收到工作总结邮件(标题「DSH提醒+日期」)

## 五、运维

| 事项 | 方法 |
|---|---|
| 飞书桥日志 | 桥自身 `/tmp/feishu-bridge.log`(始终有效);launchd 重定向 `bridge/feishu-bridge.log` |
| 桥崩溃自愈 | launchd 守护自动重启(com.dsh.feishu) |
| 运行监控 | 桥内置调度每分钟拉起 monitor.js,异常发飞书告警 |
| 每日总结 | 桥内置调度每日 19:59 拉起 daily-summary.js(补跑窗口至 23:59,当日只发一次) |
| 队列清理 | 卡死文件 10 分钟自动回收重试,3 次放弃 |
| 每日推送日志 | `cat /tmp/daily-summary.log` |

## 六、常见问题

1. **飞书发消息没回复**:检查 `launchctl list | grep dsh` 是否在跑;看日志有无报错
2. **机器人搜不到**:应用未发布,或可用范围不含你
3. **私聊不推送**:确认开了 `im:message.p2p_msg:readonly` 并重新发布
4. **DSH 重启后插件丢失**:确认 `cordis.patch.yml` 有 mailbridge insert(install.sh 已处理)
5. **告警没发**:config.json 的 `notify.alertChatId` 留空则跳过告警
6. **登录项显示异常**:正常应只有「DSH」「DSH feishu」;若出现「Node.js Foundation」等旧项,重跑 `bash install.sh` 会自动清理旧服务;若旧开关仍删不掉,执行 `sudo sfltool resetbtm` 并重启(注意:会重置所有后台项的开关状态,需手动关回不需要的)

## 七、目录结构

```
dsh-mobile/
├── config.json          统一配置(唯一需要修改的文件)
├── feishu-bridge.js     飞书桥(长连接+命令)
├── bridge.js            邮件桥(默认未启用)
├── mailbridge-plugin.js DSH 插件(会话注入核心)
├── daily-summary.js     每日总结推送
├── monitor.js           心跳/积压监控
├── install.sh           一键安装
└── bridge/in/           消息队列目录
```

## 八、安全说明

- 邮箱授权码与飞书密钥存于 `config.json`(建议 `chmod 600`)
- 飞书机器人可见范围建议"仅创建者",避免他人误用
- 邮件白名单 `allowedFrom` 只接受你的地址
