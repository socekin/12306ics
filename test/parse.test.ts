import { describe, expect, it } from 'vitest';
import { classify, emailAddress, extractOrderNo, parseEmail, parseTicketLine } from '../src/parse';
import { htmlToText } from '../src/text';
import { fixture } from './helpers';

const parsed = (name: string) => {
  const f = fixture(name);
  return parseEmail(f.subject, htmlToText(f.html));
};

describe('htmlToText', () => {
  it('keeps each ticket line on its own line and drops inline tags', () => {
    const text = htmlToText(fixture('purchase-2').html);
    const lines = text.split('\n').filter((l) => /^\d\./.test(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^1\.乘客甲，2026年09月05日10:12开，上海虹桥站-宁波站，G7507次列车，10车9D号，二等座，成人票，票价159\.0元，检票口9A9B，电子客票。$/);
    expect(text).toContain('尊敬的 乘客甲先生：');
  });
});

describe('parseEmail on real fixtures', () => {
  it('purchase notice: two passengers on one train', () => {
    const p = parsed('purchase-2');
    expect(p.kind).toBe('purchase');
    expect(p.orderNo).toBe('E200000004');
    expect(p.tickets).toHaveLength(2);
    expect(p.tickets[0]).toEqual({
      passenger: '乘客甲',
      date: '2026-09-05',
      departTime: '10:12',
      from: '上海虹桥',
      to: '宁波',
      train: 'G7507',
      seat: '10车9D号',
      seatType: '二等座',
      ticketType: '成人票',
      price: 159,
      gate: '9A9B',
    });
    expect(p.tickets[1]?.passenger).toBe('乘客乙');
    expect(p.tickets[1]?.seat).toBe('10车9F号');
  });

  it('waitlist fulfilled: ASCII comma between train and seat, no ticket type', () => {
    const p = parsed('waitlist-fulfilled');
    expect(p.kind).toBe('waitlist_fulfilled');
    expect(p.orderNo).toBe('E200000002');
    expect(p.tickets).toHaveLength(2);
    expect(p.tickets[0]).toMatchObject({ train: 'D3125', seat: '14车12A号', seatType: '一等座', price: 223, gate: '20A20B', date: '2026-07-18', departTime: '10:27' });
    expect(p.tickets[0]?.ticketType).toBeUndefined();
  });

  it('rebook notice carries the original order number and only the new tickets', () => {
    const p = parsed('rebook');
    const original = parsed('purchase');
    expect(p.kind).toBe('rebook');
    expect(p.orderNo).toBe(original.orderNo);
    expect(p.tickets.map((t) => t.train)).toEqual(['D3102', 'D3102']);
    expect(original.tickets.map((t) => t.train)).toEqual(['G7516', 'G7516']);
  });

  it('refund notice: bare passenger prefix, refund fee fields ignored', () => {
    const p = parsed('refund');
    expect(p.kind).toBe('refund');
    expect(p.orderNo).toBe('E200000005');
    expect(p.tickets).toHaveLength(1);
    expect(p.tickets[0]).toEqual({
      passenger: '乘客甲',
      date: '2026-02-10',
      departTime: '23:58',
      from: '南昌东',
      to: '上海虹桥',
      train: 'G896',
      seat: '1车2F号',
      seatType: '特等座',
      price: 436,
    });
  });

  it('waitlist cancelled has an order number but no tickets', () => {
    const p = parsed('waitlist-cancelled');
    expect(p.kind).toBe('waitlist_cancelled');
    expect(p.orderNo).toBe('E20000000100000000');
    expect(p.tickets).toHaveLength(0);
  });
});

describe('classify', () => {
  it('uses the subject first', () => {
    expect(classify('网上购票系统-用户退票通知', '')).toBe('refund');
    expect(classify('网上购票系统-用户变更到站通知', '')).toBe('rebook');
    expect(classify('网上购票系统-候补订单退单通知', '')).toBe('waitlist_cancelled');
  });
  it('does not treat the 退票 footer as a refund', () => {
    const text = htmlToText(fixture('purchase-2').html);
    expect(classify('随便', text)).toBe('purchase');
  });
  it('falls back to body markers', () => {
    expect(classify('x', '您已成功办理了退票业务，退票信息如下：')).toBe('refund');
    expect(classify('x', '改签后的车票信息如下:')).toBe('rebook');
    expect(classify('x', '天气不错')).toBe('unknown');
  });
});

describe('parseTicketLine edge cases', () => {
  it('parses sleeper berths and no-seat tickets', () => {
    expect(parseTicketLine('3.乘客丙，2026年10月01日20:05开，北京站-上海站，Z21次列车，12车15号下铺，硬卧，票价306.5元，检票口B3。')).toMatchObject({
      train: 'Z21',
      seat: '12车15号下铺',
      seatType: '硬卧',
      price: 306.5,
    });
    expect(parseTicketLine('1.乘客甲，2026年10月01日08:00开，南昌西站-南丰站，D9883次列车，5车无座，二等座，票价45.0元。')).toMatchObject({
      seat: '5车无座',
      seatType: '二等座',
    });
    expect(parseTicketLine('1.乘客甲，2026年10月01日08:00开，南昌西站-南丰站，D9883次列车，5车无座，二等座，票价45.0元。')?.gate).toBeUndefined();
  });
  it('accepts a line without the passenger prefix', () => {
    const t = parseTicketLine('2026年10月01日08:00开，南昌西站-南丰站，D9883次列车，5车3A号，二等座，票价45.0元。');
    expect(t).toMatchObject({ passenger: '', train: 'D9883', seat: '5车3A号' });
  });
  it('rejects unrelated lines', () => {
    expect(parseTicketLine('（1）订单信息查询有效期限为30日。')).toBeNull();
    expect(parseTicketLine('您于2026年09月03日在中国铁路客户服务中心网站成功购买了2张车票')).toBeNull();
    expect(parseTicketLine('您于2026年02月10日在中国铁路客户服务中心网站(12306.cn)成功办理了退票业务， 订单号码')).toBeNull();
  });
});

describe('helpers', () => {
  it('extracts order numbers across line breaks', () => {
    expect(extractOrderNo('票款共计318.00元，订单号码\nE200000009\n。')).toBe('E200000009');
    expect(extractOrderNo('候补订单号码 E123456789，')).toBe('E123456789');
  });
  it('normalises sender addresses', () => {
    expect(emailAddress('"12306@rails.com.cn" <12306@Rails.com.cn>')).toBe('12306@rails.com.cn');
    expect(emailAddress('  someone@example.com ')).toBe('someone@example.com');
  });
});
