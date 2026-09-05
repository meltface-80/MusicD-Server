/*
 * A fake Sonos player.
 *
 * Enough of a ZonePlayer to exercise everything this server sends one: the
 * topology, the queue, the transport and the volume. It records every action
 * it receives, so a test can assert on what was actually sent rather than on
 * what a mock was told to expect.
 */

"use strict";

const http = require("http");

function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
                  .replace(/"/g, "&quot;");
}

function envelope(action, service, fields = {}) {
  const body = Object.entries(fields)
    .map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join("");
  return `<?xml version="1.0"?>` +
    `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">` +
    `<s:Body><u:${action}Response xmlns:u="${service}">${body}` +
    `</u:${action}Response></s:Body></s:Envelope>`;
}

function tag(xml, name) {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  if (m) {
    return m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">")
               .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
  }
  return new RegExp(`<${name}/>`).test(xml) ? "" : null;
}

/*
 * `zones` describes the household. Each entry becomes a ZoneGroupMember, and
 * `coordinator` names the group it belongs to — that is how a test sets up a
 * grouped pair without needing a second process.
 */
function createFakeSonos({ port = 1400, host = "127.0.0.1", zones } = {}) {
  const rooms = zones || [
    { uuid: "RINCON_AAA01400", name: "Kitchen", coordinator: "RINCON_AAA01400" },
    { uuid: "RINCON_BBB01400", name: "Study",   coordinator: "RINCON_BBB01400" }
  ];

  const state = {
    calls: [],                 // every action received, in order
    queue: [],                 // { uri, metadata }
    transportState: "STOPPED",
    currentUri: "",
    track: 0,
    relTime: "0:00:00",
    duration: "0:00:00",
    playMode: "NORMAL",
    volume: 25,
    muted: false,
    faults: new Map()          // action -> UPnP error code to return instead
  };

  function zoneGroupState() {
    const groups = new Map();
    for (const z of rooms) {
      if (!groups.has(z.coordinator)) groups.set(z.coordinator, []);
      groups.get(z.coordinator).push(z);
    }
    let xml = "<ZoneGroupState><ZoneGroups>";
    for (const [coordinator, members] of groups) {
      xml += `<ZoneGroup Coordinator="${coordinator}" ID="${coordinator}:1">`;
      for (const m of members) {
        xml += `<ZoneGroupMember UUID="${m.uuid}" ZoneName="${esc(m.name)}" ` +
               `Location="http://${host}:${port}/xml/device_description.xml" ` +
               `Invisible="${m.invisible ? 1 : 0}" IsZoneBridge="${m.bridge ? 1 : 0}" ` +
               `ChannelMapSet="${esc(m.channelMap || "")}"/>`;
      }
      xml += "</ZoneGroup>";
    }
    return xml + "</ZoneGroups></ZoneGroupState>";
  }

  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      const soapAction = (req.headers.soapaction || "").replace(/"/g, "");
      const [service, action] = soapAction.split("#");
      state.calls.push({ action, service, body, path: req.url });

      /* A SOAP fault, in the shape UPnP defines and Sonos actually sends. */
      const fault = (code, text = "") => {
        res.writeHead(500, { "Content-Type": "text/xml" });
        return res.end(
          `<?xml version="1.0"?><s:Envelope ` +
          `xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault>` +
          `<faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring><detail>` +
          `<UPnPError xmlns="urn:schemas-upnp-org:control-1-0">` +
          `<errorCode>${code}</errorCode><errorDescription>${esc(text)}</errorDescription>` +
          `</UPnPError></detail></s:Fault></s:Body></s:Envelope>`);
      };

      /* An error a test asked for, so a caller's handling of one can be
         driven rather than described. */
      const injected = state.faults.get(action);
      if (injected) return fault(injected);

      const reply = (fields) => {
        res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" });
        res.end(envelope(action, service, fields));
      };

      switch (action) {
        case "GetZoneGroupState": return reply({ ZoneGroupState: zoneGroupState() });

        case "RemoveAllTracksFromQueue":
          state.queue = []; state.track = 0; return reply({});

        case "AddURIToQueue": {
          const uri = tag(body, "EnqueuedURI");
          state.queue.push({ uri, metadata: tag(body, "EnqueuedURIMetaData") || "" });
          return reply({ FirstTrackNumberEnqueued: state.queue.length, NewQueueLength: state.queue.length });
        }

        /*
         * Many at once, the way a real player takes them: the URIs space
         * separated, and ONE DIDL-Lite document holding an item per URI in the
         * same order. A caller that sends a document per URI, or whose item
         * count disagrees with its URI count, is refused here — because a real
         * one refuses it too, and a stand-in that shrugged would let that ship.
         */
        case "AddMultipleURIsToQueue": {
          const uris = String(tag(body, "EnqueuedURIs") || "").split(" ").filter(Boolean);
          const meta = tag(body, "EnqueuedURIsMetaData") || "";
          const items = meta.match(/<item\b[\s\S]*?<\/item>/g) || [];
          const said = Number(tag(body, "NumberOfURIs") || 0);
          if (!uris.length || uris.length !== said || items.length !== uris.length) {
            return fault(402, "Invalid Args");
          }
          if ((meta.match(/<DIDL-Lite/g) || []).length !== 1) return fault(402, "Invalid Args");
          uris.forEach((uri, i) => state.queue.push({ uri, metadata: items[i] }));
          return reply({
            FirstTrackNumberEnqueued: state.queue.length - uris.length + 1,
            NumTracksAdded: uris.length, NewQueueLength: state.queue.length
          });
        }

        /* A run of positions, numbered from 1, and everything after it shuffles
           down — which is the whole reason the caller works backwards. */
        case "RemoveTrackRangeFromQueue": {
          const start = Number(tag(body, "StartingIndex") || 0);
          const count = Number(tag(body, "NumberOfTracks") || 0);
          if (start < 1 || count < 1 || start + count - 1 > state.queue.length) {
            return fault(402, "Invalid Args");
          }
          state.queue.splice(start - 1, count);
          if (state.track > state.queue.length) state.track = state.queue.length;
          return reply({ NewUpdateID: 1 });
        }

        case "SetAVTransportURI":
          state.currentUri = tag(body, "CurrentURI") || "";
          return reply({});

        case "SetPlayMode":
          state.playMode = tag(body, "NewPlayMode") || "NORMAL";
          return reply({});

        case "Seek": {
          const unit = tag(body, "Unit");
          if (unit === "TRACK_NR") state.track = Number(tag(body, "Target") || 1);
          else state.relTime = tag(body, "Target") || "0:00:00";
          return reply({});
        }

        case "Play":     state.transportState = "PLAYING"; return reply({});
        case "Pause":    state.transportState = "PAUSED_PLAYBACK"; return reply({});
        case "Stop":     state.transportState = "STOPPED"; return reply({});
        case "Next":     state.track = Math.min(state.queue.length, state.track + 1); return reply({});
        case "Previous": state.track = Math.max(1, state.track - 1); return reply({});

        case "GetTransportInfo":
          return reply({ CurrentTransportState: state.transportState, CurrentTransportStatus: "OK" });

        case "GetTransportSettings":
          return reply({ PlayMode: state.playMode, RecQualityMode: "NOT_IMPLEMENTED" });

        case "GetPositionInfo": {
          const item = state.queue[state.track - 1];
          return reply({
            Track: state.track,
            TrackDuration: state.duration,
            TrackMetaData: item ? item.metadata : "",
            TrackURI: item ? item.uri : state.currentUri,
            RelTime: state.relTime
          });
        }

        case "GetMediaInfo":
          return reply({ NrTracks: state.queue.length, CurrentURI: state.currentUri });

        case "GetVolume": return reply({ CurrentVolume: state.volume });
        case "SetVolume": state.volume = Number(tag(body, "DesiredVolume") || 0); return reply({});
        case "GetMute":   return reply({ CurrentMute: state.muted ? 1 : 0 });
        case "SetMute":   state.muted = tag(body, "DesiredMute") === "1"; return reply({});

        case "BecomeCoordinatorOfStandaloneGroup": return reply({});

        case "Browse": {
          /* StartingIndex and RequestedCount are HONOURED, because a real
             player honours them. A fake that returned the whole queue however
             it was asked would let a caller reading the TAIL of the queue —
             Random Album Radio does exactly that — pass its tests while
             getting something else entirely from a speaker. TotalMatches is
             the whole queue either way, which is what UPnP specifies and what
             makes paging possible. */
          const from = Math.max(0, Number(tag(body, "StartingIndex") || 0));
          const want = Number(tag(body, "RequestedCount") || 0);
          const page = state.queue.slice(from, want > 0 ? from + want : undefined);
          const items = page.map((q, i) =>
            `<item id="Q:0/${from + i + 1}" parentID="Q:0" restricted="true">` +
            `<dc:title>${esc("Track " + (from + i + 1))}</dc:title>` +
            `<dc:creator>Fake</dc:creator>` +
            `<res protocolInfo="http-get:*:audio/flac:*">${esc(q.uri)}</res></item>`).join("");
          const didl = `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" ` +
            `xmlns:dc="http://purl.org/dc/elements/1.1/">${items}</DIDL-Lite>`;
          return reply({
            Result: didl, NumberReturned: page.length,
            TotalMatches: state.queue.length, UpdateID: 1
          });
        }

        /*
         * AN UNKNOWN ACTION IS REFUSED, because a real player refuses it.
         *
         * This used to answer 200 with an empty envelope, so a caller invoking
         * something no speaker implements looked like it had worked — and that
         * is precisely how AddMultipleURIsToQueue was able to enqueue nothing
         * at all while every transport test stayed green. A permissive fake
         * proves nothing about what the caller ASKS FOR.
         */
        default:
          return fault(401, "Invalid Action");
      }
    });
  });

  return {
    state, rooms,
    listen: () => new Promise(resolve => server.listen(port, host, resolve)),
    close:  () => new Promise(resolve => server.close(resolve)),
    /* Put the player in the middle of a track, which is what the play counter
       has to see before it credits anything. */
    playingAt(trackNumber, relTime, duration) {
      state.transportState = "PLAYING";
      state.track = trackNumber;
      state.relTime = relTime;
      state.duration = duration;
    },
    actions: () => state.calls.map(c => c.action)
  };
}

module.exports = { createFakeSonos };
