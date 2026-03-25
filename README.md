# VTranser Dashboard

Web dashboard for daily metrics stored in a plain text file.

## Files

- `index.html`: Dashboard UI layout.
- `styles.css`: Visual design, responsive behavior, animations.
- `config.js`: Dashboard defaults and text file path.
- `daily_metrics.txt`: Daily metrics data source.
- `dd.js`: Text parsing, aggregation, charts, and KPI rendering.

## Run

Serve this folder as static files. Example:

```powershell
cd d:\V_Transer_Official\dashboard_vtranser
python -m http.server 8081
```

Then open `http://localhost:8081`.

## Data File Format

`daily_metrics.txt` is loaded directly by the browser, including when opening `index.html` with `file://`.
Keep the first line and the last closing backtick line as-is. The daily data stays as plain line-based text inside that block.

Skeleton:

```text
window.VT_DAILY_METRICS_TEXT = String.raw`# comments...
2026-03-12 | 38 | 9 | 210 | 136 | 47
2026-03-13 | 15 | 11 | 220 | 141 | 44
`;
```

Each non-empty data line in `daily_metrics.txt` is one day:

```text
YYYY-MM-DD | new_users | daily_active_users | local_users | online_users | avg_usage_minutes
```

Example:

```text
2026-03-12 | 38 | 9 | 210 | 136 | 47
2026-03-13 | 15 | 11 | 220 | 141 | 44
```

Rules:

- Lines starting with `#` are ignored.
- Values must be non-negative integers.
- `total_users` is no longer entered manually. The dashboard derives it automatically as the cumulative sum of `new_users`.
- Add one new data line before the final closing backtick line for each new day.
- By default the timeline starts from the first date in the file. Set `DISPLAY_START_DATE` in `config.js` only if you want to show earlier zero-value days.
- The dashboard auto-refreshes every 2 seconds and also refreshes when the browser/tab becomes active again.

## Main Features

- Line chart for `Number of Registrations by Day`.
- Donut chart for `Current User Snapshot`.
- Donut chart for `Login Status by Type`.
- Bar chart for `Daily Active Users by Day`.
- Line chart for `Average Usage Time by Day`.
- Summary cards and cumulative stats built only from `daily_metrics.txt`.
