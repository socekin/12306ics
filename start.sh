#!/bin/bash
# 确保脚本在错误时退出
set -e

# 启动邮件监控
python email_monitor.py &

# 启动 Web 服务
python app.py
