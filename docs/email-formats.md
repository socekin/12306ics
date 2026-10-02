# 12306 email formats

What 12306 sends, how each email is recognised, and how ticket lines are parsed. Every format below
was checked against a real email unless marked otherwise; anonymised copies live in
[`test/fixtures/`](../test/fixtures).

## Overview

All notification emails come from `12306@rails.com.cn` with the subject `网上购票系统-<type>`. Bodies
are HTML tables; each ticket sits in its own `<div>`, so after `htmlToText` every ticket is one line.
Field order is fixed. Fields are separated by full-width commas (`，`), except that the waitlist notice
uses an ASCII comma between the train and the seat.

| Subject suffix       | Kind                 | Body markers                                    | Ticket lines                           | Fixture |
| -------------------- | -------------------- | ----------------------------------------------- | -------------------------------------- | ------- |
| 用户支付通知         | `purchase`           | `成功购买了N张车票…订单号码E…所购车票信息如下`  | numbered, with ticket type             | `purchase.json`, `purchase-2.json` |
| 候补订单兑现成功通知 | `waitlist_fulfilled` | `成功兑现了N张车票…订单号码E…车票信息如下`      | numbered, no ticket type               | `waitlist-fulfilled.json` |
| 用户改签通知         | `rebook`             | `成功改签车票N张…订单号码E…改签后的车票信息如下` | numbered, new tickets only            | `rebook.json` |
| 用户退票通知         | `refund`             | `成功办理了退票业务，订单号码E…所退车票信息如下` | **no** number prefix, with refund fee | `refund.json` |
| 候补订单退单通知     | `waitlist_cancelled` | `候补订单号码E…退款流水号`                      | none                                   | `waitlist-cancelled.json` |
| 用户变更到站通知     | `rebook`             | assumed like 改签                               | assumed numbered                       | none yet |

Classification uses the subject first ([`parse.ts`](../src/parse.ts) → `SUBJECT_RULES`) and falls
back to specific body phrases. Body matching is deliberately narrow: every 12306 email mentions
退票 in its footer.

## Ticket line grammar

```
[N.]姓名，YYYY年MM月DD日HH:mm开，出发站-到达站，车次次列车，座位，席别[，票种]，票价X元[，检票口Y][，电子客票][，退票费…][，应退票款…]。
```

Examples (anonymised):

```
1.乘客甲，2026年09月05日10:12开，上海虹桥站-宁波站，G7507次列车，10车9D号，二等座，成人票，票价159.0元，检票口9A9B，电子客票。
1.乘客甲，2026年07月18日10:27开，上海虹桥站-宁波站，D3125次列车,14车12A号，一等座，票价223.0元，检票口20A20B。
乘客甲，2026年02月10日23:58开，南昌东站-上海虹桥站，G896次列车，1车2F号，特等座，票价436.0元，退票费87.0元，应退票款349.0元。
```

Parsing rules (`parseTicketLine`):

- The passenger prefix is optional, numbered (`1.`) or bare.
- Station names lose the trailing `站`; the event `LOCATION` adds it back.
- Seat: the first field matching `^\d+车` (covers `10车9D号`, `12车15号下铺`, `5车无座`).
- Seat type: the first field ending in 座, 卧, 铺, or 包.
- Ticket type: 成人票, 儿童票, 学生票, and similar.
- Unknown trailing fields are ignored, so new suffixes do not break parsing.

## Order numbers

`订单号码` is followed by `E` and 9 digits for normal orders, or `E` and 17 digits for waitlist
orders. `extractOrderNo` accepts 8–20 digits. Rebooking and refund notices carry the **original**
order number, which is what makes exact matching possible.

## Scenarios

| Scenario                                | Behaviour                                                                  |
| --------------------------------------- | -------------------------------------------------------------------------- |
| Purchase, one or many passengers        | One event per train ride; tickets listed in the description                |
| Passengers on different trains          | One event per train                                                        |
| Waitlist fulfilled                      | Same as purchase                                                           |
| Rebooking                               | Remove tickets matching order number + passenger, add the new ones         |
| Partial rebooking                       | Only the rebooked passengers move; the original trip keeps the others      |
| Rebooking with no known original        | New ticket added with the note `改签，未匹配到原行程`; warning stored       |
| Rebooking without an order number       | Fallback: same passenger, same route, not yet departed, nearest date       |
| Refund with ticket lines                | Remove those passengers; delete the event when no tickets remain           |
| Refund without ticket lines             | Remove every ticket on that order number                                   |
| Waitlist cancelled                      | No change (no event existed)                                               |
| Unrecognised email or disallowed sender | Ignored; unrecognised emails are kept under `/raw` for 90 days             |
| Same email delivered twice              | Deduplicated by Message-ID; every operation is idempotent anyway           |
| Arrival lookup fails                    | Estimated (+2 h), marked `预估`, refreshed nightly                         |
| Overnight arrival                       | Correct day offset from `arrive_day_diff`                                  |
| CalDAV unavailable                      | Trip saved and flagged; the nightly job retries. Failed deletes are retried too |

## Fixtures

Fixtures are real emails with every personal detail replaced:

- passenger names → `乘客甲`, `乘客乙`, …
- order numbers → `E20000000N` (waitlist orders use a 17-digit placeholder of the same shape)
- any other identifier (ID numbers, phone numbers, email addresses) removed

See [CONTRIBUTING.md](../CONTRIBUTING.md#adding-support-for-a-new-email) for adding a new format.
