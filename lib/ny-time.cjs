// New York wall-clock helpers shared by execution policy, Fresh Level Retest and test fixtures.
const TIME_ZONE = 'America/New_York';

const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23'
});

function zonedParts(value) {
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(value))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    minuteOfDay: (Number(parts.hour) * 60) + Number(parts.minute)
  };
}

function timestampForWallClock(date, clock) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = clock.split(':').map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  let candidate = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = zonedParts(candidate);
    const represented = Date.UTC(
      ...parts.date.split('-').map(Number).map((value, index) => index === 1 ? value - 1 : value),
      parts.hour,
      parts.minute
    );
    candidate += desired - represented;
  }
  const verified = zonedParts(candidate);
  if (verified.date !== date || verified.hour !== hour || verified.minute !== minute) {
    throw new Error(`Could not resolve ${date} ${clock} ${TIME_ZONE}`);
  }
  return new Date(candidate).toISOString();
}

module.exports = { TIME_ZONE, zonedParts, timestampForWallClock };
