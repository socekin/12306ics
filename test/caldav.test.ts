import { describe, expect, it } from 'vitest';
import { parseCalendarList } from '../src/caldav';

// Trimmed from a real iCloud response: default namespaces, single-quoted attributes.
const ICLOUD_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<multistatus xmlns="DAV:">
  <response xmlns="DAV:">
    <href>/123/calendars/</href>
    <propstat><prop>
      <displayname xmlns="DAV:">owner</displayname>
      <resourcetype xmlns="DAV:"><collection/></resourcetype>
      <supported-calendar-component-set xmlns="urn:ietf:params:xml:ns:caldav"><comp name='VEVENT' xmlns='urn:ietf:params:xml:ns:caldav'/></supported-calendar-component-set>
    </prop><status>HTTP/1.1 200 OK</status></propstat>
  </response>
  <response xmlns="DAV:">
    <href>/123/calendars/AAAA/</href>
    <propstat><prop>
      <displayname xmlns="DAV:">工作</displayname>
      <resourcetype xmlns="DAV:"><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype>
      <supported-calendar-component-set xmlns="urn:ietf:params:xml:ns:caldav"><comp name='VEVENT' xmlns='urn:ietf:params:xml:ns:caldav'/></supported-calendar-component-set>
    </prop><status>HTTP/1.1 200 OK</status></propstat>
  </response>
  <response xmlns="DAV:">
    <href>/123/calendars/TASKS/</href>
    <propstat><prop>
      <displayname xmlns="DAV:">提醒事项</displayname>
      <resourcetype xmlns="DAV:"><collection/><calendar xmlns="urn:ietf:params:xml:ns:caldav"/></resourcetype>
      <supported-calendar-component-set xmlns="urn:ietf:params:xml:ns:caldav"><comp name='VTODO' xmlns='urn:ietf:params:xml:ns:caldav'/></supported-calendar-component-set>
    </prop><status>HTTP/1.1 200 OK</status></propstat>
  </response>
  <D:response xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
    <D:href>/123/calendars/BBBB/</D:href>
    <D:propstat><D:prop>
      <D:displayname>12306</D:displayname>
      <D:resourcetype><D:collection/><C:calendar/></D:resourcetype>
      <C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set>
    </D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat>
  </D:response>
</multistatus>`;

describe('parseCalendarList', () => {
  it('returns only VEVENT calendars, resolving hrefs against the home URL', () => {
    const list = parseCalendarList(ICLOUD_XML, 'https://p12-caldav.icloud.com/123/calendars/');
    expect(list).toEqual([
      { name: '工作', url: 'https://p12-caldav.icloud.com/123/calendars/AAAA/' },
      { name: '12306', url: 'https://p12-caldav.icloud.com/123/calendars/BBBB/' },
    ]);
  });
});
