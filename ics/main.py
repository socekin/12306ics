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
    # 支持两种邮件格式：
    # 1. 普通购票：日期+时间开，站点-站点，车次，座位号，座位类型，票价，[检票口]
    # 2. 候补购票：日期+时间开，站点-站点，车次，座位号，座位类型，票价。
    patterns = [
        # 普通购票格式
        r"(\d{4}年\d{1,2}月\d{1,2}日)(\d{2}:\d{2})开[，,](.+?站)-(.+?站)[，,]((?:G|D|Z|T|K)\d+)次列车[，,](\d+车\d+[A-Z]号)[，,](.+?座)[，,](?:.+?票[，,])?票价(\d+\.\d+)元(?:[，,]检票口([^，。]+))?[，,。]",
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
        
        # 处理检票口信息
        gate_info = "无"
        gate_letter = ""
        if gate:
            # 分离检票口号码和字母
            gate = gate.strip()
            # 处理类似 "2AB" 的格式
            if re.match(r'^\d+[A-Z]+$', gate):
                # 分离数字和字母
                gate_number = re.match(r'^\d+', gate).group()
                gate_letter = gate[len(gate_number):]
                gate_info = gate_number
            # 处理类似 "二楼3 B" 的格式
            elif gate[-1].isalpha() and gate[-2].isspace():
                gate_letter = gate[-1]
                gate_info = gate[:-2].strip()
            else:
                gate_info = gate
        
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
            "gate": gate_info,
            "gate_letter": gate_letter
        }
        return ticket_info
    return None

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
                   f"检票口：{ticket_info['gate'].strip()} {ticket_info.get('gate_letter', '')}"
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
        # 加载环境变量
        load_dotenv()
        
        # 检查是否有临时目录参数
        parser = argparse.ArgumentParser()
        parser.add_argument('--temp-dir', help='临时邮件文件目录')
        args = parser.parse_args()
        
        tickets_info = []
        if args.temp_dir and os.path.exists(args.temp_dir):
            # 从临时文件处理邮件
            tickets_info = process_email_files(args.temp_dir)
        else:
            # 从邮箱获取邮件（兼容旧的处理方式）
            username = os.getenv("EMAIL_USERNAME")
            password = os.getenv("EMAIL_PASSWORD")
            if not username or not password:
                print("错误：未设置邮箱账号或密码")
                return
            tickets_info = get_recent_tickets_info(username, password)
        
        if not tickets_info:
            print("未找到有效的车票信息")
            return

        # 创建日历
        cal = Calendar()
        
        # 为每张车票创建事件
        for ticket_info in tickets_info:
            event = create_calendar_event(ticket_info)
            if event:
                cal.events.add(event)

        # 保存日历文件到 ics 目录
        current_dir = os.path.dirname(os.path.abspath(__file__))
        ics_file_path = os.path.join(current_dir, 'tickets.ics')
        with open(ics_file_path, 'w', encoding='utf-8') as f:
            f.write(str(cal))
        print(f"成功处理 {len(tickets_info)} 张车票信息并更新日历文件: {ics_file_path}")

    except Exception as e:
        print(f"处理过程中发生错误: {str(e)}")
        raise

if __name__ == "__main__":
    main()
