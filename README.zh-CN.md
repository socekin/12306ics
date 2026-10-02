# 12306ics

[![CI](https://github.com/socekin/12306ics/actions/workflows/ci.yml/badge.svg)](https://github.com/socekin/12306ics/actions/workflows/ci.yml)
[![Version](https://img.shields.io/github/v/tag/socekin/12306ics?sort=semver&label=version)](https://github.com/socekin/12306ics/tags)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Node.js](https://img.shields.io/badge/node-%3E%3D22-339933?logo=nodedotjs&logoColor=white)](package.json)

[English](README.md) | 简体中文

把 12306 的车票通知邮件自动变成日历事件。完全运行在 Cloudflare Workers 上：不用维护服务器，不用浏览器自动化，也不需要邮箱密码。

买完票几秒后，行程就会出现在你的日历里，包含座位、检票口、到达时间和发车前提醒。改签或退票后，日历事件会自动移动或删除。

## 功能

- **覆盖关键的车票邮件**：购票、候补兑现、改签、退票通知。
- **一趟车一个事件**：同一趟车的多位乘客共用一个事件，事件里列出每个人的座位。
- **真实到达时间**：从 12306 列车时刻查询，支持跨夜列车和中途上车。查询失败时先按估算时间显示，之后自动更正。
- **两种获取方式**：通过 CalDAV 几秒内直接写入 iCloud 等日历，也可以订阅 ICS 链接。
- **可放心重试**：邮件重复投递或重新处理都不会产生重复事件。
- **个人使用免费**：Cloudflare 免费套餐（Workers、KV、Email Routing）即可运行。

## 工作原理

```
12306 ──邮件──▶ 你的邮箱 ──转发──▶ 12306@你的域名（Cloudflare Email Routing）
                                                │
                                                ▼
                                         12306ics Worker
                                ├─ KV：行程、去重记录、无法识别的邮件
                                ├─ CalDAV 写入/删除 ─▶ 你的日历（如 iCloud）
                                └─ GET /calendar.ics ─▶ 任意日历应用
```

1. 12306 把通知邮件发到你账号绑定的邮箱。
2. 邮箱把邮件转发到由 Cloudflare Email Routing 接收的地址，再交给 Worker 处理。
3. Worker 解析车票、查询到达时间、更新行程记录，并写入日历事件。

如果不方便用邮箱转发，也可以用 Gmail + Apps Script 桥接（[`gas/Code.gs`](gas/Code.gs)），定时读取 Gmail 并推送给 Worker。

## 前置条件

- 一个 Cloudflare 账号，且至少有一个域名托管在 Cloudflare DNS 上（Email Routing 需要；这个域名不影响其他用途）。
- 一个能收到 12306 邮件、并能自动转发且保留原发件人的邮箱。已验证 QQ 邮箱可用。
- 可选：一个 CalDAV 日历。iCloud 需要使用 [App 专用密码](https://support.apple.com/zh-cn/102654)。不用 CalDAV 也可以订阅 ICS 链接。
- Node.js 22 或更高版本（用于部署）。

## 快速开始

```bash
git clone https://github.com/socekin/12306ics.git
cd 12306ics
npm install
cp wrangler.example.jsonc wrangler.jsonc
npx wrangler login
npx wrangler kv namespace create STORE   # 把输出的 id 填入 wrangler.jsonc
npx wrangler deploy
npx wrangler secret put INGEST_TOKEN     # 足够长的随机字符串，如 `openssl rand -hex 32`
npx wrangler secret put CALENDAR_TOKEN   # 另一个随机字符串
npx wrangler secret put CALDAV_USERNAME  # 可选：Apple ID 邮箱
npx wrangler secret put CALDAV_PASSWORD  # 可选：App 专用密码
```

然后：

1. 在日历应用里新建一个名为 `12306` 的日历（Worker 会往里写事件，但无法自己创建日历）。
2. 在 Cloudflare 控制台打开域名的 **Email Routing**，创建一个自定义地址（如 `12306@你的域名`），操作选择 **Send to a Worker** → `12306ics`。
3. 在邮箱里添加收信规则，把来自 `12306@rails.com.cn` 的邮件转发到这个地址。

每一步的详细说明（包括邮箱转发确认、Gmail 桥接、不买票如何测试）见[部署指南](docs/deployment.md)（英文）。

## 配置

密钥（用 `npx wrangler secret put <NAME>` 设置；本地开发写在 `.dev.vars` 里，参考 [`.dev.vars.example`](.dev.vars.example)）：

| 密钥              | 必需 | 用途                                          |
| ----------------- | ---- | --------------------------------------------- |
| `INGEST_TOKEN`    | 是   | `POST /ingest` 和管理接口的 Bearer token      |
| `CALENDAR_TOKEN`  | 是   | ICS 订阅和只读接口的 `?token=` 参数           |
| `CALDAV_USERNAME` | 否   | CalDAV 用户名，不设置则关闭 CalDAV            |
| `CALDAV_PASSWORD` | 否   | CalDAV 密码（iCloud 用 App 专用密码）         |

变量（`wrangler.jsonc` 中的 `vars`）：

| 变量                   | 默认值                       | 用途                                           |
| ---------------------- | ---------------------------- | ---------------------------------------------- |
| `ALLOWED_SENDERS`      | `12306@rails.com.cn`         | 允许处理的发件人，逗号分隔；其他发件人一律忽略 |
| `CALDAV_URL`           | `https://caldav.icloud.com/` | CalDAV 服务器地址                              |
| `CALDAV_CALENDAR_NAME` | `12306`                      | 目标日历的显示名称                             |
| `CALDAV_CALENDAR_URL`  | 未设置                       | 跳过自动发现，直接写入这个日历地址             |
| `ALARM_MINUTES`        | `60`                         | 发车前多少分钟提醒，`0` 表示不提醒             |
| `ARCHIVE_TO`           | 未设置                       | 每封邮件额外转发一份到这个已验证的地址         |

## 订阅 ICS

```
https://<你的 Worker 域名>/calendar.ics?token=<CALENDAR_TOKEN>
```

在 Apple 日历、Google 日历或 Outlook 中添加为订阅日历即可。订阅的刷新频率由日历应用决定（通常一小时或更久），想要秒级同步请用 CalDAV。

## 支持的邮件

| 12306 邮件（标题后缀）  | 处理方式                                           |
| ----------------------- | -------------------------------------------------- |
| 用户支付通知            | 添加车票，每趟车生成一个事件                       |
| 候补订单兑现成功通知    | 同购票                                             |
| 用户改签通知            | 把改签的乘客移到新车次，其他乘客保持不变           |
| 用户退票通知            | 移除退票的乘客，没有乘客时删除事件                 |
| 候补订单退单通知        | 无需处理                                           |
| 其他邮件                | 忽略并保留 90 天，解析逻辑修复后可以重新处理       |

细节与边界情况见 [docs/email-formats.md](docs/email-formats.md)（英文）。

## 限制

- CalDAV 只在 iCloud 上验证过，其他服务器理论上可用但未测试。
- Worker 无法在 iCloud 上创建日历，需要你在日历应用里自己创建，或使用 [`scripts/caldav-calendar.mjs`](scripts/caldav-calendar.mjs)。
- 到达时间来自 12306 未公开的接口，接口可能变化。查询失败时事件会显示预估到达时间，每晚的定时任务会在接口恢复后更正。
- 如果 12306 修改了邮件格式，受影响的邮件会被保留，解析逻辑更新后可以重新处理。欢迎[提交反馈](https://github.com/socekin/12306ics/issues/new/choose)。
- 行程记录会一直保留。

## 从 v1（Python/Docker）升级

v2 是完全重写的版本，v1 保留在 [`v1.0.0`](https://github.com/socekin/12306ics/tree/v1.0.0) 标签下。两者之间没有数据迁移：停掉 v1 容器，部署 Worker，再把邮箱转发改到新地址即可。v1 生成的事件和 v2 的标识不同，建议 v2 写入新日历，或先删除 v1 的旧事件，避免重复。

## 文档（英文）

- [部署指南](docs/deployment.md)：从零部署、邮箱转发、Gmail 桥接
- [运维](docs/operations.md)：HTTP 接口、日常检查、重新处理邮件、更换 token
- [架构](docs/architecture.md)：数据模型、处理流程、设计决策
- [邮件格式](docs/email-formats.md)：12306 邮件内容及解析方式

## 参与贡献

欢迎提交问题、新的邮件样本和 Pull Request，见 [CONTRIBUTING.md](CONTRIBUTING.md)。请勿公开发布原始的 12306 邮件，其中包含你的姓名和订单信息。

## 安全

报告安全问题的方式见 [SECURITY.md](SECURITY.md)。

## 许可证

[MIT](LICENSE)

本项目与中国铁路及 12306 官方无关。
