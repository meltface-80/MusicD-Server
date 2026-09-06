/*
 * MusicD Server — the rooms, whoever they belong to.
 *
 * Two kinds of player answer to this server now: Sonos, which knows about
 * groups and holds its own queue, and stock UPnP renderers, which do neither.
 * Everything above this line — index.js, lib/playback.js — asks about ROOMS
 * and should not have to know which sort a room is.
 *
 * WHY A REGISTRY RATHER THAN A BASE CLASS. The two households are genuinely
 * different objects: one reads a topology and has coordinators, the other is a
 * flat list where every device is its own coordinator and always will be.
 * Making them share an ancestor would mean inventing a shape neither wants.
 * Routing by id is the whole of what callers actually need.
 *
 * DISCOVERED IS NOT ENABLED, and that is the one policy decision in here. An
 * SSDP search answers for every renderer on the network — the television
 * included — so a device that turns up is LISTED, not switched on. The user
 * picks. Deliberately the opposite default from `ROWS_OFF_KEY` in
 * lib/settings.js: a home row added by an update should appear, and a device
 * that appeared on the network should not silently join the speakers.
 *
 * Sonos rooms are exempt: they are found through a household somebody
 * deliberately owns, they were already rooms before this file existed, and
 * arriving switched off would be a feature that broke on upgrade.
 *
 * Copyright (c) 2026 Music Duck. MIT licensed.
 */

"use strict";

const ENABLED_KEY = "zone.enabled";

/* The same shape check lib/radio.js applies, and for the same reason: an id
   arrives over the wire and becomes part of a settings key. */
const ZONE_ID = /^[A-Za-z0-9_.:-]{1,64}$/;

function enabledKey(zoneId) {
  if (!ZONE_ID.test(String(zoneId || ""))) throw new Error("Not a room id: " + zoneId);
  return `${ENABLED_KEY}.${zoneId}`;
}

const SONOS = "sonos";
const UPNP = "upnp";

class Zones {
  constructor({ sonos, renderers, settings }) {
    this.sonos = sonos;
    this.renderers = renderers;
    this.settings = settings;
  }

  /* ---------------------------------------------------------------- */
  /*  Which rooms exist                                                */
  /* ---------------------------------------------------------------- */

  async refresh(opts = {}) {
    /* Both, and neither is allowed to cost the other: a discovery sweep that
       times out must not stop the Sonos rooms being listed, which is what an
       awaited pair in sequence would do the first time a television stopped
       answering. */
    const [, upnpErr] = await Promise.all([
      this.sonos.refresh(opts).catch(() => {
        /* Its own lastError already says why; the rooms it knew about stand. */
      }),
      this.renderers.refresh(opts).catch(e => e)
    ]);
    if (upnpErr) this.renderers.lastError = upnpErr.message;
    return this.rooms();
  }

  /*
   * EVERY ROOM SOMEBODY COULD PLAY TO — which is not every room discovered.
   *
   * This is what the room picker, the poll loop and the play endpoints all
   * see, so a device switched off here is a device that cannot be played to by
   * accident from anywhere.
   */
  rooms() {
    return [
      ...this.sonos.rooms().map(z => this.describe(z, SONOS)),
      ...this.renderers.rooms().filter(d => this.isEnabled(d.uuid))
                               .map(d => this.describe(d, UPNP))
    ];
  }

  /*
   * EVERYTHING DISCOVERED, switched on or not — for Settings › Zones, which is
   * the screen where the switching happens and therefore the one screen that
   * has to see what is switched off.
   */
  all() {
    return [
      ...this.sonos.rooms().map(z => this.describe(z, SONOS)),
      ...this.renderers.rooms().map(d => this.describe(d, UPNP))
    ];
  }

  /* One room, in the shape every caller above expects, whichever kind it is. */
  describe(room, kind) {
    const sonos = kind === SONOS;
    const members = sonos ? this.sonos.membersOf(room.uuid) : [room];
    return {
      uuid: room.uuid,
      name: room.name,
      kind,
      /* A Sonos room is a room because the household says so. A discovered
         renderer is one only once somebody said yes. */
      enabled: sonos ? true : this.isEnabled(room.uuid),
      /* Sonos rooms cannot be switched off — they were rooms before this
         setting existed, and a feature that broke on upgrade is not a
         feature. The screen uses this to know what to draw. */
      switchable: !sonos,
      coordinator: sonos ? room.coordinator : room.uuid,
      isCoordinator: sonos ? room.coordinator === room.uuid : true,
      grouped: members.length > 1,
      members: members.map(m => m.name),
      /* Only a stock renderer has anything to say here: what a Sonos can do is
         not in doubt and never varies. */
      maker: sonos ? "" : room.maker,
      model: sonos ? "" : room.model,
      can: sonos ? null : room.can
    };
  }

  get lastError() {
    /* The Sonos one first: a house with Sonos in it and no renderers is the
       ordinary case, and "no renderers answered" is not an error to report. */
    return this.sonos.lastError || "";
  }

  /* ---------------------------------------------------------------- */
  /*  Talking to one                                                   */
  /* ---------------------------------------------------------------- */

  /*
   * WHICH HOUSEHOLD OWNS THIS ID.
   *
   * By asking, never by looking at the shape of the id. A RINCON_ and a uuid:
   * do not collide today and the code does not lean on that: the day a device
   * ships an id in the other's shape, a rule that guessed would send its
   * commands to the wrong household, and this cannot.
   */
  ownerOf(uuid) {
    if (this.sonos.get(uuid)) return this.sonos;
    if (this.renderers.get(uuid) && this.isEnabled(uuid)) return this.renderers;
    return null;
  }

  get(uuid) {
    const owner = this.ownerOf(uuid);
    return owner ? owner.get(uuid) : null;
  }

  coordinatorFor(uuid) {
    const owner = this.ownerOf(uuid);
    return owner ? owner.coordinatorFor(uuid) : null;
  }

  membersOf(uuid) {
    const owner = this.ownerOf(uuid);
    return owner ? owner.membersOf(uuid) : [];
  }

  /* lib/playback.js reads `zones` to find a room's name for Now playing. Kept
     as a property rather than a method because that is the shape it already
     asks for, and renaming a reader is a change with no benefit in it. */
  get zones() { return this.rooms(); }

  /* ---------------------------------------------------------------- */
  /*  Switching one on                                                 */
  /* ---------------------------------------------------------------- */

  isEnabled(uuid) {
    /* ABSENT MEANS OFF. The one place that policy is written down. */
    return this.settings.get(enabledKey(uuid)) === "1";
  }

  setEnabled(uuid, on) {
    /* A Sonos room has no switch, so refusing here is not pedantry: it is what
       stops a stored "0" for a Sonos uuid ever being written, and therefore
       ever being read by a later version that forgot why. */
    if (this.sonos.get(uuid)) throw new Error("A Sonos room is always available.");
    if (!this.renderers.get(uuid)) throw new Error("No such device on the network.");
    this.settings.set(enabledKey(uuid), on ? "1" : "0");
    return this.isEnabled(uuid);
  }
}

module.exports = { Zones, ENABLED_KEY, SONOS, UPNP };
