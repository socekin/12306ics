# 使用官方 Python 运行时作为父镜像
FROM python:3.8-slim

# 安装 cron 服务
RUN apt-get update && apt-get install -y cron

# 设置工作目录为 /app
RUN mkdir -p /app/ics
WORKDIR /app

# 创建一个记录 cron 执行日志的目录和文件
RUN touch /var/log/cron.log

# 将当前目录内容复制到位于 /app 的容器中
COPY . /app

# 安装 requirements.txt 中的所有依赖
RUN pip install --no-cache-dir -r requirements.txt

# 添加 cron 任务
# 假设你想每小时运行一次 run_script.py
# 注意替换 /app/run_script.py 为你 run_script.py 文件的实际路径
# 你可以根据需要改变 * * * * * 来调整运行频率
RUN echo "* * * * * root cd /app && /usr/local/bin/python run_script.py >> /var/log/cron.log 2>&1" > /etc/cron.d/run_script_cron

# 给 cron 任务文件设置正确的权限
RUN chmod 0644 /etc/cron.d/run_script_cron

# 应用 cron 任务
RUN crontab /etc/cron.d/run_script_cron

# 对外暴露端口 2306
EXPOSE 2306

# 在容器启动时运行 main.py 以及启动 cron
CMD cron && python main.py