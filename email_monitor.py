import os
import time
import logging
from imap_tools import MailBox, AND
import subprocess
from datetime import datetime
import pytz
from dotenv import load_dotenv
import sys

# 加载 .env 文件
load_dotenv()

# 配置日志
logging.basicConfig(
    level=logging.DEBUG,  # 改为 DEBUG 级别
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler('email_monitor.log'),
        logging.StreamHandler()
    ]
)

# 邮箱配置
IMAP_SERVER = "imap.qq.com"
EMAIL = os.getenv("EMAIL_USERNAME")
PASSWORD = os.getenv("EMAIL_PASSWORD")
TARGET_SENDER = "12306@rails.com.cn"  # 目标发件人

# 使用当前 Python 解释器路径
PYTHON_PATH = sys.executable

def process_new_emails():
    try:
        logging.debug(f"准备连接邮箱服务器: {IMAP_SERVER}")
        logging.debug(f"使用邮箱账号: {EMAIL}")
        
        with MailBox(IMAP_SERVER).login(EMAIL, PASSWORD) as mailbox:
            logging.info("成功登录邮箱")
            
            # 获取未读邮件
            logging.debug("开始获取未读邮件...")
            messages = mailbox.fetch(AND(seen=False))
            
            for msg in messages:
                logging.debug(f"处理邮件 - 发件人: {msg.from_}, 主题: {msg.subject}, 日期: {msg.date}")
                
                if TARGET_SENDER in msg.from_:
                    logging.info(f"找到目标邮件！发件人: {msg.from_}, 主题: {msg.subject}")
                    
                    try:
                        # 运行 main.py
                        logging.debug(f"使用 Python 解释器: {PYTHON_PATH}")
                        logging.debug("开始执行 main.py")
                        result = subprocess.run([PYTHON_PATH, 'ics/main.py'], 
                                             check=True,
                                             capture_output=True,
                                             text=True)
                        logging.info("成功运行 main.py")
                        logging.debug(f"main.py 输出: {result.stdout}")
                        
                        # 标记邮件为已读
                        mailbox.flag(msg.uid, 'SEEN', True)
                        logging.info("邮件已标记为已读")
                        
                    except subprocess.CalledProcessError as e:
                        logging.error(f"运行 main.py 时出错: {str(e)}")
                        logging.error(f"错误输出: {e.stderr}")
                    except Exception as e:
                        logging.error(f"处理邮件时发生错误: {str(e)}")
                else:
                    logging.debug(f"跳过非目标邮件，发件人: {msg.from_}")

    except Exception as e:
        logging.error(f"连接邮箱时发生错误: {str(e)}")
        logging.exception("详细错误信息:")

def main():
    logging.info("邮件监控服务启动")
    logging.info(f"目标发件人: {TARGET_SENDER}")
    
    while True:
        try:
            logging.info("开始新一轮邮件检查...")
            process_new_emails()
            logging.info("邮件检查完成，等待下一轮...")
        except Exception as e:
            logging.error(f"发生未预期的错误: {str(e)}")
            logging.exception("详细错误信息:")
        
        # 等待30秒后再次检查
        logging.debug("等待 30 秒后进行下一次检查...")
        time.sleep(30)

if __name__ == "__main__":
    main()
