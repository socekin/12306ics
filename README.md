# 12306ics
本项目代码完全由GPT4编写，实现将12306的车票信息邮件自动转成在线日历。

**遇到问题不要提issues，因为作者本人也不会写代码，请自行修改或者发给GPT解决**


## 主要功能
- 从QQ邮箱获取12306的邮件，自动解析车票信息，并生成ics文件
- 每分钟获取一次邮件

## Docker部署说明

1. 确保你的12306绑定的邮箱为QQ邮箱，其他邮箱请自行修改代码
2. 修改`main.py`文件中的`account@qq.com`和`password`为自己的QQ邮箱账号，密码是smtp密码，非登录密码
3. Clone本项目
4. 采用docker进行部署

Build

```
Docker build --no-cache -t ticket-extractor .
```

然后启动Docker

```
docker run -d -p 2306:2306 ticket-extractor
```

订阅ics

```
服务器ip:2306/download_ics
```
