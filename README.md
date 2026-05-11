# Pi Token Rate Extension

Live tok/s display for the Pi coding agent footer with pause detection.

## Features

- **Sliding-window rate calculation** — 3s window for smooth readings
- **Pause detection** — freezes rate during tool-call waits (>2s gap)
- **Persistent display** — never disappears; shows grey when frozen, colored when live
- **Cross-session persistence** — rate survives across message boundaries

## Usage

```bash
cp token-rate.ts ~/.pi/agent/extensions/
```

Then restart Pi or run `pi config extensions reload` to pick it up.

## Display

| State | Appearance |
|---|---|
| Live streaming | `⚡ 150 tok/s` (colored) |
| Paused | `⚡ 150 tok/s` (grey) |
