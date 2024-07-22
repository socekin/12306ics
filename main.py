import imaplib
import email
import email.utils
import re
import json
from ics import Calendar, Event
from datetime import datetime, timedelta
from flask import Flask, send_file
from apscheduler.schedulers.background import BackgroundScheduler
import atexit
import pytz

app = Flask(__name__)

# 邮箱连接
def connect_to_email(username, password):
    try:
        mail = imaplib.IMAP4_SSL('imap.qq.com', 993)
        response, account_details = mail.login(username, password)
        if response == 'OK':
            print("Logged in successfully using SSL!")
            return mail
        else:
            print("Login failed: ", account_details)
            return None
    except imaplib.IMAP4.error as e:
        print("IMAP login error: ", str(e))
        return None

# 搜索指定发件人的邮件
def search_for_12306_emails(mail):
    mail.select('INBOX')  # 选择INBOX文件夹
    typ, data = mail.search(None, 'FROM', "\"12306@rails.com.cn\"")  # Adjust the email address as needed
    if typ == 'OK':
        print(f"Search successful, found {len(data[0].split())} emails")
        return data[0].split()
    else:
        print("Failed to search emails.")
        return []

# 获取邮件日期
def get_email_date(mail, email_id):
    # 确保我们以字符串形式传递email_id给fetch方法
    typ, data = mail.fetch(email_id.decode('utf-8'), '(BODY[HEADER.FIELDS (DATE)])')
    if typ == 'OK':
        for part in data:
            if isinstance(part, tuple):
                #尝试从邮件头信息部分获取Date字段
                header_data = part[1].decode() 
                match = re.search(r'Date: (.*)', header_data)
                if match:
                    try:
                        # 用email.utils.parsedate_tz来解析日期字符串
                        date_tuple = email.utils.parsedate_tz(match.group(1))
                        if date_tuple:
                            return email.utils.mktime_tz(date_tuple)
                    except AttributeError:
                        pass
    return None

# 读取和解析邮件内容
def fetch_and_parse_email(mail, email_id):
    typ, data = mail.fetch(email_id, '(RFC822)')
    if typ == 'OK':
        msg = email.message_from_bytes(data[0][1])
        body = ""
        if msg.is_multipart():
            for part in msg.walk():
                # 检查部分是否为text/plain或text/html
                if part.get_content_type() in ['text/plain', 'text/html']:
                    charset = part.get_content_charset()
                    if charset is None:
                        charset = 'utf-8'
                    body = part.get_payload(decode=True)
                    return body.decode(charset)
        else:
            charset = msg.get_content_charset()
            if charset is None:
                charset = 'utf-8'
            body = msg.get_payload(decode=True)
            return body.decode(charset)
    return ""

# 提取车票信息
def extract_ticket_info(email_content):
    print("[INFO] 开始提取车票信息...")
    pattern = r"(\d{4}年\d{2}月\d{1,2}日)(\d{2}:\d{2})开[，,](.+?站)-(.+?站)[，,](G\d+)次列车[，,](\d+车\d+[A-Z]号)[，,](.+?)[，,](?:.+?票[，,])?票价(\d+\.\d+)元[，,]?(?:检票口(\w+))?(?:，.+)?"
    match = re.search(pattern, email_content, re.DOTALL)
    if match:
        # 正则表达式中实际上有9个匹配组
        travel_date, travel_time, from_station, to_station, train_number, seat, seat_type, price, gate = match.groups()
        full_travel_date = f"{travel_date} {travel_time}开"
        ticket_info = {
            "travel_date": full_travel_date,
            "from_station": from_station,
            "to_station": to_station,
            "train_number": train_number,
            "seat": seat,
            "seat_type": seat_type,  # 添加座位类型
            "price": price,
            "gate": gate
        }
        print("[INFO] 提取到的车票信息: ", ticket_info)
        return ticket_info
    else:
        print("[WARNING] 无法提取车票信息，请检查邮件内容和正则表达式！")
        return None



    # 创建ICS日历事件
def create_ics(ticket_info):
    print("[INFO] 开始创建ICS文件...")
    try:
        tz = pytz.timezone('Asia/Shanghai')
        departure_time_str = ticket_info["travel_date"].replace("开", "")
        departure_time = datetime.strptime(departure_time_str, "%Y年%m月%d日 %H:%M")
        departure_time = tz.localize(departure_time)
        duration = timedelta(hours=2)  # 仅作为行程时间示例，根据具体情况可以调整
        arrival_time = departure_time + duration

        event = Event()
        event.name = f"列车行程: {ticket_info['train_number']} 次 {ticket_info['from_station']} - {ticket_info['to_station']}"
        event.begin = departure_time
        event.end = arrival_time
        event.description = (f"车次: {ticket_info['train_number']}\n"
                             f"座位: {ticket_info['seat']}\n" 
                             f"座位类型: {ticket_info['seat_type']}\n"  # 追加座位类型
                             f"票价: {ticket_info['price']}元\n"
                             f"检票口: {ticket_info['gate']}\n"
                             f"出发站: {ticket_info['from_station']}\n"
                             f"到达站: {ticket_info['to_station']}")
        event.location = f"{ticket_info['from_station']} 至 {ticket_info['to_station']}"

        calendar = Calendar()
        calendar.events.add(event)
        ics_content = calendar.serialize()
        print("[INFO] ICS文件创建成功。")
        return ics_content
    except Exception as e:
        print(f"[ERROR] 创建ICS文件过程中发生错误：{e}")
        return None

# 主流程
def fetch_emails_and_generate_ics():
    mail = connect_to_email('account@qq.com', 'password')
    if mail:
        email_ids = search_for_12306_emails(mail)
        latest_email_id = None
        latest_timestamp = 0
        
        print(f"Email IDs found: {email_ids}")  # Print to check the email IDs

        for email_id in email_ids:
            email_date = get_email_date(mail, email_id)
            print(f"Email ID: {email_id.decode('utf-8')}, Date: {email_date}")  # 确保正确打印email ID
            if email_date and email_date > latest_timestamp:
                latest_timestamp = email_date
                latest_email_id = email_id.decode('utf-8')  # 保存最新email ID为字符串

        print(f"Latest email ID: {latest_email_id}")  # Confirm the latest email ID

        if latest_email_id:
            email_content = fetch_and_parse_email(mail, latest_email_id)
            if email_content:
                print("邮件内容:\n", email_content)
                ticket_info = extract_ticket_info(email_content)
                if ticket_info:
                    print("车票信息:\n", ticket_info)
                    ics_content = create_ics(ticket_info)
                    # 修改文件路径为绝对路径，确保其在Docker容器中的`/app`目录下
                    ics_filepath = "/app/ics/ticket_event.ics"  # 使用绝对路径
                    with open(ics_filepath, "w") as file:
                        file.write(ics_content)
                    print("ICS file created successfully.")
                else:
                    print("No valid ticket info to create ICS.")
        else:
            print("Unable to retrieve or identify latest email.")
        mail.logout()

# 初始化并启动调度器
scheduler = BackgroundScheduler()
scheduler.add_job(func=fetch_emails_and_generate_ics, trigger='interval', minutes=10)
scheduler.start()

# 监听退出
atexit.register(lambda: scheduler.shutdown())

@app.route('/download_ics')
def download_ics():
    try:
        return send_file('/app/ics/ticket_event.ics', as_attachment=True, download_name='ticket_event.ics')
    except FileNotFoundError:
        return '无法找到ICS文件，请确保文件已正确生成。', 404


def main_process():
    app.run(host='0.0.0.0', port=2306, use_reloader=False)

if __name__ == "__main__":
    main_process()
