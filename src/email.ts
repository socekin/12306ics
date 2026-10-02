import PostalMime from 'postal-mime';
import type { IngestPayload } from './types';

/** Strip angle brackets and whitespace from an RFC 5322 Message-ID. */
export function normalizeMessageId(id: string | null | undefined): string | undefined {
  const m = (id ?? '').trim().match(/^<?([^<>\s]+)>?$/);
  return m ? m[1] : undefined;
}

/**
 * Turn a raw RFC 822 message (as delivered by Cloudflare Email Routing) into the
 * same payload the Apps Script bridge sends, keyed by Message-ID so that the two
 * delivery paths deduplicate against each other.
 */
export async function parseRawEmail(raw: ArrayBuffer | Uint8Array | string): Promise<IngestPayload> {
  const mail = await PostalMime.parse(raw);
  return {
    id: normalizeMessageId(mail.messageId) ?? `email-${crypto.randomUUID()}`,
    from: mail.from?.address ?? '',
    subject: mail.subject ?? '',
    date: mail.date,
    html: mail.html ?? undefined,
    text: mail.text ?? undefined,
  };
}
