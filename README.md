# Plane Radio ✈🎧

A tiny web app for an RTL-SDR (Blog V3 / RTL2832U) that lets you **watch nearby
planes on a map** (ADS-B, 1090 MHz) and **listen to ATC/tower voice**
(AM aviation band, 118–137 MHz) from your browser.

> **One dongle, one frequency at a time.** A single RTL-SDR can't decode the
> 1090 MHz map *and* a voice channel simultaneously, so the app runs in one of
> two modes and swaps the underlying SDR process when you toggle. A second
> dongle would let you run both at once.

## Requirements (already installed on this Mac)

- `librtlsdr` → `rtl_fm`, `rtl_test` (`brew install rtl-sdr`)
- `dump1090-fa` (`brew install dump1090-fa`)
- `ffmpeg` (`brew install ffmpeg`)
- Node 18+ (uses only built-in modules — no `npm install`)

## Run

```bash
cd ~/Dev/plane-radio
node server.js          # or: npm start
# open http://localhost:8000
```

1. Plug the RTL-SDR into a USB port (and attach the antenna).
2. Click **🗺 Map** to see aircraft, or **🎧 Listen** to tune a voice channel.
3. **Stop** releases the dongle.

### Verify the dongle is detected

```bash
rtl_test            # should print "Found 1 device(s)" then "Realtek RTL2832U"
# Ctrl-C to quit. Nothing else can be using the dongle while this runs.
```

## Tips

- **Map shows planes but few have positions?** ADS-B is line-of-sight at 1090 MHz
  — get the antenna near a window or outside, higher is better.
- **Listening = static?** That's normal between transmissions. Raise **Squelch**
  (try 30–80) to mute it. Find your local **tower / ground / approach**
  frequencies at [liveatc.net](https://www.liveatc.net) or the airport's AIP.
- **Gain** left blank = auto. Aviation AM often sounds best around 30–45 dB.

## How it works

- **Map mode:** spawns `dump1090 --net`, the server reads the SBS feed on
  `tcp/30003`, maintains an aircraft table, and pushes it to the browser via SSE.
  Rendered with Leaflet.
- **Listen mode:** `rtl_fm -M am` → `ffmpeg` (MP3) → streamed to an `<audio>`
  element over HTTP.
