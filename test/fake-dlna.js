/*
 * A stand-in UPnP media renderer, which REFUSES the way a real one does.
 *
 * The rule this file exists under: a permissive fake proves nothing about what
 * the caller asks for. Four transport tests once passed through three broken
 * releases because the stand-in for GitHub answered whatever it was asked, and
 * AddMultipleURIsToQueue enqueued nothing at all while every test stayed green
 * because the fake Sonos returned 200 for an action it did not implement.
 *
 * So this one:
 *
 *   - SERVES A REAL DEVICE DESCRIPTION with RELATIVE control URLs, which is
 *     what a real renderer does and what a caller that guesses paths gets
 *     wrong. Nothing here is at the address lib/sonos.js would look in.
 *   - PUBLISHES AN ACTION LIST that can be built with or without
 *     SetNextAVTransportURI, so the capability check is DRIVEN rather than
 *     described. A fake that always had it would prove nothing about the
 *     branch for a device that does not.
 *   - FAULTS ON EVERY SONOS QUEUE ACTION, so a caller that reaches for one is
 *     caught here instead of on somebody's actual speaker.
 *   - FAULTS ON ANYTHING IT DOES NOT IMPLEMENT, for the same reason.
 *
 * `queueActions` makes it answer AddURIToQueue instead, which is how a Sonos
 * pretending to be a MediaRenderer is played back — the case that would list
 * every Sonos room twice.
 */

"use strict";

const http = require("http");

const AVT = "urn:schemas-upnp-org:service:AVTransport:1";
const RC = "urn:schemas-upnp-org:service:RenderingControl:1";

/* What a plain renderer implements. Deliberately NOT a superset of everything
   in AVTransport: half of that specification is optional and the point of
   reading an action list is to find out which half a device has. */
const BASE_ACTIONS = [
  "SetAVTransportURI", "Play", "Pause", "Stop", "Next", "Previous",
  "GetPositionInfo", "GetTransportInfo", "GetMediaInfo"
];

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function tag(xml, name) {
  const m = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, "i")
    .exec(xml || "");
  return m ? m[1] : "";
}

/*
 * @param gapless      does it implement SetNextAVTransportURI?
 * @param seekable     does it implement Seek?
 * @param queueActions Sonos queue actions, for the "a Sonos answered the
 *                     MediaRenderer search" case
 * @param noRendering  omit RenderingControl entirely — a real thing, and the
 *                     reason volume is asked for rather than assumed
 */
function createFakeRenderer({
  port = 49152, host = "127.0.0.1", name = "Fake Renderer",
  uuid = "uuid:11111111-2222-3333-4444-555555555555",
  maker = "Test Audio Ltd", model = "Renderer One",
  gapless = true, seekable = true, queueActions = [], noRendering = false
} = {}) {
  const avtActions = [...BASE_ACTIONS, ...queueActions];
  if (gapless) avtActions.push("SetNextAVTransportURI");
  if (seekable) avtActions.push("Seek");
  const rcActions = ["GetVolume", "SetVolume", "GetMute", "SetMute"];
  /* PER SERVICE, because the refusal has to mean what it says. One flat list
     checked against both control URLs refused every volume call as an action
     the device does not implement — which is a fake being wrong in exactly the
     direction that hides a real bug, and it is why this is worth getting
     right rather than making the guard lenient. */
  const implemented = { "/ctl/avt": avtActions, "/ctl/rc": rcActions };

  const state = {
    calls: [],
    transportState: "STOPPED",
    currentUri: "", currentMeta: "",
    nextUri: "", nextMeta: "",
    relTime: "0:00:00", duration: "0:00:00", track: 0,
    volume: 30, muted: false,
    /* Actions to answer with a UPnP fault, for driving a caller's handling. */
    faults: new Map()
  };

  /* RELATIVE control URLs, under a path nothing would guess. A caller that
     reads the description finds them; one that assumes Sonos' fixed table
     gets a 404, which is the entire point. */
  const DESC = `<?xml version="1.0"?>
<root xmlns="urn:schemas-upnp-org:device-1-0" xmlns:dlna="urn:schemas-dlna-org:device-1-0">
<specVersion><major>1</major><minor>0</minor></specVersion>
<device>
<dlna:X_DLNADOC>DMR-1.50</dlna:X_DLNADOC>
<deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
<friendlyName>${esc(name)}</friendlyName>
<manufacturer>${esc(maker)}</manufacturer>
<modelName>${esc(model)}</modelName>
<UDN>${esc(uuid)}</UDN>
<serviceList>
 <service><serviceType>${AVT}</serviceType>
  <SCPDURL>svc/avt.xml</SCPDURL><controlURL>ctl/avt</controlURL></service>
${noRendering ? "" : ` <service><serviceType>${RC}</serviceType>
  <SCPDURL>svc/rc.xml</SCPDURL><controlURL>ctl/rc</controlURL></service>`}
</serviceList></device></root>`;

  function scpd(names) {
    return `<?xml version="1.0"?><scpd xmlns="urn:schemas-upnp-org:service-1-0">` +
      `<actionList>${names.map(n => `<action><name>${n}</name></action>`).join("")}</actionList>` +
      `</scpd>`;
  }

  const server = http.createServer((req, res) => {
    const url = req.url.split("?")[0];

    if (req.method === "GET") {
      const send = (body) => {
        const raw = Buffer.from(body);
        res.writeHead(200, { "Content-Type": "text/xml", "Content-Length": raw.length });
        res.end(raw);
      };
      if (url === "/description.xml") return send(DESC);
      if (url === "/svc/avt.xml") return send(scpd(avtActions));
      if (url === "/svc/rc.xml") {
        return noRendering ? (res.writeHead(404), res.end()) : send(scpd(rcActions));
      }
      res.writeHead(404); return res.end();
    }

    let body = "";
    req.on("data", c => { body += c; });
    req.on("end", () => {
      const soapAction = (req.headers.soapaction || "").replace(/"/g, "");
      const [service, action] = soapAction.split("#");
      state.calls.push({ action, service, body, path: url });

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

      const injected = state.faults.get(action);
      if (injected) return fault(injected);

      /* A caller that asked for a service this device never advertised has
         gone looking at an address it made up. */
      const here = implemented[url];
      if (!here || (url === "/ctl/rc" && noRendering)) return (res.writeHead(404), res.end());
      if (!here.includes(action)) return fault(401, "Invalid Action");

      const reply = (fields) => {
        const inner = Object.entries(fields)
          .map(([k, v]) => `<${k}>${esc(v)}</${k}>`).join("");
        res.writeHead(200, { "Content-Type": "text/xml" });
        res.end(`<?xml version="1.0"?><s:Envelope ` +
          `xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">` +
          `<s:Body><u:${action}Response xmlns:u="${service}">${inner}` +
          `</u:${action}Response></s:Body></s:Envelope>`);
      };

      switch (action) {
        case "SetAVTransportURI":
          state.currentUri = tag(body, "CurrentURI");
          state.currentMeta = tag(body, "CurrentURIMetaData");
          /* A new current track clears the next slot, which is what a real
             device does and what makes the re-arm worth testing. */
          state.nextUri = ""; state.nextMeta = "";
          state.track = 1;
          return reply({});

        case "SetNextAVTransportURI":
          state.nextUri = tag(body, "NextURI");
          state.nextMeta = tag(body, "NextURIMetaData");
          return reply({});

        case "Play":  state.transportState = "PLAYING"; return reply({});
        case "Pause": state.transportState = "PAUSED_PLAYBACK"; return reply({});
        case "Stop":  state.transportState = "STOPPED"; return reply({});
        case "Next": case "Previous": return reply({});
        case "Seek":  state.relTime = tag(body, "Target"); return reply({});

        case "GetTransportInfo":
          return reply({
            CurrentTransportState: state.transportState,
            CurrentTransportStatus: "OK", CurrentSpeed: "1"
          });

        case "GetPositionInfo":
          return reply({
            Track: state.track, TrackDuration: state.duration,
            TrackMetaData: state.currentMeta, TrackURI: state.currentUri,
            RelTime: state.relTime, AbsTime: state.relTime,
            RelCount: 0, AbsCount: 0
          });

        case "GetMediaInfo":
          return reply({
            NrTracks: state.currentUri ? 1 : 0, MediaDuration: state.duration,
            CurrentURI: state.currentUri, CurrentURIMetaData: state.currentMeta,
            NextURI: state.nextUri, NextURIMetaData: state.nextMeta,
            PlayMedium: "NETWORK", RecordMedium: "NOT_IMPLEMENTED",
            WriteStatus: "NOT_IMPLEMENTED"
          });

        case "GetVolume": return reply({ CurrentVolume: state.volume });
        case "SetVolume": state.volume = Number(tag(body, "DesiredVolume")); return reply({});
        case "GetMute":   return reply({ CurrentMute: state.muted ? 1 : 0 });
        case "SetMute":   state.muted = tag(body, "DesiredMute") === "1"; return reply({});

        /* Sonos queue actions, present only when a test asked for them —
           the "a Sonos answered the MediaRenderer search" case. They are
           accepted so the ACTION LIST is what tells the two apart, which is
           the check that has to work. */
        case "AddURIToQueue":
        case "AddMultipleURIsToQueue":
          return reply({ NewQueueLength: 1 });

        default:
          return fault(401, "Invalid Action");
      }
    });
  });

  return {
    state,
    location: `http://${host}:${port}/description.xml`,
    listen: () => new Promise(resolve => server.listen(port, host, resolve)),
    close:  () => new Promise(resolve => server.close(resolve)),
    actions: () => state.calls.map(c => c.action)
  };
}

module.exports = { createFakeRenderer, BASE_ACTIONS };
