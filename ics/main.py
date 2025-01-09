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

# 导入 train_query.py
current_dir = os.path.dirname(os.path.abspath(__file__))
parent_dir = os.path.dirname(current_dir)
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
    # 选择收件箱
    mail.select('INBOX')
    
    # 搜索来自 12306@rails.com.cn 的邮件
    typ, data = mail.search(None, 'FROM', '12306@rails.com.cn')
    if typ != 'OK':
        return []
    
    email_ids = data[0].split()
    
    return email_ids

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
    # 支持两种邮件格式：
    # 1. 普通购票：日期+时间开，站点-站点，车次，座位号，座位类型，票价，[检票口]
    # 2. 候补购票：日期+时间开，站点-站点，车次，座位号，座位类型，票价。
    patterns = [
        # 普通购票格式
        r"(\d{4}年\d{1,2}月\d{1,2}日)(\d{2}:\d{2})开[，,](.+?站)-(.+?站)[，,]((?:G|D|Z|T|K)\d+)次列车[，,](\d+车\d+[A-Z]号)[，,](.+?座)[，,](?:.+?票[，,])?票价(\d+\.\d+)元(?:[，,]检票口(.+?))?[，,]",
        # 候补购票格式
        r"(\d{4}年\d{1,2}月\d{1,2}日)(\d{2}:\d{2})开[，,](.+?站)-(.+?站)[，,]((?:G|D|Z|T|K)\d+)次列车[，,](\d+车\d+[A-Z]号)[，,](.+?座)[，,]票价(\d+\.\d+)元[。,，]"
    ]
    
    latest_match = None
    matched_pattern = None
    
    # 尝试每个模式
    for pattern in patterns:
        matches = re.finditer(pattern, email_content, re.DOTALL)
        for match in matches:
            latest_match = match
            matched_pattern = pattern
    
    if latest_match:
        groups = latest_match.groups()
        travel_date, travel_time, from_station, to_station, train_number, seat, seat_type, price = groups[:8]
        gate = groups[8] if len(groups) > 8 and matched_pattern == patterns[0] else None
        
        # 转换日期格式为 YYYY-MM-DD
        date_obj = datetime.datetime.strptime(travel_date, "%Y年%m月%d日")
        formatted_date = date_obj.strftime("%Y-%m-%d")
        
        # 去掉站名中的"站"字
        from_station = from_station.replace("站", "")
        to_station = to_station.replace("站", "")
        
        # 查询到达时间
        arrival_time = query_arrival_time(formatted_date, train_number, to_station)
        if not arrival_time:
            # 如果查询不到到达时间，使用出发时间加2小时作为预估到达时间
            departure_time_obj = datetime.datetime.strptime(travel_time, "%H:%M")
            arrival_time_obj = departure_time_obj + datetime.timedelta(hours=2)
            arrival_time = arrival_time_obj.strftime("%H:%M")
            logging.warning(f"无法获取到达时间，使用预估时间：{arrival_time}")
        
        ticket_info = {
            "date": formatted_date,
            "train_number": train_number,
            "from_station": from_station,
            "to_station": to_station,
            "departure_time": travel_time,
            "arrival_time": arrival_time,
            "seat": seat,
            "seat_type": seat_type,
            "price": price,
            "gate": gate.strip() if gate else "无"
        }
        return ticket_info
    return None

def get_latest_ticket_info(username, password):
    """获取最新的车票信息"""
    # 连接到邮箱
    mail = connect_to_email(username, password)
    if not mail:
        print("连接邮箱失败")
        return None

    # 搜索12306邮件
    email_ids = search_for_12306_emails(mail)
    if not email_ids:
        print("未找到12306邮件")
        return None

    # 获取所有邮件的日期并排序
    email_dates = []
    for email_id in email_ids:
        date = get_email_date(mail, email_id)
        if date:
            email_dates.append((email_id, date))
    
    if not email_dates:
        print("无法获取邮件日期")
        return None
    
    # 按日期排序并获取最新的邮件
    latest_email = sorted(email_dates, key=lambda x: x[1], reverse=True)[0]
    latest_email_id = latest_email[0]
    
    # 获取邮件内容
    email_content = fetch_and_parse_email(mail, latest_email_id)
    if not email_content:
        print("获取邮件内容失败")
        return None

    # 提取车票信息
    ticket_info = extract_ticket_info(email_content)
    if not ticket_info:
        print("无法提取车票信息")
        return None

    # 打印车票信息
    print("\n最新车票信息:")
    print(f"日期: {ticket_info['date']}")
    print(f"车次: {ticket_info['train_number']}")
    print(f"出发站: {ticket_info['from_station']}")
    print(f"到达站: {ticket_info['to_station']}")
    print(f"出发时间: {ticket_info['departure_time']}")
    print(f"到达时间: {ticket_info['arrival_time']}")
    print(f"座位: {ticket_info['seat']}")
    print(f"座位类型: {ticket_info['seat_type']}")
    print(f"票价: {ticket_info['price']}元")
    print(f"检票口: {ticket_info['gate']}")

    return ticket_info

def create_calendar_event(ticket_info):
    """生成日历事件"""
    c = Calendar()
    e = Event()
    e.name = f"{ticket_info['train_number']} {ticket_info['from_station']} - {ticket_info['to_station']}"
    
    # 创建中国时区
    tz = pytz.timezone('Asia/Shanghai')
    
    # 设置出发时间
    departure_str = f"{ticket_info['date']} {ticket_info['departure_time']}:00"
    departure_naive = datetime.datetime.strptime(departure_str, "%Y-%m-%d %H:%M:%S")
    departure_local = tz.localize(departure_naive)
    e.begin = departure_local
    
    # 设置到达时间
    arrival_str = f"{ticket_info['date']} {ticket_info['arrival_time']}:00"
    arrival_naive = datetime.datetime.strptime(arrival_str, "%Y-%m-%d %H:%M:%S")
    arrival_local = tz.localize(arrival_naive)
    e.end = arrival_local
    
    e.description = f"座位：{ticket_info['seat']}\n" \
                   f"座位类型：{ticket_info['seat_type']}\n" \
                   f"票价：{ticket_info['price']}元\n" \
                   f"检票口：{ticket_info['gate']}"
    c.events.add(e)
    
    # 保存日历文件到 ics 目录
    current_dir = os.path.dirname(os.path.abspath(__file__))
    ics_file_path = os.path.join(current_dir, 'ticket.ics')
    with open(ics_file_path, 'w') as f:
        f.write(str(c))

def main():
    """主函数"""
    # 获取邮箱账号密码
    env_path = os.path.join(os.path.dirname(os.path.dirname(__file__)), '.env')
    load_dotenv(env_path)
    username = os.getenv('EMAIL_USERNAME')
    password = os.getenv('EMAIL_PASSWORD')

    if not username or not password:
        print("请在 .env 文件中设置邮箱账号和密码")
        return

    # 获取车票信息
    ticket_info = get_latest_ticket_info(username, password)
    if not ticket_info:
        print("获取车票信息失败")
        return

    # 生成日历文件
    create_calendar_event(ticket_info)
    print("\n已生成日历文件 ticket.ics")

if __name__ == "__main__":
    main()
