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
from calendar_service import add_event as push_event

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
    try:
        logging.info("开始创建日历事件...")
        c = Calendar()
        e = Event()
        e.name = f"{ticket_info[4]} {ticket_info[2]} - {ticket_info[3]}"
        
        # 创建中国时区
        tz = pytz.timezone('Asia/Shanghai')
        
        # 设置出发时间
        departure_str = f"{ticket_info[0]} {ticket_info[1]}:00"
        logging.debug(f"原始出发时间字符串: {departure_str}")
        departure_naive = datetime.datetime.strptime(departure_str, "%Y年%m月%d日 %H:%M:%S")
        departure_local = tz.localize(departure_naive)
        e.begin = departure_local
        logging.debug(f"设置出发时间: {e.begin}")
        
        # 转换日期格式和站名格式
        logging.debug(f"原始日期: {ticket_info[0]}")
        date_obj = datetime.datetime.strptime(ticket_info[0], "%Y年%m月%d日")
        date_str = date_obj.strftime("%Y-%m-%d")
        logging.debug(f"转换后日期: {date_str}")
        
        logging.debug(f"原始站名: {ticket_info[3]}")
        station_name = ticket_info[3].replace("站", "")
        logging.debug(f"处理后站名: {station_name}")
        
        # 处理车次号
        logging.debug(f"原始车次号: {ticket_info[4]}")
        train_code = ticket_info[4].strip()
        logging.debug(f"处理后车次号: {train_code}")
        
        # 设置到达时间
        logging.info("开始查询到达时间...")
        logging.debug(f"查询参数 - 日期: {date_str}, 车次: {train_code}, 站名: {station_name}")
        arrival_time = query_arrival_time(date_str, train_code, station_name)
        logging.debug(f"查询结果: {arrival_time}")
        
        if arrival_time:
            try:
                # 验证时间格式
                datetime.datetime.strptime(arrival_time, "%H:%M")
                arrival_str = f"{ticket_info[0]} {arrival_time}:00"
                logging.info(f"成功获取到达时间: {arrival_time}")
            except ValueError:
                logging.warning(f"获取的到达时间格式无效: {arrival_time}")
                arrival_time = ""
        
        if not arrival_time:
            logging.warning("未能获取到达时间，将使用预估时间...")
            # 如果查询不到到达时间，使用出发时间加2小时作为预估到达时间
            departure_time_obj = datetime.datetime.strptime(ticket_info[1], "%H:%M")
            arrival_time_obj = departure_time_obj + datetime.timedelta(hours=2)
            arrival_time = arrival_time_obj.strftime("%H:%M")
            arrival_str = f"{ticket_info[0]} {arrival_time}:00"
            logging.warning(f"使用预估到达时间：{arrival_time}")
            
        logging.debug(f"完整到达时间字符串: {arrival_str}")
        arrival_naive = datetime.datetime.strptime(arrival_str, "%Y年%m月%d日 %H:%M:%S")
        arrival_local = tz.localize(arrival_naive)
        e.end = arrival_local
        logging.debug(f"设置到达时间: {e.end}")
        
        e.description = f"座位：{ticket_info[5]}\n" \
                       f"座位类型：{ticket_info[6]}\n" \
                       f"票价：{ticket_info[7]}元\n" \
                       f"检票口：{ticket_info[8]}"
        
        logging.info("日历事件创建完成")
        return e
        
    except Exception as e:
        logging.error(f"创建日历事件时出错: {str(e)}")
        logging.exception("详细错误信息:")
        raise

def process_email_file(file_path):
    """处理单个邮件文件"""
    try:
        with open(file_path, 'r', encoding='utf-8') as f:
            content = f.read()
            ticket_info = extract_ticket_info(content)
            if ticket_info:
                return ticket_info
    except Exception as e:
        logging.error(f"处理文件 {file_path} 时出错: {str(e)}")
    return None

def main():
    """主函数"""
    try:
        logging.info("开始处理车票信息")
        # 加载环境变量
        load_dotenv()
        logging.info("已加载环境变量")
        
        # 检查临时目录参数
        parser = argparse.ArgumentParser()
        parser.add_argument('--email-file', required=True, help='要处理的邮件文件路径')
        args = parser.parse_args()
        
        if not os.path.exists(args.email_file):
            logging.error(f"邮件文件不存在: {args.email_file}")
            return
            
        logging.info(f"处理邮件文件: {args.email_file}")
        ticket_info = process_email_file(args.email_file)
        
        if not ticket_info:
            logging.warning("未找到有效的车票信息")
            return

        # 创建或加载现有日历
        current_dir = os.path.dirname(os.path.abspath(__file__))
        ics_file_path = os.path.join(current_dir, 'tickets.ics')
        
        if os.path.exists(ics_file_path):
            with open(ics_file_path, 'r', encoding='utf-8') as f:
                cal = Calendar(f.read())
            logging.info("已加载现有日历文件")
        else:
            cal = Calendar()
            logging.info("创建新的日历文件")

        # 创建事件
        logging.info("开始创建日历事件")
        event = create_calendar_event(ticket_info)
        if event:
            cal.events.add(event)
            logging.info("已添加新的日历事件")

            # 保存日历文件
            with open(ics_file_path, 'w', encoding='utf-8') as f:
                f.write(str(cal))
            logging.info(f"已更新日历文件: {ics_file_path}")

            # 推送到 CalDAV 日历
            try:
                push_event(event)
                logging.info("已同步事件到 CalDAV 日历")
            except Exception as e:
                logging.error(f"同步到 CalDAV 日历失败: {e}")

    except Exception as e:
        logging.error(f"处理过程中发生错误: {str(e)}", exc_info=True)
        raise

if __name__ == "__main__":
    main()
