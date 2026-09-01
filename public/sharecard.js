/*
 * sharecard.js — render an album share card as a PNG, in the browser.
 *
 * Copyright (c) 2026 Music Duck. MIT licensed.
 *
 * Layout (1200 × 600, fixed):
 *
 *   +--------------------------------------------------------+
 *   |  the cover again, blown up and softened, as the ground  |
 *   |    +------------------------------------------------+  |
 *   |    | +--------+   16TH SEPTEMBER 1988                |  |
 *   |    | | cover  |   Spirit of Eden                    |  |
 *   |    | | 424px  |   by Talk Talk                      |  |
 *   |    | +--------+                       [ MusicD ]    |  |
 *   |    +------------------------------------------------+  |
 *   +--------------------------------------------------------+
 *
 * Everything on the card comes from the album row this server already has.
 * There is no lookup, no review and no label — the same rule the rest of the
 * app follows, and the reason the card can be drawn while offline.
 *
 * THE SOFTENING IS A DOWNSCALE, NOT A BLUR. `ctx.filter = 'blur()'` is not
 * dependable across the browsers this runs in, so the ground is the cover
 * drawn into a 24px offscreen canvas and scaled back up — bilinear
 * interpolation does the work, and it costs one tiny draw.
 *
 * The card stays dark in both themes. It is a standalone image that will be
 * seen outside the app, on backgrounds nobody here controls, and its colours
 * are built for a dark ground.
 */

const ShareCard = (() => {
  "use strict";

  const CARD_W = 1200;
  const CARD_H = 600;
  const INSET = 48;                       // card edge to the glass pane
  const PANE_X = INSET, PANE_Y = INSET;
  const PANE_W = CARD_W - INSET * 2;
  const PANE_H = CARD_H - INSET * 2;
  const PANE_R = 28;
  const PANE_PAD = 40;                    // pane edge to its contents
  const ART = 424;                        // the sharp cover inside the pane
  const ART_R = 18;
  const ART_X = PANE_X + PANE_PAD;
  const ART_Y = PANE_Y + Math.round((PANE_H - ART) / 2);
  const DIVIDER = 44;                     // cover to the text column
  const TEXT_X = ART_X + ART + DIVIDER;
  const TEXT_W = PANE_X + PANE_W - 44 - TEXT_X;

  const GROUND = "#12151a";
  const PANE_FILL = "rgba(18,21,26,.5)";
  const PANE_EDGE = "rgba(255,255,255,.14)";
  const FONT = '"Helvetica Neue", Helvetica, Arial, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

  /* Type sizes and spacing are MusicD Remote's, so a card from either app is
     recognisably the same object. Title and artist step DOWN through their
     lists until the text fits rather than being ellipsed at one size — a long
     album name gets smaller before it gets cut. */
  /* The date line. Bigger than it was, and never bigger than the artist line
     under it — which steps down for a long name, so the cap is applied at the
     size actually chosen rather than once here. */
  const DATE_SIZE = 30;
  const DATE_GAP = 24;
  const TITLE_SIZES = [56, 48, 42, 36, 31, 27];
  const TITLE_LH = 68 / 56;
  const ARTIST_SIZES = [37, 32, 28, 24, 21];
  const ARTIST_LH = 48 / 37;
  const BLOCK_GAP = 18;

  const WORDMARK_URL = "/icons/wordmark.svg";
  const WORDMARK_W = 161;                 // the mark carries the waveform too
  const WORDMARK_PAD = 34;

  const MONTHS = ["January", "February", "March", "April", "May", "June",
                 "July", "August", "September", "October", "November", "December"];

  /* 1st, 2nd, 3rd, 4th — and 11th, 12th, 13th, which are the ones a naive
     rule gets wrong. */
  function ordinal(day) {
    const teen = day % 100;
    if (teen >= 11 && teen <= 13) return day + "th";
    return day + (["th", "st", "nd", "rd"][day % 10] || "th");
  }

  /*
   * What the card says about when the album came out.
   *
   * A full date is worth saying in full — "23rd September 2025" reads like a
   * record sleeve. Anything less precise is not a date, and pretending it is
   * would mean inventing a day; those get the year, with the word in front so
   * a bare number is never left to be read as part of the title.
   */
  function releaseLine(releaseDate, year) {
    const iso = String(releaseDate || "");
    const full = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (full) {
      const [, y, m, d] = full;
      return `${ordinal(Number(d))} ${MONTHS[Number(m) - 1]} ${y}`;
    }
    const known = year || (/^(\d{4})/.exec(iso) || [])[1];
    return known ? "Released " + known : "";
  }

  /* roundRect() is still missing in enough shipping browsers to be worth not
     depending on. */
  function roundRectPath(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function loadImage(src) {
    return new Promise((resolve, reject) => {
      if (!src) return reject(new Error("no image"));
      const img = new Image();
      /* Same origin in normal use, but the canvas is read back with toBlob and
         a tainted one throws — so ask for CORS and let the catch handle a
         refusal by drawing the card without that piece. */
      img.crossOrigin = "anonymous";
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("image failed to load"));
      img.src = src;
    });
  }

  /* Break `text` into at most `maxLines` lines that fit `maxWidth`, ellipsing
     the last one if it runs out. Measured against the canvas, so it is the
     real font being wrapped rather than an estimate of it. */
  function wrap(ctx, text, maxWidth, maxLines) {
    const words = String(text || "").split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    const lines = [];
    let line = "";
    for (const word of words) {
      const candidate = line ? line + " " + word : word;
      if (ctx.measureText(candidate).width <= maxWidth || !line) {
        line = candidate;
      } else {
        lines.push(line);
        line = word;
        if (lines.length === maxLines) break;
      }
    }
    if (lines.length < maxLines && line) lines.push(line);

    if (lines.length === maxLines) {
      /* Anything left over is dropped, so the final line has to admit it. */
      let last = lines[maxLines - 1];
      if (lines.join(" ").length < String(text || "").trim().length) {
        while (last && ctx.measureText(last + "…").width > maxWidth) {
          last = last.replace(/\s*\S$/, "");
        }
        lines[maxLines - 1] = last + "…";
      }
    }
    return lines;
  }

  /* Step down through the sizes until the text fits the space it has. A
     two-word album name at 56px reads better than four lines of it at 42px,
     and only when the smallest size still overflows is the last line cut. */
  function fitText(ctx, text, maxWidth, maxLines, weight, sizes, lhRatio) {
    let lines = [];
    let size = sizes[sizes.length - 1];
    for (const candidate of sizes) {
      size = candidate;
      ctx.font = `${weight} ${candidate}px ${FONT}`;
      lines = wrap(ctx, text, maxWidth, maxLines);
      if (!lines.some(line => line.endsWith("…"))) break;
    }
    ctx.font = `${weight} ${size}px ${FONT}`;
    return { lines, size, lh: Math.round(size * lhRatio) };
  }

  /* The date is one line and is never wrapped or cut: it steps down until it
     fits the column, and stops at a floor rather than shrinking away. */
  function fitDate(ctx, text, cap) {
    for (let size = cap; size >= 18; size -= 2) {
      ctx.font = `600 ${size}px ${FONT}`;
      if (ctx.measureText(text.toUpperCase()).width <= TEXT_W) return size;
    }
    return 18;
  }

  function drawCover(ctx, img, dx, dy, dw, dh) {
    const ir = img.width / img.height;
    const dr = dw / dh;
    let sx, sy, sw, sh;
    if (ir > dr) { sh = img.height; sw = sh * dr; sx = (img.width - sw) / 2; sy = 0; }
    else { sw = img.width; sh = sw / dr; sx = 0; sy = (img.height - sh) / 2; }
    ctx.drawImage(img, sx, sy, sw, sh, dx, dy, dw, dh);
  }

  function drawSoftened(ctx, img, w, h) {
    const SMALL = 24;
    const off = document.createElement("canvas");
    off.width = SMALL;
    off.height = Math.max(1, Math.round(SMALL * (h / w)));
    drawCover(off.getContext("2d"), img, 0, 0, off.width, off.height);
    const prev = ctx.imageSmoothingEnabled;
    ctx.imageSmoothingEnabled = true;
    /* Bleed past every edge: the outermost pixels of an upscale are the least
       smoothed, and they are the ones that would sit on the border. */
    const over = Math.round(w * 0.06);
    ctx.drawImage(off, -over, -over, w + over * 2, h + over * 2);
    ctx.imageSmoothingEnabled = prev;
  }

  /* The wordmark is the real mark — the same shapes as the artwork, traced,
     on a transparent ground so it sits on whatever is behind it. Loaded rather
     than typed out, because a typeface approximation of a logo is not the
     logo. A card without it is still a usable card, so a mark that will not
     load is not a failure. */
  function drawWordmark(ctx, mark, right, bottom) {
    if (!mark) return;
    const h = Math.round(WORDMARK_W * (mark.height / mark.width));
    ctx.globalAlpha = 0.9;
    ctx.drawImage(mark, right - WORDMARK_W, bottom - h, WORDMARK_W, h);
    ctx.globalAlpha = 1;
  }

  async function render(data) {
    const [cover, mark] = await Promise.all([
      loadImage(data.coverUrl).catch(() => null),
      loadImage(data.wordmarkUrl || WORDMARK_URL).catch(() => null)
    ]);

    const canvas = document.createElement("canvas");
    canvas.width = CARD_W;
    canvas.height = CARD_H;
    const ctx = canvas.getContext("2d");
    ctx.textBaseline = "top";
    ctx.textAlign = "left";

    /* --- Ground: the cover again, softened, filling the card --- */
    ctx.fillStyle = GROUND;
    ctx.fillRect(0, 0, CARD_W, CARD_H);
    if (cover) {
      drawSoftened(ctx, cover, CARD_W, CARD_H);
      /* Two scrims, doing different jobs. The flat one sets the floor for how
         light the ground can get — a white sleeve would otherwise leave the
         pane sitting on near-white. The gradient darkens the bottom, where the
         wordmark sits. */
      ctx.fillStyle = "rgba(12,14,18,.44)";
      ctx.fillRect(0, 0, CARD_W, CARD_H);
      const vign = ctx.createLinearGradient(0, CARD_H * 0.45, 0, CARD_H);
      vign.addColorStop(0, "rgba(8,10,13,0)");
      vign.addColorStop(1, "rgba(8,10,13,.55)");
      ctx.fillStyle = vign;
      ctx.fillRect(0, 0, CARD_W, CARD_H);
    }

    /* --- The pane --- */
    ctx.save();
    roundRectPath(ctx, PANE_X, PANE_Y, PANE_W, PANE_H, PANE_R);
    ctx.fillStyle = PANE_FILL;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = PANE_EDGE;
    ctx.stroke();
    ctx.restore();

    /* --- The sharp cover, inside the pane --- */
    ctx.save();
    roundRectPath(ctx, ART_X, ART_Y, ART, ART, ART_R);
    ctx.clip();
    if (cover) {
      drawCover(ctx, cover, ART_X, ART_Y, ART, ART);
    } else {
      ctx.fillStyle = "rgba(255,255,255,.06)";
      ctx.fillRect(ART_X, ART_Y, ART, ART);
    }
    ctx.restore();
    /* A hairline round the cover, so a sleeve that is white to its edge does
       not bleed into the pane. */
    ctx.save();
    roundRectPath(ctx, ART_X + 0.5, ART_Y + 0.5, ART - 1, ART - 1, ART_R);
    ctx.lineWidth = 1;
    ctx.strokeStyle = "rgba(255,255,255,.12)";
    ctx.stroke();
    ctx.restore();

    /* --- The text column --- */
    const dateText = releaseLine(data.releaseDate, data.year);
    const artistText = data.artist ? "by " + data.artist : "";

    /* The wordmark sits at the bottom of this same column, so the text has to
       know it is there. Reserving its band and then choosing type that fits
       what remains is what stops a long title running straight through it —
       fitting on WIDTH alone was enough while the mark was small, and is not
       now that it is the real one. */
    const markH = mark ? Math.round(WORDMARK_W * (mark.height / mark.width)) : 0;
    const availTop = PANE_Y + PANE_PAD;
    const availH = PANE_H - PANE_PAD * 2 - (markH ? markH + 16 : 0);

    /* Step title and artist DOWN TOGETHER, so their relative scale holds, until
       the block fits the height it has. The smallest pair is used if even that
       overflows — at which point wrap() has already ellipsed the last line. */
    let title = null, artist = null, dateSize = 0, dateH = 0, blockH = 0;
    for (let step = 0; step < TITLE_SIZES.length; step++) {
      title = fitText(ctx, data.title || "", TEXT_W, 4, 700, [TITLE_SIZES[step]], TITLE_LH);
      artist = fitText(ctx, artistText, TEXT_W, 4, 400,
                       [ARTIST_SIZES[Math.min(step, ARTIST_SIZES.length - 1)]], ARTIST_LH);
      /* Never larger than the artist line beneath it — a long artist name
         steps that line down, and the date following it down is what keeps
         the two reading as a heading and its subject rather than the other
         way round. A long date ("23rd September 2025") is stepped down again
         if it will not fit the column. */
      dateSize = dateText ? fitDate(ctx, dateText, Math.min(DATE_SIZE, artist.size)) : 0;
      dateH = dateSize ? dateSize + 4 : 0;
      blockH = (dateH ? dateH + DATE_GAP : 0) +
               title.lines.length * title.lh +
               (artist.lines.length ? BLOCK_GAP + artist.lines.length * artist.lh : 0);
      if (blockH <= availH) break;
    }
    const titleH = title.lines.length * title.lh;
    const artistH = artist.lines.length * artist.lh;

    /* Centred in what is left, with a slight upward nudge — the optical centre
       sits a little above the mathematical one. */
    let y = availTop + Math.max(0, Math.round((availH - blockH) / 2) - 6);

    if (dateH) {
      ctx.font = `600 ${dateSize}px ${FONT}`;
      /* Solved against the worst case the pane can present: a white sleeve
         under the scrim and the pane, which flattens to about rgb(83,85,88).
         A dimmer grey fails even the large-text contrast floor there. */
      ctx.fillStyle = "#c2cad3";
      ctx.fillText(dateText.toUpperCase(), TEXT_X, y);
      y += dateH + DATE_GAP;
    }

    ctx.font = `700 ${title.size}px ${FONT}`;
    ctx.fillStyle = "#ffffff";
    title.lines.forEach((line, i) => ctx.fillText(line, TEXT_X, y + i * title.lh));
    y += titleH;

    if (artistH) {
      y += BLOCK_GAP;
      ctx.font = `400 ${artist.size}px ${FONT}`;
      ctx.fillStyle = "#cdd3d9";
      artist.lines.forEach((line, i) => ctx.fillText(line, TEXT_X, y + i * artist.lh));
    }

    drawWordmark(ctx, mark, PANE_X + PANE_W - WORDMARK_PAD, PANE_Y + PANE_H - WORDMARK_PAD);

    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error("could not turn the card into an image")),
        "image/png"
      );
    });
  }

  /* releaseLine is exported for the suite: it is the one piece of this file
     that is pure arithmetic on a string, and it is the piece most likely to be
     wrong on a date nobody thought to try. */
  return { render, releaseLine, CARD_W, CARD_H, WORDMARK_URL };
})();

/* Node's test runner loads this file to check the layout arithmetic; a browser
   just gets the global. */
if (typeof module !== "undefined" && module.exports) module.exports = { ShareCard };
