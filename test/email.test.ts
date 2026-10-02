import { describe, expect, it } from 'vitest';
import { normalizeMessageId, parseRawEmail } from '../src/email';
import { parseEmail } from '../src/parse';
import { htmlToText } from '../src/text';
import { fixture } from './helpers';

/** Build a raw RFC 822 message the way QQ Mail forwards 12306 notices: base64 UTF-8 HTML part. */
function rawMessage(f: { subject: string; html: string }): string {
  const b64 = Buffer.from(f.html, 'utf-8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  const subject = `=?UTF-8?B?${Buffer.from(f.subject, 'utf-8').toString('base64')}?=`;
  return [
    'From: "12306@rails.com.cn" <12306@rails.com.cn>',
    'To: someone@qq.com',
    `Subject: ${subject}`,
    'Date: Thu, 3 Sep 2026 10:04:11 +0800',
    'Message-ID: <abc.123@rails.com.cn>',
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    b64,
    '',
  ].join('\r\n');
}

describe('parseRawEmail', () => {
  it('extracts id, sender, subject and html from a raw message', async () => {
    const f = fixture('purchase-2');
    const payload = await parseRawEmail(rawMessage(f));
    expect(payload.id).toBe('abc.123@rails.com.cn');
    expect(payload.from).toBe('12306@rails.com.cn');
    expect(payload.subject).toBe('网上购票系统-用户支付通知');
    expect(payload.html).toContain('G7507次列车');
    const parsed = parseEmail(payload.subject, htmlToText(payload.html!));
    expect(parsed.kind).toBe('purchase');
    expect(parsed.tickets).toHaveLength(2);
  });

  it('falls back to a random id when Message-ID is missing', async () => {
    const raw = rawMessage(fixture('purchase-2')).replace(/Message-ID:.*\r\n/, '');
    const payload = await parseRawEmail(raw);
    expect(payload.id).toMatch(/^email-[0-9a-f-]{36}$/);
  });
});

describe('normalizeMessageId', () => {
  it('strips brackets and whitespace, rejects garbage', () => {
    expect(normalizeMessageId(' <abc@x.y> ')).toBe('abc@x.y');
    expect(normalizeMessageId('abc@x.y')).toBe('abc@x.y');
    expect(normalizeMessageId('1a06572b68d2aa85')).toBe('1a06572b68d2aa85');
    expect(normalizeMessageId('<a b>')).toBeUndefined();
    expect(normalizeMessageId('')).toBeUndefined();
    expect(normalizeMessageId(undefined)).toBeUndefined();
  });
});
