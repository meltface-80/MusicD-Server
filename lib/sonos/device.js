"use strict";
/*
 * device.js — one Sonos player's UPnP services, typed.
 *
 * Ported from sonos.py in the bridges. Sonos does not use the control URLs a
 * stock MediaRenderer would, so they are fixed here rather than read from the
 * description document.
 */
const SOAP = require("./soap");
const DIDL = require("./didl");

const SONOS_PORT = 1400;
const AV_TRANSPORT = "urn:schemas-upnp-org:service:AVTransport:1";
const RENDERING_CONTROL = "urn:schemas-upnp-org:service:RenderingControl:1";
const GROUP_RENDERING_CONTROL = "urn:schemas-upnp-org:service:GroupRenderingControl:1";
const CONTENT_DIRECTORY = "urn:schemas-upnp-org:service:ContentDirectory:1";
const ZONE_GROUP_TOPOLOGY = "urn:schemas-upnp-org:service:ZoneGroupTopology:1";
const DEVICE_PROPERTIES = "urn:schemas-upnp-org:service:DeviceProperties:1";

const CONTROL_PATHS = {
  [AV_TRANSPORT]: "/MediaRenderer/AVTransport/Control",
  [RENDERING_CONTROL]: "/MediaRenderer/RenderingControl/Control",
  [GROUP_RENDERING_CONTROL]: "/MediaRenderer/GroupRenderingControl/Control",
  [CONTENT_DIRECTORY]: "/MediaServer/ContentDirectory/Control",
  [ZONE_GROUP_TOPOLOGY]: "/ZoneGroupTopology/Control",
  [DEVICE_PROPERTIES]: "/DeviceProperties/Control"
};

// Sonos' play modes, as the pair the UI thinks in.
const PLAY_MODES = {
  NORMAL: { shuffle: false, loop: "disabled" },
  REPEAT_ALL: { shuffle: false, loop: "loop" },
  REPEAT_ONE: { shuffle: false, loop: "loop_one" },
  SHUFFLE_NOREPEAT: { shuffle: true, loop: "disabled" },
  SHUFFLE: { shuffle: true, loop: "loop" },
  SHUFFLE_REPEAT_ONE: { shuffle: true, loop: "loop_one" }
};

function playModeFor(shuffle, loop) {
  for (const [mode, v] of Object.entries(PLAY_MODES)) {
    if (v.shuffle === !!shuffle && v.loop === loop) return mode;
  }
  return "NORMAL";
}

class SonosDevice {
  constructor(ip, uid = "", name = "") {
    this.ip = ip;
    this.uid = uid;
    this.name = name;
  }

  get baseUrl() { return `http://${this.ip}:${SONOS_PORT}`; }

  call(service, action, args = {}, timeoutMs) {
    return SOAP.call(this.baseUrl + CONTROL_PATHS[service], service, action, args, timeoutMs);
  }

  avt(action, args = {}) { return this.call(AV_TRANSPORT, action, Object.assign({ InstanceID: 0 }, args)); }
  rc(action, args = {}) { return this.call(RENDERING_CONTROL, action, Object.assign({ InstanceID: 0 }, args)); }

  // -- transport --
  play() { return this.avt("Play", { Speed: 1 }); }
  pause() { return this.avt("Pause"); }
  stop() { return this.avt("Stop"); }
  next() { return this.avt("Next"); }
  previous() { return this.avt("Previous"); }
  seek(unit, target) { return this.avt("Seek", { Unit: unit, Target: target }); }
  seekTrack(n) { return this.seek("TRACK_NR", String(n)); }
  seekTime(seconds) { return this.seek("REL_TIME", DIDL.hms(seconds)); }
  setAVTransportURI(uri, meta = "") { return this.avt("SetAVTransportURI", { CurrentURI: uri, CurrentURIMetaData: meta }); }
  setPlayMode(mode) { return this.avt("SetPlayMode", { NewPlayMode: mode }); }
  getTransportInfo() { return this.avt("GetTransportInfo"); }
  getPositionInfo() { return this.avt("GetPositionInfo"); }
  getMediaInfo() { return this.avt("GetMediaInfo"); }
  getTransportSettings() { return this.avt("GetTransportSettings"); }
  becomeStandalone() { return this.avt("BecomeCoordinatorOfStandaloneGroup"); }
  joinGroup(coordinatorUid) { return this.setAVTransportURI(`x-rincon:${coordinatorUid}`); }

  // -- queue --
  queueUri() { return `x-rincon-queue:${this.uid}#0`; }
  clearQueue() { return this.avt("RemoveAllTracksFromQueue"); }
  addToQueue(uri, meta = "", position = 0, asNext = false) {
    return this.avt("AddURIToQueue", {
      EnqueuedURI: uri,
      EnqueuedURIMetaData: meta,
      DesiredFirstTrackNumberEnqueued: position,
      EnqueueAsNext: asNext ? 1 : 0
    });
  }
  /*
   * Up to 16 items in one round trip. The URIs and metadata documents are
   * space-separated, which is how Sonos' own controllers (and SoCo) send them;
   * the URIs never contain a space because the server percent-encodes them.
   */
  addMultipleToQueue(items, position = 0, asNext = false) {
    return this.avt("AddMultipleURIsToQueue", {
      UpdateID: 0,
      NumberOfURIs: items.length,
      EnqueuedURIs: items.map(i => i.uri).join(" "),
      EnqueuedURIsMetaData: items.map(i => i.meta).join(" "),
      ContainerURI: "",
      ContainerMetaData: "",
      DesiredFirstTrackNumberEnqueued: position,
      EnqueueAsNext: asNext ? 1 : 0
    });
  }
  removeTrackFromQueue(trackNumber) {
    return this.avt("RemoveTrackFromQueue", { ObjectID: `Q:0/${trackNumber}`, UpdateID: 0 });
  }
  reorderQueue(start, count, insertBefore) {
    return this.avt("ReorderTracksInQueue", {
      StartingIndex: start, NumberOfTracks: count, InsertBefore: insertBefore, UpdateID: 0
    });
  }
  async browseQueue(start = 0, count = 1000) {
    const r = await this.call(CONTENT_DIRECTORY, "Browse", {
      ObjectID: "Q:0",
      BrowseFlag: "BrowseDirectChildren",
      Filter: "dc:title,res,dc:creator,upnp:artist,upnp:album,upnp:albumArtURI",
      StartingIndex: start,
      RequestedCount: count,
      SortCriteria: ""
    });
    return {
      items: DIDL.parseItems(r.Result || ""),
      total: Number(r.TotalMatches) || 0,
      updateId: Number(r.UpdateID) || 0
    };
  }

  // -- rendering --
  async getVolume() {
    const r = await this.rc("GetVolume", { Channel: "Master" });
    return Number(r.CurrentVolume) || 0;
  }
  setVolume(v) {
    return this.rc("SetVolume", { Channel: "Master", DesiredVolume: Math.max(0, Math.min(100, Math.round(v))) });
  }
  setRelativeVolume(delta) {
    return this.rc("SetRelativeVolume", { Channel: "Master", Adjustment: Math.round(delta) });
  }
  async getMute() {
    const r = await this.rc("GetMute", { Channel: "Master" });
    return r.CurrentMute === "1" || r.CurrentMute === "true";
  }
  setMute(m) { return this.rc("SetMute", { Channel: "Master", DesiredMute: m ? 1 : 0 }); }

  // -- informational --
  async getZoneGroupState() {
    const r = await this.call(ZONE_GROUP_TOPOLOGY, "GetZoneGroupState");
    return r.ZoneGroupState || "";
  }
}

module.exports = {
  SonosDevice, SONOS_PORT, PLAY_MODES, playModeFor,
  AV_TRANSPORT, RENDERING_CONTROL, CONTENT_DIRECTORY, ZONE_GROUP_TOPOLOGY
};
