// When to wake a snoozed tab: turns what you type ("2h", "tomorrow 9am", "fri", "next week") into a date, offers the
// usual choices, and writes a date the way you'd say it. No dependencies; also loads in Node for testing.
(() => {
  const DAYS = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
                 thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 };
  const PARTS = { morning: [8, 0], noon: [12, 0], afternoon: [14, 0], evening: [18, 0], night: [20, 0] };
  const MORNING = { h: 8, m: 0 };

  const at = (date, h, m = 0) => { const d = new Date(date); d.setHours(h, m, 0, 0); return d; };
  const addDays = (date, n) => { const d = new Date(date); d.setDate(d.getDate() + n); return d; };
  // Days until the next time `weekday` comes round; today doesn't count.
  const until = (now, weekday) => ((weekday - now.getDay() + 7) % 7) || 7;

  // "9am", "9:30 pm", "17:30", "evening" -> { h, m }. A bare number is ambiguous, so it isn't a time.
  function parseTime(str) {
    if (PARTS[str]) return { h: PARTS[str][0], m: PARTS[str][1] };
    const m = str.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/);
    if (!m || (!m[2] && !m[3])) return null;
    let h = Number(m[1]);
    const min = Number(m[2] || 0);
    if (m[3]) {
      if (h < 1 || h > 12) return null;
      if (m[3] === 'pm' && h < 12) h += 12;
      if (m[3] === 'am' && h === 12) h = 0;
    }
    return h > 23 || min > 59 ? null : { h, m: min };
  }

  function parseWhen(raw, now = new Date()) {
    const s = String(raw || '').trim().toLowerCase().replace(/^(in|at|until|on|for)\s+/, '').replace(/\s+/g, ' ');
    if (!s) return null;

    const dur = s.match(/^(\d+(?:\.\d+)?)\s*(m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|wks?|weeks?)$/);
    if (dur) {
      const unit = { m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 }[dur[2][0]];
      return new Date(now.getTime() + Number(dur[1]) * unit);
    }

    const time = parseTime(s);
    if (time) { // a time on its own: the next time it's that o'clock
      const d = at(now, time.h, time.m);
      return d > now ? d : addDays(d, 1);
    }

    if (s === 'next week' || s === 'nextweek') return at(addDays(now, until(now, 1)), MORNING.h);
    const [first, ...rest] = s.split(' ');
    const t = rest.length ? parseTime(rest.join(' ')) : null;
    if (rest.length && !t) return null;

    if (first === 'today' || first === 'tonight') {
      const when = t || { h: first === 'tonight' ? 20 : 18, m: 0 };
      const d = at(now, when.h, when.m);
      return d > now ? d : null;
    }
    if (first === 'tomorrow' || first === 'tmrw') { const w = t || MORNING; return at(addDays(now, 1), w.h, w.m); }
    if (first === 'weekend') { const w = t || { h: 9, m: 0 }; return at(addDays(now, until(now, 6)), w.h, w.m); }
    if (first in DAYS) { const w = t || MORNING; return at(addDays(now, until(now, DAYS[first])), w.h, w.m); }
    return null;
  }

  // The usual choices, from now.
  function presets(now = new Date()) {
    const list = [{ label: 'In 1 hour', when: new Date(now.getTime() + 3600e3) }];
    const evening = at(now, 18);
    if (evening.getTime() - now.getTime() > 30 * 60e3) list.push({ label: 'This evening', when: evening });
    list.push({ label: 'Tomorrow morning', when: at(addDays(now, 1), MORNING.h) });
    const weekend = [0, 6].includes(now.getDay()) ? 'Next weekend' : 'This weekend';
    list.push({ label: weekend, when: at(addDays(now, until(now, 6)), 9) });
    list.push({ label: 'Next week', when: at(addDays(now, until(now, 1)), MORNING.h) });
    return list;
  }

  // "Today 6:00 PM", "Tomorrow 8:00 AM", "Fri 8:00 AM", "Fri, 20 Nov, 8:00 AM"
  function fmtWhen(date, now = new Date()) {
    const t = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const day = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    const n = Math.round((day(date) - day(now)) / 864e5);
    if (n === 0) return `Today ${t}`;
    if (n === 1) return `Tomorrow ${t}`;
    if (n > 1 && n < 7) return `${date.toLocaleDateString([], { weekday: 'short' })} ${t}`;
    return `${date.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' })}, ${t}`;
  }

  const api = { parseWhen, presets, fmtWhen };
  if (typeof module !== 'undefined') module.exports = api; else globalThis.SnoozeTimes = api;
})();
