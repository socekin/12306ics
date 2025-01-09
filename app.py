from flask import Flask, send_file
import os
from datetime import datetime
import pytz
import logging

# 配置日志
logging.basicConfig(
    level=logging.INFO,
    format='%(asctime)s - %(levelname)s - %(message)s'
)

app = Flask(__name__)

@app.errorhandler(400)
def bad_request(e):
    """处理400错误，通常是由HTTPS请求导致的"""
    logging.info(f"收到错误请求: {e}")
    return "Bad Request: Please use HTTP instead of HTTPS", 400

@app.route('/ticket')
def get_calendar():
    """提供最新的车票日历文件"""
    ics_dir = os.path.join(os.path.dirname(__file__), 'ics')
    # 获取 ics 目录下最新的日历文件
    ics_files = [f for f in os.listdir(ics_dir) if f.endswith('.ics')]
    if not ics_files:
        logging.warning("未找到日历文件")
        return "No calendar file found", 404
    
    # 按修改时间排序，获取最新的文件
    latest_file = max(ics_files, key=lambda x: os.path.getmtime(os.path.join(ics_dir, x)))
    file_path = os.path.join(ics_dir, latest_file)
    
    logging.info(f"提供日历文件: {latest_file}")
    return send_file(
        file_path,
        mimetype='text/calendar',
        as_attachment=True,
        download_name='12306_ticket.ics'
    )

if __name__ == '__main__':
    logging.info("启动Web服务器在 http://0.0.0.0:2306")
    app.run(host='0.0.0.0', port=2306)
