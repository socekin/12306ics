# 12306 车票日历订阅

本项目可以自动将12306的车票信息邮件转换为在线日历，支持日历订阅功能。当收到12306的车票邮件时，程序会自动解析并生成包含完整行程信息的日历文件。

**本项目完成由 AI 生成，遇到问题不要提issues，因为作者本人也不会写代码，请自行修改或者发给GPT解决**

## 功能特性

- 📧 自动监控QQ邮箱中的12306车票邮件
- 🎫 智能解析车票信息（车次、时间、座位等）
- 🔍 自动查询列车到站时间
- 📅 生成标准格式的ICS日历文件
- 🌐 支持在线日历订阅
- 🐳 提供Docker部署支持
- ⚡ 实时更新（每30秒检查一次新邮件）

## 更新日志

### 2025-01-08
- 支持Docker部署
- 添加日历订阅功能
- 实现自动查询到站时间
- 支持QQ邮箱监控

## 部署步骤

### 环境要求
- Docker
- Docker Compose
- QQ邮箱（用于接收12306邮件）

### 1. 配置环境变量
创建 `.env` 文件，添加以下配置：
```bash
EMAIL_USERNAME=你的QQ邮箱地址
EMAIL_PASSWORD=你的QQ邮箱授权码  # 注意：这里需要使用QQ邮箱的授权码，不是登录密码
```

获取QQ邮箱授权码：
1. 登录QQ邮箱
2. 设置 -> 账户 -> POP3/IMAP/SMTP/Exchange/CardDAV/CalDAV服务
3. 开启POP3/SMTP服务，获取授权码

### 2. 部署命令

```bash
# 克隆项目
git clone <项目地址>
cd 12306ics

# 编辑配置文件，填入邮箱信息
vim .env

# 构建并启动容器
docker-compose up -d

# 查看运行状态
docker-compose ps

# 查看日志
docker-compose logs -f
```

### 3. 订阅日历
在你的日历应用中添加订阅日历，URL格式：
```
http://服务器IP:2306/ticket
```

支持的日历应用：
- Apple Calendar
- Google Calendar
- Outlook
- 其他支持ICS订阅的日历应用

## 注意事项

1. 确保12306的订票邮件发送到配置的QQ邮箱
2. 服务器需要开放2306端口
3. 首次运行时需要等待一段时间下载Playwright浏览器


## 技术栈

- Python 3.9
- Flask (Web服务)
- Playwright (列车信息查询)
- imap-tools (邮件监控)
- Beautiful Soup (HTML解析)
- Docker (容器化部署)

## 许可证

MIT License
