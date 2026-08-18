# Attribution

## Map tiles

Basemap tiles are CARTO's "dark_all" style, built from OpenStreetMap data.

- Map data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors
- Tiles © [CARTO](https://carto.com/attributions)

Both require **visible** attribution on the map. It is rendered in the Leaflet
attribution control in `public/index.html` — do not disable that control.

> CARTO's public basemap endpoint is intended for CARTO users and for modest use.
> If you run this at any scale, point it at a tile source you are licensed for.

## Aircraft positions

ADS-B positions come from [adsb.lol](https://adsb.lol/), a community-run feeder network,
via its public API. No key is used. Their terms of use govern what you may do with the
data — check them before redistributing anything derived from it.

## Airband audio

Audio is demodulated locally from radio the RTL-SDR receives. Nothing is fetched from a
third party. Recording or rebroadcasting aviation voice traffic is regulated differently
depending on where you are; that is on you.

## Receiver location

`HOME_LAT` / `HOME_LON` in `server.js` default to CYXU (London International Airport,
Ontario) rather than any private address, and both are overridable by environment
variable. Set them in a `.env` rather than editing the source, so your own location never
lands in a commit.
