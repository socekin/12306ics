import os
import time
import logging
from imap_tools import MailBox, AND
import subprocess
import sys
from typing import Optional, Set
from contextlib import contextmanager
from dotenv import load_dotenv
import pickle
from pathlib import Path

# 加载 .env 文件
load_dotenv()

# 配置日志
logging.basicConfig(
    level=logging.DEBUG,
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
TARGET_SENDER = os.getenv("TARGET_SENDER")  # 从环境变量获取发件人

# 使用当前 Python 解释器路径
PYTHON_PATH = sys.executable

# 处理过的邮件ID缓存文件
PROCESSED_EMAILS_FILE = 'processed_emails.pkl'

def load_processed_emails() -> Set[str]:
    """加载已处理的邮件ID集合"""
    try:
        if Path(PROCESSED_EMAILS_FILE).exists():
            with open(PROCESSED_EMAILS_FILE, 'rb') as f:
                return pickle.load(f)
    except Exception as e:
        logging.warning(f"加载已处理邮件ID失败: {str(e)}")
    return set()

def save_processed_emails(processed_emails: Set[str]):
    """保存已处理的邮件ID集合"""
    try:
        with open(PROCESSED_EMAILS_FILE, 'wb') as f:
            pickle.dump(processed_emails, f)
    except Exception as e:
        logging.warning(f"保存已处理邮件ID失败: {str(e)}")

@contextmanager
def maintain_connection():
    """维护 IMAP 连接的上下文管理器"""
    mailbox = None
    try:
        logging.debug(f"准备连接邮箱服务器: {IMAP_SERVER}")
        logging.debug(f"使用邮箱账号: {EMAIL}")
        mailbox = MailBox(IMAP_SERVER).login(EMAIL, PASSWORD)
        logging.info("成功登录邮箱")
        yield mailbox
    except Exception as e:
        logging.error(f"连接邮箱时发生错误: {str(e)}")
        logging.exception("详细错误信息:")
        raise
    finally:
        if mailbox:
            try:
                mailbox.logout()
                logging.debug("已断开邮箱连接")
            except Exception as e:
                logging.error(f"断开连接时发生错误: {str(e)}")

def process_new_email(mailbox: MailBox, processed_emails: Set[str]) -> None:
    """处理新邮件"""
    try:
        # 获取12306邮件
        logging.debug("开始检查12306邮件...")
        messages = list(mailbox.fetch(f'FROM "{TARGET_SENDER}"'))
        
        if messages:
            latest_msg = max(messages, key=lambda x: x.date)
            msg_id = latest_msg.uid
            
            if msg_id not in processed_emails:
                logging.info(f"找到新的邮件 - 发送时间: {latest_msg.date}, 主题: {latest_msg.subject}")
                try:
                    # 运行 main.py
                    logging.debug(f"使用 Python 解释器: {PYTHON_PATH}")
                    logging.debug("开始执行 main.py")
                    result = subprocess.run(
                        [PYTHON_PATH, 'ics/main.py'], 
                        check=True,
                        capture_output=True,
                        text=True
                    )
                    logging.info("成功运行 main.py")
                    logging.debug(f"main.py 输出: {result.stdout}")
                    
                    # 标记邮件为已处理
                    processed_emails.add(msg_id)
                    save_processed_emails(processed_emails)
                    
                except subprocess.CalledProcessError as e:
                    logging.error(f"运行 main.py 时出错: {str(e)}")
                    logging.error(f"错误输出: {e.stderr}")
                except Exception as e:
                    logging.error(f"处理邮件时发生错误: {str(e)}")
            else:
                logging.debug(f"邮件 {msg_id} 已经处理过，跳过")
        else:
            logging.info("未找到目标邮件")

    except Exception as e:
        logging.error(f"处理邮件时发生错误: {str(e)}")
        logging.exception("详细错误信息:")

def monitor_emails():
    """使用 IMAP IDLE 监控邮件"""
    processed_emails = load_processed_emails()
    
    while True:
        try:
            with maintain_connection() as mailbox:
                # 选择收件箱
                mailbox.folder.set('INBOX')
                
                # 初始检查一次当前邮件
                process_new_email(mailbox, processed_emails)
                
                # 开始 IDLE 监听
                logging.info("开始监听新邮件...")
                idle_start_time = time.time()
                
                # 使用 imap_tools 的 IDLE 功能
                for idle_response in mailbox.idle.wait(timeout=60*5):  # 5分钟超时
                    if isinstance(idle_response, bytes):
                        response_str = idle_response.decode('utf-8')
                        if 'EXISTS' in response_str:  # 检查是否有新邮件
                            logging.debug("检测到新邮件")
                            process_new_email(mailbox, processed_emails)
                    
                    # 检查是否需要刷新连接
                    if time.time() - idle_start_time > 60*5:  # 5分钟后刷新
                        logging.debug("IDLE 超时，准备刷新连接...")
                        break
                
        except Exception as e:
            logging.error(f"监控过程发生错误: {str(e)}")
            logging.exception("详细错误信息:")
            logging.info("30秒后尝试重新连接...")
            time.sleep(30)

def main():
    """主函数"""
    logging.info("邮件监控服务启动")
    logging.info(f"目标发件人: {TARGET_SENDER}")
    
    while True:
        try:
            monitor_emails()
        except KeyboardInterrupt:
            logging.info("收到退出信号，程序结束")
            break
        except Exception as e:
            logging.error(f"程序发生错误: {str(e)}")
            logging.exception("详细错误信息:")
            logging.info("5秒后重试...")
            time.sleep(5)

if __name__ == "__main__":
    main()
