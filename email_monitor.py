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
from email.message import Message
import shutil

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

def get_email_content(msg: Message) -> str:
    """获取邮件内容，确保能获取完整的文本或HTML内容"""
    content = ""
    # 优先获取HTML内容
    if msg.html:
        content = msg.html
    # 如果没有HTML内容，尝试获取文本内容
    elif msg.text:
        content = msg.text
    # 如果上述方法都失败，尝试直接从原始邮件中提取
    else:
        for part in msg.obj.walk():
            if part.get_content_type() in ['text/plain', 'text/html']:
                try:
                    charset = part.get_content_charset() or 'utf-8'
                    content = part.get_payload(decode=True).decode(charset)
                    if content.strip():
                        break
                except:
                    continue
    return content

def process_new_email(mailbox: MailBox) -> None:
    """处理新邮件"""
    try:
        # 获取所有目标发件人的邮件
        all_messages = list(mailbox.fetch(f'FROM "{TARGET_SENDER}"'))
        
        # 记录总邮件数
        logging.info(f"总共找到 {len(all_messages)} 封目标邮件")
        
        # 按时间排序，获取最新的7封邮件
        messages_to_process = sorted(all_messages, key=lambda x: x.date, reverse=True)[:7]
        
        # 记录最近7封邮件的信息
        logging.info("最近7封邮件信息:")
        for i, msg in enumerate(messages_to_process, 1):
            logging.info(f"邮件{i}: ID={msg.uid}, 日期={msg.date}, 主题={msg.subject}")
        
        # 如果没有需要处理的邮件，直接返回
        if not messages_to_process:
            logging.debug("没有邮件需要处理")
            return
            
        # 创建临时目录
        try:
            os.makedirs('temp', exist_ok=True)
            
            # 处理邮件
            for msg in messages_to_process:
                try:
                    # 保存邮件内容到临时文件
                    temp_file = os.path.join('temp', f'email_{msg.uid}.txt')
                    
                    # 获取邮件内容（HTML或纯文本）
                    email_content = msg.html or msg.text
                    if not email_content:
                        logging.warning(f"邮件内容为空: ID={msg.uid}")
                        continue
                    
                    with open(temp_file, 'w', encoding='utf-8') as f:
                        f.write(email_content)
                    logging.debug(f"已保存邮件内容到临时文件: {temp_file}")
                    
                    # 调用main.py处理邮件
                    python_executable = sys.executable
                    logging.debug(f"使用 Python 解释器: {python_executable}")
                    logging.debug("开始执行 main.py")
                    
                    process = subprocess.run(
                        [python_executable, 'ics/main.py'],
                        capture_output=True,
                        text=True
                    )
                    
                    if process.returncode == 0:
                        logging.info("成功运行 main.py")
                        if process.stdout:
                            logging.debug(f"main.py 输出: {process.stdout}")
                    else:
                        logging.error(f"main.py 执行失败: {process.stderr}")
                        continue
                    
                    logging.info(f"已处理邮件: ID={msg.uid}, 日期={msg.date}")
                    
                except Exception as e:
                    logging.error(f"处理邮件时发生错误: {str(e)}")
                    continue
                    
        finally:
            # 清理临时文件
            if os.path.exists('temp'):
                shutil.rmtree('temp')
        
    except Exception as e:
        logging.error(f"处理邮件过程中发生错误: {str(e)}")

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

def monitor_emails():
    """使用 IMAP IDLE 监控邮件"""
    while True:
        try:
            with maintain_connection() as mailbox:
                # 选择收件箱
                mailbox.folder.set('INBOX')
                
                # 启动时先处理一次邮件
                logging.info("系统启动，开始处理现有邮件...")
                process_new_email(mailbox)
                
                # 开始 IDLE 监听
                logging.info("开始监听新邮件...")
                idle_start_time = time.time()
                
                # 使用 imap_tools 的 IDLE 功能
                for idle_response in mailbox.idle.wait(timeout=60*5):  # 5分钟超时
                    if isinstance(idle_response, bytes):
                        response_str = idle_response.decode('utf-8')
                        if 'EXISTS' in response_str:  # 检查是否有新邮件
                            logging.debug("检测到新邮件，等待10秒确保邮件同步...")
                            time.sleep(10)  # 等待10秒确保邮件同步
                            process_new_email(mailbox)
                    
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
