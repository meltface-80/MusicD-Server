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
 *   |    | +--------+   1988                              |  |
 *   |    | | cover  |   Spirit of Eden                    |  |
 *   |    | | 424px  |   by Talk Talk                      |  |
 *   |    | +--------+   6 tracks · 41 min       MusicD    |  |
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
         refusal by drawing the card without a cover. */
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
      const consumed = lines.join(" ");
      if (consumed.length < String(text || "").trim().length) {
        while (last && ctx.measureText(last + "…").width > maxWidth) {
          last = last.replace(/\s*\S$/, "");
        }
        lines[maxLines - 1] = last + "…";
      }
    }
    return lines;
  }

  /* Shrink the title until it fits the space it has, rather than ellipsing a
     long one straight away — a two-word album name at 54px reads better than
     four lines of it at 42px. */
  function fitTitle(ctx, text, maxWidth, maxLines) {
    for (const size of [54, 48, 42, 36, 32]) {
      ctx.font = `700 ${size}px ${FONT}`;
      const lines = wrap(ctx, text, maxWidth, maxLines);
      if (lines.length <= maxLines && !lines.some(l => l.endsWith("…"))) {
        return { lines, size };
      }
    }
    ctx.font = `700 32px ${FONT}`;
    return { lines: wrap(ctx, text, maxWidth, maxLines), size: 32 };
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

  /* The wordmark, drawn rather than loaded: one less asset to fetch, and it
     cannot fail halfway through generating a card. */
  function drawWordmark(ctx, right, bottom) {
    ctx.textAlign = "right";
    ctx.font = `700 26px ${FONT}`;
    const d = ctx.measureText("D").width;
    ctx.fillStyle = "#c47f4a";
    ctx.fillText("D", right, bottom);
    ctx.fillStyle = "rgba(255,255,255,.82)";
    ctx.fillText("Music", right - d, bottom);
    ctx.textAlign = "left";
  }

  async function render(data) {
    const cover = await loadImage(data.coverUrl).catch(() => null);

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
    const title = fitTitle(ctx, data.title || "", TEXT_W, 3);
    const titleLh = Math.round(title.size * 1.16);

    ctx.font = `400 24px ${FONT}`;
    const artistLines = wrap(ctx, data.artist ? "by " + data.artist : "", TEXT_W, 2);
    const artistLh = 32;

    const yearText = data.year ? String(data.year) : "";
    const metaText = data.meta || "";

    const blockH =
      (yearText ? 34 : 0) +
      title.lines.length * titleLh +
      (artistLines.length ? 10 + artistLines.length * artistLh : 0) +
      (metaText ? 22 + 26 : 0);
    let y = PANE_Y + Math.round((PANE_H - blockH) / 2);

    if (yearText) {
      ctx.font = `700 16px ${FONT}`;
      ctx.fillStyle = "rgba(255,255,255,.55)";
      ctx.fillText(yearText.toUpperCase(), TEXT_X, y);
      y += 34;
    }

    ctx.font = `700 ${title.size}px ${FONT}`;
    ctx.fillStyle = "#f2f1ef";
    for (const line of title.lines) { ctx.fillText(line, TEXT_X, y); y += titleLh; }

    if (artistLines.length) {
      y += 10;
      ctx.font = `400 24px ${FONT}`;
      ctx.fillStyle = "rgba(255,255,255,.72)";
      for (const line of artistLines) { ctx.fillText(line, TEXT_X, y); y += artistLh; }
    }

    if (metaText) {
      y += 22;
      ctx.font = `400 18px ${FONT}`;
      ctx.fillStyle = "rgba(255,255,255,.45)";
      ctx.fillText(metaText, TEXT_X, y);
    }

    drawWordmark(ctx, PANE_X + PANE_W - 34, PANE_Y + PANE_H - 34 - 26);

    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => blob ? resolve(blob) : reject(new Error("could not turn the card into an image")),
        "image/png"
      );
    });
  }

  return { render, CARD_W, CARD_H };
})();

/* Node's test runner loads this file to check the layout arithmetic; a browser
   just gets the global. */
if (typeof module !== "undefined" && module.exports) module.exports = { ShareCard };
