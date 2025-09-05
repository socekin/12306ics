import os
from dotenv import load_dotenv
from caldav import DAVClient
from ics import Calendar as IcsCalendar

load_dotenv()


def add_event(event):
    """Add an event to a CalDAV calendar."""
    url = os.getenv("CALDAV_URL")
    username = os.getenv("CALDAV_USERNAME")
    password = os.getenv("CALDAV_PASSWORD")
    calendar_name = os.getenv("CALDAV_CALENDAR_NAME")

    if not all([url, username, password]):
        raise ValueError("CalDAV configuration is incomplete")

    client = DAVClient(url, username=username, password=password)
    principal = client.principal()
    calendars = principal.calendars()
    target_cal = calendars[0] if calendars else principal.make_calendar(name=calendar_name or "Calendar")

    if calendar_name:
        for c in calendars:
            if c.name == calendar_name:
                target_cal = c
                break

    cal = IcsCalendar()
    cal.events.add(event)
    target_cal.add_event(cal.serialize())

