"""Requests and occupied worker time for registered projects, in equal time buckets."""

BUCKETS = 24
PERIODS = (6, 24)


def summarize(hours, end, projects, jobs):
    width = hours * 3600 // BUCKETS
    start = end - width * BUCKETS
    series = {
        name: dict(name=name, color=color, requests=[0] * BUCKETS, seconds=[0.0] * BUCKETS)
        for name, color in projects
    }
    for name, created, started, finished, state in jobs:
        row = series.get(name)
        if row is None:
            continue
        if start <= created < end:
            row["requests"][int((created - start) // width)] += 1
        if started is None or (finished is None and state != "running"):
            continue
        left = max(start, started)
        right = min(end, end if finished is None else finished)
        while left < right:
            i = int((left - start) // width)
            boundary = min(right, start + (i + 1) * width)
            row["seconds"][i] += boundary - left
            left = boundary
    for row in series.values():
        row["seconds"] = [round(value, 3) for value in row["seconds"]]
    return dict(start=start, end=end, bucket_seconds=width, projects=list(series.values()))


def from_database(connection, hours, end):
    start = end - hours * 3600
    # Include a run that started before the window, and a queue entry that never ran.
    # The dashboard's short list of recent results cannot answer either question reliably.
    projects = connection.execute("""
        SELECT name, rowid - 1 FROM projects
        WHERE coalesce(json_extract(config, '$.enabled'), 1) = 1 ORDER BY rowid
    """)
    jobs = connection.execute("""
        SELECT json_extract(meta, '$.project'), created, started, finished, state
        FROM jobs WHERE id IN (
            SELECT id FROM jobs WHERE created >= ? AND created < ?
            UNION SELECT id FROM jobs WHERE finished > ? AND started < ?
            UNION SELECT id FROM jobs WHERE state = 'running' AND started < ?
        )
    """, (start, end, start, end, end))
    return summarize(hours, end, projects, jobs)
