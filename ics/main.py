import imaplib
import email
import email.utils
import re
import json
import datetime
import sys
import os
import logging
from dotenv import load_dotenv
import pytz
from ics import Calendar, Event
import argparse

# 配置日志记录器
current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)
log_file = os.path.join(parent_dir, 'email_monitor.log')

logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(levelname)s - %(message)s',
    handlers=[
        logging.FileHandler(log_file),
        logging.StreamHandler()
    ]
)

# 导入 train_query.py
sys.path.insert(0, parent_dir)
from train_query import query_arrival_time

def connect_to_email(username, password):
    """连接到邮箱"""
    try:
        # QQ邮箱 IMAP 服务器
        mail = imaplib.IMAP4_SSL('imap.qq.com', 993)
        response, account_details = mail.login(username, password)
        if response == 'OK':
            return mail
        else:
            print(f"登录失败: {account_details}")
            return None
    except Exception as e:
        print(f"IMAP登录错误: {str(e)}")
        return None

def search_for_12306_emails(mail):
    """搜索12306邮件"""
    try:
        # 选择收件箱
        mail.select('INBOX')
        
        # 搜索来自目标发件人的邮件
        target_sender = os.getenv("TARGET_SENDER")
        if not target_sender:
            print("错误：未设置 TARGET_SENDER 环境变量")
            return []
            
        print(f"搜索发件人: {target_sender} 的邮件")
        typ, data = mail.search(None, 'FROM', target_sender)
        if typ != 'OK':
            print(f"搜索邮件失败: {typ}")
            return []
        
        email_ids = data[0].split()
        print(f"找到 {len(email_ids)} 封邮件")
        return email_ids
    except Exception as e:
        print(f"搜索邮件错误: {str(e)}")
        return []

def get_email_date(mail, email_id):
    """获取邮件日期"""
    typ, data = mail.fetch(email_id, '(BODY[HEADER.FIELDS (DATE)])')
    if typ == 'OK':
        for part in data:
            if isinstance(part, tuple):
                header_data = part[1].decode()
                match = re.search(r'Date: (.*)', header_data)
                if match:
                    try:
                        date_tuple = email.utils.parsedate_tz(match.group(1))
                        if date_tuple:
                            return email.utils.mktime_tz(date_tuple)
                    except AttributeError:
                        pass
    return None

def fetch_and_parse_email(mail, email_id):
    """获取并解析邮件内容"""
    typ, data = mail.fetch(email_id, '(RFC822)')
    if typ == 'OK':
        msg = email.message_from_bytes(data[0][1])
        for part in msg.walk():
            if part.get_content_type() in ['text/plain', 'text/html']:
                charset = part.get_content_charset() or 'utf-8'
                try:
                    content = part.get_payload(decode=True).decode(charset)
                    if content.strip():
                        return content
                except:
                    continue
    return ""

def extract_ticket_info(email_content):
    """提取车票信息"""
    # 支持三种邮件格式，按优先级排序：
    # 1. 普通购票格式（包含票种和可选的检票口）
    # 2. 候补购票格式（有检票口）
    # 3. 候补购票格式（无检票口）
    patterns = [
        # 普通购票格式（包含票种和可选的检票口）
        r"(\d{4}年\d{1,2}月\d{1,2}日)(\d{2}:\d{2})开[，,](.+?站)-(.+?站)[，,]((?:G|D|Z|T|K)\d+)次列车[，,](\d+车\d+[A-Z]号)[，,](.+?座)[，,](?:.+?票[，,])?票价(\d+\.\d+)元(?:[，,]检票口([^，。]+))?[，,。]",
        # 候补购票格式（有检票口）
        r"(\d{4}年\d{1,2}月\d{1,2}日)(\d{2}:\d{2})开[，,](.+?站)-(.+?站)[，,]((?:G|D|Z|T|K)\d+)次列车[，,](\d+车\d+[A-Z]号)[，,](.+?座)[，,]票价(\d+\.\d+)元[，,]检票口([^，。]+)[。，,]",
        # 候补购票格式（无检票口）
        r"(\d{4}年\d{1,2}月\d{1,2}日)(\d{2}:\d{2})开[，,](.+?站)-(.+?站)[，,]((?:G|D|Z|T|K)\d+)次列车[，,](\d+车\d+[A-Z]号)[，,](.+?座)[，,]票价(\d+\.\d+)元[。，,]"
    ]
    
    # 遍历所有模式，按优先级顺序尝试匹配
    for i, pattern in enumerate(patterns):
        logging.info(f"尝试模式 {i+1}: {pattern}")
        match = re.search(pattern, email_content)
        if match:
            logging.info(f"使用模式 {i+1} 匹配成功")
            logging.info(f"完整匹配文本: {match.group(0)}")
            groups = match.groups()
            logging.info(f"匹配组: {groups}")
            
            travel_date, travel_time, from_station, to_station, train_number, seat, seat_type, price = groups[:8]
            gate = groups[8] if len(groups) > 8 else None
            
            logging.info(f"提取的车票基本信息:")
            logging.info(f"  日期: {travel_date}")
            logging.info(f"  时间: {travel_time}")
            logging.info(f"  出发站: {from_station}")
            logging.info(f"  到达站: {to_station}")
            logging.info(f"  车次: {train_number}")
            logging.info(f"  座位: {seat}")
            logging.info(f"  座位类型: {seat_type}")
            logging.info(f"  票价: {price}")
            logging.info(f"  检票口原始信息: {gate}")
            
            return travel_date, travel_time, from_station, to_station, train_number, seat, seat_type, price, gate
            
    logging.error("未能匹配任何已知格式")
    return None

def create_calendar_event(ticket_info):
    """生成日历事件"""
    c = Calendar()
    e = Event()
    e.name = f"{ticket_info[4]} {ticket_info[2]} - {ticket_info[3]}"
    
    # 创建中国时区
    tz = pytz.timezone('Asia/Shanghai')
    
    # 设置出发时间
    departure_str = f"{ticket_info[0]} {ticket_info[1]}:00"
    departure_naive = datetime.datetime.strptime(departure_str, "%Y年%m月%d日 %H:%M:%S")
    departure_local = tz.localize(departure_naive)
    e.begin = departure_local
    
    # 设置到达时间
    arrival_time = query_arrival_time(ticket_info[0], ticket_info[4], ticket_info[3])
    if not arrival_time:
        # 如果查询不到到达时间，使用出发时间加2小时作为预估到达时间
        departure_time_obj = datetime.datetime.strptime(ticket_info[1], "%H:%M")
        arrival_time_obj = departure_time_obj + datetime.timedelta(hours=2)
        arrival_time = arrival_time_obj.strftime("%H:%M")
        logging.warning(f"无法获取到达时间，使用预估时间：{arrival_time}")
    arrival_str = f"{ticket_info[0]} {arrival_time}:00"
    arrival_naive = datetime.datetime.strptime(arrival_str, "%Y年%m月%d日 %H:%M:%S")
    arrival_local = tz.localize(arrival_naive)
    e.end = arrival_local
    
    e.description = f"座位：{ticket_info[5]}\n" \
                   f"座位类型：{ticket_info[6]}\n" \
                   f"票价：{ticket_info[7]}元\n" \
                   f"检票口：{ticket_info[8]}"
    logging.info("准备生成日历事件")
    logging.info(f"日历事件基本信息:")
    logging.info(f"  标题: {ticket_info[4]} {ticket_info[2]} - {ticket_info[3]}")
    logging.info(f"  开始时间: {departure_local}")
    logging.info(f"  结束时间: {arrival_local}")
    logging.info(f"  描述内容:")
    logging.info(f"    座位：{ticket_info[5]}")
    logging.info(f"    座位类型：{ticket_info[6]}")
    logging.info(f"    票价：{ticket_info[7]}元")
    logging.info(f"    检票口：{ticket_info[8]}")
    logging.info("最终生成的日历事件:")
    logging.info(f"  名称: {e.name}")
    logging.info(f"  开始: {e.begin}")
    logging.info(f"  结束: {e.end}")
    logging.info(f"  描述: {e.description}")
    return e

def get_recent_tickets_info(username, password):
    """获取最近的车票信息"""
    mail = connect_to_email(username, password)
    if not mail:
        return []

    email_ids = search_for_12306_emails(mail)
    if not email_ids:
        return []

    # 按日期排序邮件
    email_dates = [(email_id, get_email_date(mail, email_id)) for email_id in email_ids]
    sorted_emails = sorted(email_dates, key=lambda x: x[1] or 0, reverse=True)[:7]  # 获取最近7封邮件

    tickets_info = []
    for email_id, _ in sorted_emails:
        content = fetch_and_parse_email(mail, email_id)
        if content:
            ticket_info = extract_ticket_info(content)
            if ticket_info:
                tickets_info.append(ticket_info)

    mail.logout()
    return tickets_info

def process_email_files(temp_dir):
    """处理临时邮件文件"""
    tickets_info = []
    for file_name in os.listdir(temp_dir):
        if file_name.startswith('email_') and file_name.endswith('.txt'):
            file_path = os.path.join(temp_dir, file_name)
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()
                ticket_info = extract_ticket_info(content)
                if ticket_info:
                    tickets_info.append(ticket_info)
    return tickets_info

def main():
    """主函数"""
    try:
        logging.info("开始处理车票信息")
        # 加载环境变量
        load_dotenv()
        logging.info("已加载环境变量")
        
        # 检查是否有临时目录参数
        parser = argparse.ArgumentParser()
        parser.add_argument('--temp-dir', help='临时邮件文件目录')
        args = parser.parse_args()
        
        tickets_info = []
        if args.temp_dir and os.path.exists(args.temp_dir):
            logging.info(f"从临时目录处理邮件: {args.temp_dir}")
            # 从临时文件处理邮件
            tickets_info = process_email_files(args.temp_dir)
            logging.info(f"从临时文件中找到 {len(tickets_info)} 张车票")
        else:
            logging.info("从邮箱获取邮件")
            # 从邮箱获取邮件（兼容旧的处理方式）
            username = os.getenv("EMAIL_USERNAME")
            password = os.getenv("EMAIL_PASSWORD")
            if not username or not password:
                logging.error("未设置邮箱账号或密码")
                return
            tickets_info = get_recent_tickets_info(username, password)
            logging.info(f"从邮箱中找到 {len(tickets_info)} 张车票")
        
        if not tickets_info:
            logging.warning("未找到有效的车票信息")
            return

        # 创建日历
        cal = Calendar()
        logging.info("开始创建日历事件")
        
        # 为每张车票创建事件
        for i, ticket_info in enumerate(tickets_info, 1):
            logging.info(f"处理第 {i} 张车票")
            event = create_calendar_event(ticket_info)
            if event:
                cal.events.add(event)
                logging.info(f"已添加第 {i} 张车票的日历事件")

        # 保存日历文件到 ics 目录
        current_dir = os.path.dirname(os.path.abspath(__file__))
        ics_file_path = os.path.join(current_dir, 'tickets.ics')
        with open(ics_file_path, 'w', encoding='utf-8') as f:
            f.write(str(cal))
        logging.info(f"成功处理 {len(tickets_info)} 张车票信息并更新日历文件: {ics_file_path}")

    except Exception as e:
        logging.error(f"处理过程中发生错误: {str(e)}", exc_info=True)
        raise

if __name__ == "__main__":
    main()
