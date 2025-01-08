from playwright.sync_api import sync_playwright
import time
from typing import Dict, Optional, Tuple
import os
from datetime import datetime
import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv

def query_station_time(date_str: str, train_code: str, station_name: str) -> Optional[Tuple[str, str]]:
    """
    查询指定日期、车次和车站的到达和开车时间
    
    :param date_str: 查询日期，示例格式 '2025-01-08'
    :param train_code: 车次号，例如 'G20'
    :param station_name: 车站名称，例如 '南京南'
    :return: 返回一个元组 (到达时间, 开车时间)，如果未找到则返回 None
    """
    html_content = query_train_info(date_str, train_code)
    
    soup = BeautifulSoup(html_content, "html.parser")
    table_body = soup.select_one("#_query_table_datas")
    if not table_body:
        return None
    
    rows = table_body.find_all("tr")
    if not rows:
        return None
    
    for row in rows:
        # 找到车站信息容器
        station_div = row.select_one(".t-station")
        if not station_div:
            continue
            
        # 获取车站名
        station = station_div.get_text(strip=True)
        
        # 获取时间信息
        time_div = row.select_one(".cds")
        if not time_div:
            continue
            
        # 获取发车和到达时间
        depart_time = time_div.select_one(".start-t")
        arrive_time = time_div.select_one("span")
        
        depart_time = depart_time.get_text(strip=True) if depart_time else "----"
        arrive_time = arrive_time.get_text(strip=True) if arrive_time else "----"
        
        if depart_time == "----":
            depart_time = ""
        if arrive_time == "----":
            arrive_time = ""
            
        if station == station_name:
            return arrive_time, depart_time
    
    return None

def query_train_info(date_str: str, train_code: str) -> str:
    """
    使用 Playwright 的无头浏览器在后端访问 12306 列车信息查询页面，输入日期和车次并点击查询，
    最后返回查询结果的 HTML。
    """
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page()
        
        try:
            # 1. 打开 12306 列车信息查询页面
            page.goto("https://kyfw.12306.cn/otn/queryTrainInfo/init", timeout=30000)
            
            # 等待日期输入框出现
            page.wait_for_selector("#train_start_date", timeout=15000)
            
            # 2. 填写日期
            page.fill("#train_start_date", date_str)
            
            # 3. 填写车次并设置 train_no 属性
            page.fill("#numberValue", train_code)
            
            # 等待一下让下拉列表加载
            time.sleep(1)
            
            # 获取下拉列表的第一个 train_no
            js_code = """
            () => {
                const list = document.querySelector('#train_hide');
                if (list) {
                    list.style.display = 'block';
                    const items = list.querySelectorAll('li');
                    if (items.length > 0) {
                        const firstItem = items[0];
                        return firstItem.getAttribute('train_no');
                    }
                }
                return null;
            }
            """
            train_no = page.evaluate(js_code)
            
            if train_no:
                # 设置 train_no 属性
                js_set_code = """
                (train_no) => {
                    const input = document.querySelector('#numberValue');
                    if (input) {
                        input.setAttribute('train_no', train_no);
                        const event = new Event('change', { bubbles: true });
                        input.dispatchEvent(event);
                        return true;
                    }
                    return false;
                }
                """
                result = page.evaluate(js_set_code, train_no)
            
            # 4. 点击查询按钮
            page.click("a.btn122s")
            
            # 5. 等待加载完成
            page.wait_for_load_state("networkidle", timeout=15000)
            time.sleep(3)
            
            # 等待表格内容加载
            page.wait_for_selector("#_query_table_datas tr", timeout=15000)
            
            # 6. 获取页面 HTML
            html_content = page.content()
            
            return html_content
            
        except Exception as e:
            return ""
        finally:
            browser.close()

def query_arrival_time(date_str: str, train_code: str, station_name: str) -> str:
    """
    查询指定车次在指定站点的到达时间
    
    :param date_str: 日期，格式为 'YYYY-MM-DD'
    :param train_code: 车次号，例如 'G7071'
    :param station_name: 站点名称（不含"站"字），例如 '上海'
    :return: 到达时间，如果未找到则返回空字符串
    """
    result = query_station_time(date_str, train_code, station_name)
    if result:
        arrive_time, _ = result
        return arrive_time
    return ""

def save_query_result(date_str: str, train_code: str, station_name: str, result: Optional[Tuple[str, str]]) -> None:
    """保存查询结果到文件"""
    # 创建output目录（如果不存在）
    os.makedirs("output", exist_ok=True)
    
    # 生成文件名
    timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
    filename = f"output/query_result_{timestamp}.txt"
    
    # 保存结果
    with open(filename, "w", encoding="utf-8") as f:
        f.write(f"日期：{date_str}\n")
        f.write(f"车次：{train_code}\n")
        if result:
            arrive_time, depart_time = result
            if arrive_time:
                f.write(f"到达时间：{arrive_time}\n")
            if depart_time:
                f.write(f"开车时间：{depart_time}\n")
        else:
            f.write("未找到车次信息\n")

if __name__ == "__main__":
    # 从环境变量获取邮箱账号密码
    load_dotenv()
    username = os.getenv('EMAIL_USERNAME')
    password = os.getenv('EMAIL_PASSWORD')
    
    if not username or not password:
        print("请在 .env 文件中设置邮箱账号和密码")
        exit(1)
    
    # 从 main.py 导入获取车票信息的函数
    import sys
    import os
    
    # 获取 ics 目录的路径
    current_dir = os.path.dirname(os.path.abspath(__file__))
    ics_dir = os.path.join(current_dir, 'ics')
    sys.path.insert(0, ics_dir)
    
    from main import get_latest_ticket_info
    
    # 获取最新的车票信息
    ticket_info = get_latest_ticket_info(username, password)
    if ticket_info:
        date_str = ticket_info["date"]           # 已经是 YYYY-MM-DD 格式
        train_code = ticket_info["train_number"] # 车次号
        station_name = ticket_info["to_station"] # 到达站（已去掉"站"字）
        
        print(f"\n车票信息：")
        print(f"日期：{date_str}")
        print(f"车次：{train_code}")
        print(f"到达站：{station_name}")
        
        arrival_time = query_arrival_time(date_str, train_code, station_name)
        if arrival_time:
            print(f"到达时间：{arrival_time}")
        else:
            print("未找到车次信息")
    else:
        print("未能获取车票信息")