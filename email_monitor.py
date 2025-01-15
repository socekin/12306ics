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

# 全局变量，用于存储已处理的邮件ID
PROCESSED_EMAILS_FILE = 'processed_emails.pkl'
processed_email_ids: Set[str] = set()

def load_processed_emails() -> None:
    """加载已处理的邮件ID"""
    global processed_email_ids
    try:
        if os.path.exists(PROCESSED_EMAILS_FILE):
            with open(PROCESSED_EMAILS_FILE, 'rb') as f:
                processed_email_ids = pickle.load(f)
            logging.info(f"已加载 {len(processed_email_ids)} 个已处理的邮件ID")
    except Exception as e:
        logging.error(f"加载已处理邮件ID时出错: {str(e)}")
        processed_email_ids = set()

def save_processed_emails() -> None:
    """保存已处理的邮件ID"""
    try:
        with open(PROCESSED_EMAILS_FILE, 'wb') as f:
            pickle.dump(processed_email_ids, f)
        logging.debug("已保存处理过的邮件ID")
    except Exception as e:
        logging.error(f"保存已处理邮件ID时出错: {str(e)}")

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
        # 创建临时目录
        os.makedirs('temp', exist_ok=True)
        
        # 搜索目标发件人的未读邮件
        messages = mailbox.fetch(AND(from_=TARGET_SENDER))
        new_messages = []
        
        # 统计邮件数量
        all_messages = list(messages)
        total_count = len(all_messages)
        logging.info(f"总共找到 {total_count} 封目标邮件")
        
        # 检查日历文件是否存在
        calendar_file = os.path.join('ics', 'tickets.ics')
        if not os.path.exists(calendar_file):
            logging.info("[检查] 日历文件不存在，将重新处理所有邮件")
            processed_email_ids.clear()
        
        # 找出未处理的新邮件
        for msg in all_messages:
            # 如果邮件已处理，检查对应的日历文件是否存在
            if str(msg.uid) in processed_email_ids:
                if not os.path.exists(calendar_file):
                    logging.info(f"[检查] 邮件 {msg.uid} 的日历文件不存在，将重新处理")
                    processed_email_ids.remove(str(msg.uid))
                    new_messages.append(msg)
            else:
                new_messages.append(msg)
        
        new_count = len(new_messages)
        if new_count == 0:
            logging.info("没有新的未处理邮件")
            return
            
        logging.info(f"发现 {new_count} 封未处理的新邮件")
        
        # 处理每封新邮件
        for i, msg in enumerate(new_messages, 1):
            try:
                logging.info(f"新邮件{i}: ID={msg.uid}, 日期={msg.date}, 主题={msg.subject}")
                
                # 获取邮件内容
                content = get_email_content(msg)
                if not content:
                    logging.warning(f"无法获取邮件 {msg.uid} 的内容")
                    continue
                    
                # 保存到临时文件
                temp_file = f'temp/email_{msg.uid}.txt'
                with open(temp_file, 'w', encoding='utf-8') as f:
                    f.write(content)
                logging.debug(f"已保存邮件内容到临时文件: {temp_file}")
                
                # 使用系统 Python 路径
                python_path = 'python3' if os.path.exists('/app') else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'myenv', 'bin', 'python')
                logging.debug(f"使用 Python 解释器: {python_path}")
                logging.debug("开始执行 main.py")
                
                main_script = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ics', 'main.py')
                result = subprocess.run(
                    [python_path, main_script, '--email-file', temp_file],
                    capture_output=True,
                    text=True,
                    encoding='utf-8'
                )
                
                if result.returncode == 0:
                    logging.info("成功运行 main.py")
                    if result.stdout:
                        logging.debug(f"main.py 输出: {result.stdout}")
                    # 标记邮件为已处理
                    processed_email_ids.add(str(msg.uid))
                    save_processed_emails()
                    logging.debug("已保存处理过的邮件ID")
                    logging.info(f"已处理邮件: ID={msg.uid}, 日期={msg.date}")
                else:
                    logging.error(f"处理邮件时出错: {result.stderr}")
                
                # 处理完后删除临时文件
                os.remove(temp_file)
                logging.debug(f"已删除临时文件: {temp_file}")
                
            except Exception as e:
                logging.error(f"处理邮件时发生错误: {str(e)}")
                logging.exception("详细错误信息:")
                continue
                    
        # 最后删除临时目录
        if os.path.exists('temp'):
            shutil.rmtree('temp')
            logging.debug("已清理临时目录")
                
    except Exception as e:
        logging.error(f"处理新邮件时发生错误: {str(e)}")
        logging.exception("详细错误信息:")

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
    first_run = True  # 添加标志位
    while True:
        try:
            with maintain_connection() as mailbox:
                # 选择收件箱
                mailbox.folder.set('INBOX')
                logging.info("=" * 50)  # 添加分隔线
                
                # 只在首次运行时处理现有邮件
                if first_run:
                    logging.info("[初始化] 系统首次启动，开始处理现有邮件...")
                    process_new_email(mailbox)
                    first_run = False
                    logging.info("[初始化] 初始邮件处理完成")
                    logging.info("-" * 50)  # 添加分隔线
                
                # 开始 IDLE 监听
                logging.info("[监听] 开始 IMAP IDLE 监听模式")
                logging.info("[状态] 等待新邮件...")
                idle_start_time = time.time()
                
                # 使用 imap_tools 的 IDLE 功能
                for idle_response in mailbox.idle.wait(timeout=60*5):  # 5分钟超时
                    if isinstance(idle_response, bytes):
                        response_str = idle_response.decode('utf-8')
                        logging.debug(f"[IDLE] 收到响应: {response_str}")
                        
                        # 检查各种可能的新邮件通知
                        if any(keyword in response_str.upper() for keyword in ['EXISTS', 'RECENT', 'FETCH']):
                            logging.info("[新邮件] 检测到新邮件到达")
                            logging.info("[处理中] 等待10秒确保邮件同步...")
                            time.sleep(10)  # 等待10秒确保邮件同步
                            
                            # 重新选择收件箱以刷新状态
                            mailbox.folder.set('INBOX')
                            process_new_email(mailbox)
                            logging.info("[完成] 新邮件处理完成")
                            logging.info("[状态] 继续等待新邮件...")
                            
                            # 重置空闲计时器
                            idle_start_time = time.time()
                    
                    # 检查是否需要刷新连接
                    current_time = time.time()
                    if current_time - idle_start_time > 60*5:  # 5分钟后刷新
                        logging.info("[维护] IMAP IDLE 连接超时，准备刷新...")
                        break
                
                logging.info("[维护] 正在刷新 IMAP 连接...")
                # 在刷新连接时检查新邮件
                mailbox.folder.set('INBOX')
                process_new_email(mailbox)
                logging.info("=" * 50)  # 添加分隔线
                
        except Exception as e:
            logging.error(f"[错误] 监控过程发生错误: {str(e)}")
            logging.exception("[错误] 详细错误信息:")
            logging.info("[重试] 30秒后尝试重新连接...")
            time.sleep(30)

def main():
    """主函数"""
    logging.info("邮件监控服务启动")
    logging.info(f"目标发件人: {TARGET_SENDER}")
    
    # 加载已处理的邮件ID
    load_processed_emails()
    
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
