/**
 * Card & File Tools — Core Application Logic
 * 
 * Features:
 * - ID Card to A4 Composer with physical scale (85.6 × 54 mm, ISO/IEC 7810 ID-1 standard)
 * - Passport Size Photo Grid & Print Studio (A4, 4×6", 5×7", A5, Letter)
 * - 4-corner perspective correction with projective bilinear warping
 * - Auto card edge detection (background separation, Otsu thresholding, convex hull, quad fit)
 * - Interactive full-screen editor with corner loupe magnifier
 * - Full-screen inspection preview with zoom, pan, and side switching
 * - Color grading & document filters (B&W, document contrast, brightness, sharpening)
 * - Batch PDF and image conversion (PDF to JPG, images to PDF with A4 fit)
 * - Batch target-size file compressor (binary search quality + dimensional downscaling)
 * - 100% Client-side privacy (zero server uploads)
 */

'use strict';

/* ==========================================================================
   1. Constants & Application State
   ========================================================================== */

/** Standard ISO/IEC 7810 ID-1 card aspect ratio (85.6 mm / 54.0 mm ~ 1.585185) */
const CARD_ASPECT_RATIO = 85.6 / 54;

/** Shorthand query selector helper */
const $ = selector => document.querySelector(selector);

/** Slots identifiers for card sides */
const SLOT_IDS = ['front', 'back'];

/** Per-slot runtime state store */
const slots = {};

/** Modal editor state (for crop & perspective adjustment) */
const modalState = {
  currentSlot: null,
  snapshot: null,
  isOpen: false
};

/** Full-screen card and sheet preview state */
const previewModalState = {
  isOpen: false,
  target: 'front', // 'front' | 'back' | 'a4' | 'pp-photo' | 'pp-sheet'
  zoom: 1,
  panX: 0,
  panY: 0,
  isPanning: false,
  startPointerX: 0,
  startPointerY: 0,
  basePanX: 0,
  basePanY: 0
};

/** RequestAnimationFrame ID for debounced sheet preview rendering */
let previewRafId = null;
let passportPreviewRafId = null;

/** Standard paper sizes in millimeters */
const PAPER_SIZES = {
  '4x6': { name: '4 × 6 inch (4R Photo)', w: 101.6, h: 152.4 },
  'a4': { name: 'A4', w: 210, h: 297 },
  '5x7': { name: '5 × 7 inch (5R Photo)', w: 127, h: 177.8 },
  'a5': { name: 'A5', w: 148, h: 210 },
  'letter': { name: 'US Letter', w: 215.9, h: 279.4 }
};

/** Standard international passport and visa photo size presets (mm) */
const PASSPORT_PRESETS = {
  '35x45': { w: 35, h: 45 },
  '51x51': { w: 51, h: 51 },
  '35x35': { w: 35, h: 35 },
  '30x40': { w: 30, h: 40 },
  '33x48': { w: 33, h: 48 },
  '50x70': { w: 50, h: 70 }
};

/* ==========================================================================
   2. Configuration & Option Helpers
   ========================================================================== */

/**
 * Reads layout and styling options from the UI controls for ID card tool.
 * @returns {Object} Current configuration parameters.
 */
function getOptions() {
  return {
    cardWidth: +$('#cw').value || 85.6,
    gap: +$('#gap').value || 0,
    layout: $('#layout').value,
    position: $('#pos').value,
    lockAspect: $('#lock').checked,
    roundCorners: $('#round').checked,
    showGuide: $('#guide').checked
  };
}

/**
 * Returns optional maximum file size limit in KB (0 if unbounded).
 */
const getMaxKB = () => +$('#maxkb').value || 0;

/**
 * Reads passport photo settings, paper dimensions, margins, and count options.
 */
function getPassportOptions() {
  const preset = $('#pp-preset') ? $('#pp-preset').value : '35x45';
  const photoWidth = +$('#pp-w').value || 35;
  const photoHeight = +$('#pp-h').value || 45;

  return {
    preset,
    photoWidth,
    photoHeight,
    aspectRatio: photoWidth / photoHeight,
    paperKey: $('#pp-paper') ? $('#pp-paper').value : '4x6',
    orientation: $('#pp-orient') ? $('#pp-orient').value : 'auto',
    alignment: $('#pp-align') ? $('#pp-align').value : 'center',
    countMode: $('#pp-count-mode') ? $('#pp-count-mode').value : 'fill',
    customCount: Math.max(1, Math.min(100, +$('#pp-count').value || 8)),
    gap: Math.max(0, +$('#pp-gap').value || 0),
    margin: Math.max(0, +$('#pp-margin').value || 0),
    hasBorder: $('#pp-border') ? $('#pp-border').checked : true,
    borderStyle: $('#pp-border-style') ? $('#pp-border-style').value : 'light',
    textType: $('#pp-text-type') ? $('#pp-text-type').value : 'none',
    textName: $('#pp-text-name') ? $('#pp-text-name').value.trim() : '',
    textDate: $('#pp-text-date') ? $('#pp-text-date').value.trim() : '',
    textCustom2: $('#pp-text-custom2') ? $('#pp-text-custom2').value.trim() : '',
    textStyle: $('#pp-text-style') ? $('#pp-text-style').value : 'white_strip',
    textUpper: $('#pp-text-upper') ? $('#pp-text-upper').checked : true,
    lockRatio: $('#pp-lock-ratio') ? $('#pp-lock-ratio').checked : true
  };
}

/**
 * Calculates effective paper dimensions and orientation for passport photo printing.
 */
function getPassportPaperDimensions() {
  const opt = getPassportOptions();
  const base = PAPER_SIZES[opt.paperKey] || PAPER_SIZES['4x6'];
  let w = base.w;
  let h = base.h;

  if (opt.orientation === 'portrait') {
    w = Math.min(base.w, base.h);
    h = Math.max(base.w, base.h);
  } else if (opt.orientation === 'landscape') {
    w = Math.max(base.w, base.h);
    h = Math.min(base.w, base.h);
  } else {
    // Auto-orientation: select orientation that fits more photos
    const countP = calculateMaxGridCount(Math.min(base.w, base.h), Math.max(base.w, base.h), opt);
    const countL = calculateMaxGridCount(Math.max(base.w, base.h), Math.min(base.w, base.h), opt);
    if (countL.total > countP.total) {
      w = Math.max(base.w, base.h);
      h = Math.min(base.w, base.h);
    } else {
      w = Math.min(base.w, base.h);
      h = Math.max(base.w, base.h);
    }
  }
  return { name: base.name, w, h };
}

/**
 * Calculates rows, columns, and total photos that fit inside printable boundaries.
 */
function calculateMaxGridCount(paperW, paperH, opt) {
  const usableW = Math.max(0, paperW - 2 * opt.margin);
  const usableH = Math.max(0, paperH - 2 * opt.margin);
  const cols = Math.floor((usableW + opt.gap) / (opt.photoWidth + opt.gap));
  const rows = Math.floor((usableH + opt.gap) / (opt.photoHeight + opt.gap));
  return {
    cols: Math.max(0, cols),
    rows: Math.max(0, rows),
    total: Math.max(0, cols * rows)
  };
}

/* ==========================================================================
   3. Slot Initialization & Event Binding (ID Card Slots)
   ========================================================================== */

SLOT_IDS.forEach(slotId => {
  const container = document.querySelector(`[data-slot="${slotId}"]`);
  if (!container) return;

  const slot = {
    id: slotId,
    el: container,
    drop: container.querySelector('.drop'),
    editor: container.querySelector('.editor'),
    cv: container.querySelector('canvas'),
    fileInput: container.querySelector('input[type="file"]'),
    img: null,
    crop: null,
    quad: null,
    srcData: null,
    persp: true,
    filter: { mode: 'none', br: 0, ct: 0, sat: 0, sh: 0, flip: false },
    scale: 1,
    dragMode: null,
    thumb: null
  };

  slots[slotId] = slot;

  // Dropzone click & keyboard trigger
  slot.drop.addEventListener('click', () => slot.fileInput.click());
  slot.drop.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      slot.fileInput.click();
    }
  });

  // File input change
  slot.fileInput.addEventListener('change', () => {
    if (slot.fileInput.files && slot.fileInput.files[0]) {
      loadCardImage(slot, slot.fileInput.files[0]);
    }
  });

  // Drag and drop event handlers
  ['dragover', 'dragenter'].forEach(eventName => {
    slot.drop.addEventListener(eventName, e => {
      e.preventDefault();
      slot.drop.classList.add('over');
    });
  });

  ['dragleave', 'drop'].forEach(eventName => {
    slot.drop.addEventListener(eventName, e => {
      e.preventDefault();
      slot.drop.classList.remove('over');
    });
  });

  slot.drop.addEventListener('drop', e => {
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
      loadCardImage(slot, file);
    }
  });

  // Action buttons inside card headers
  const previewHeaderBtn = container.querySelector('[data-act="preview"]');
  if (previewHeaderBtn) {
    previewHeaderBtn.addEventListener('click', () => {
      if (slot.img) {
        openPreviewModal(slotId);
      } else {
        alert('Please add a card image first.');
      }
    });
  }

  const clearBtn = container.querySelector('[data-act="clear"]');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      slot.img = null;
      slot.crop = null;
      slot.quad = null;
      slot.srcData = null;
      slot.fileInput.value = '';
      slot.editor.style.display = 'none';
      slot.drop.style.display = 'grid';
      requestPreview();
    });
  }

  const rotBtn = container.querySelector('[data-act="rot"]');
  if (rotBtn) {
    rotBtn.addEventListener('click', () => rotateSlot(slot));
  }

  const perspBtn = container.querySelector('[data-act="persp"]');
  if (perspBtn) {
    perspBtn.addEventListener('click', () => {
      slot.persp = !slot.persp;
      perspBtn.setAttribute('aria-pressed', slot.persp);
      const hint = container.querySelector('.editor .hint');
      if (hint) {
        hint.textContent = slot.persp
          ? 'Drag each corner onto a corner of the card. Drag inside to move all four.'
          : 'Drag the box to move it. Drag a corner to resize.';
      }
      if (slot.img) {
        const c = slot.crop;
        if (slot.persp) {
          slot.quad = [
            { x: c.x, y: c.y },
            { x: c.x + c.w, y: c.y },
            { x: c.x + c.w, y: c.y + c.h },
            { x: c.x, y: c.y + c.h }
          ];
        }
        drawCropCanvas(slot);
        requestPreview();
      }
    });
  }

  bindCanvasEvents(slot);
  mountThumbnail(slot);
});

// Setup filter adjustments panel for ID card tool
initAdjustmentsPanel();

// A4 sheet full screen triggers
const fullscreenSheetBtn = $('#fullscreen-sheet');
if (fullscreenSheetBtn) {
  fullscreenSheetBtn.addEventListener('click', () => {
    if (hasLoadedCard()) openPreviewModal('a4');
  });
}

const sheetCanvas = $('#sheet');
if (sheetCanvas) {
  sheetCanvas.addEventListener('click', () => {
    if (hasLoadedCard()) openPreviewModal('a4');
  });
}

/* ==========================================================================
   4. Image Loading & Crop Initialization
   ========================================================================== */

/**
 * Loads an image file into a card slot, applies automatic card detection,
 * and opens the interactive crop editor modal.
 */
function loadCardImage(slot, file) {
  const objectUrl = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(objectUrl);
    slot.img = img;
    slot.srcData = null;
    initDefaultCrop(slot);
    if (slot.id !== 'passport') {
      autoSelectCard(slot, true);
    }
    showCardSlot(slot);
    openModalEditor(slot);
  };
  img.onerror = () => {
    URL.revokeObjectURL(objectUrl);
    alert('Could not read image file. Please try another image.');
  };
  img.src = objectUrl;
}

/**
 * Reveals the editor interface for a slot and hides its drop zone.
 */
function showCardSlot(slot) {
  slot.drop.style.display = 'none';
  if (slot.editor) slot.editor.style.display = 'block';
  if (slot.id === 'passport') {
    $('#pp-editor-box').style.display = 'block';
    $('#pp-photo-actions').style.display = 'inline-flex';
    drawPassportThumbnail();
    requestPassportPreview();
  } else {
    drawCropCanvas(slot);
    requestPreview();
  }
}

/**
 * Initializes crop rectangle to centered bounds matching the appropriate aspect ratio.
 */
function initDefaultCrop(slot) {
  const W = slot.img.width;
  const H = slot.img.height;
  const ratio = slot.id === 'passport'
    ? getPassportOptions().aspectRatio
    : (getOptions().lockAspect ? CARD_ASPECT_RATIO : W / H);

  let w = W * 0.92;
  let h = w / ratio;

  if (h > H * 0.92) {
    h = H * 0.92;
    w = h * ratio;
  }

  slot.crop = {
    x: (W - w) / 2,
    y: (H - h) / 2,
    w,
    h
  };

  const c = slot.crop;
  slot.quad = [
    { x: c.x, y: c.y },
    { x: c.x + c.w, y: c.y },
    { x: c.x + c.w, y: c.y + c.h },
    { x: c.x, y: c.y + c.h }
  ];
  slot.srcData = null;
}

/**
 * Rotates the source image by 90 degrees clockwise and recalculates crop coordinates.
 */
function rotateSlot(slot) {
  if (!slot.img) return;
  const canvas = document.createElement('canvas');
  canvas.width = slot.img.height;
  canvas.height = slot.img.width;
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width, 0);
  ctx.rotate(Math.PI / 2);
  ctx.drawImage(slot.img, 0, 0);

  slot.img = canvas;
  slot.srcData = null;
  initDefaultCrop(slot);

  if (slot.id === 'passport') {
    drawPassportThumbnail();
    requestPassportPreview();
  } else {
    drawCropCanvas(slot);
    requestPreview();
  }
}

/* ==========================================================================
   5. Interactive Crop Canvas Rendering & Geometry
   ========================================================================== */

/**
 * Draws the image, dimming overlay mask, selection polygon, corner handles,
 * and edge anchors onto the slot canvas.
 */
function drawCropCanvas(slot) {
  const im = slot.img;
  if (!im) return;

  const targetWidth = Math.min(im.width, 1400);
  slot.scale = targetWidth / im.width;
  slot.cv.width = targetWidth;
  slot.cv.height = Math.round(im.height * slot.scale);

  const ctx = slot.cv.getContext('2d');
  const k = slot.scale;
  const c = slot.crop;

  ctx.drawImage(im, 0, 0, slot.cv.width, slot.cv.height);

  const polyPoints = slot.persp
    ? slot.quad
    : [
        { x: c.x, y: c.y },
        { x: c.x + c.w, y: c.y },
        { x: c.x + c.w, y: c.y + c.h },
        { x: c.x, y: c.y + c.h }
      ];

  const tracePolygon = () => {
    polyPoints.forEach((p, i) => {
      if (i === 0) ctx.moveTo(p.x * k, p.y * k);
      else ctx.lineTo(p.x * k, p.y * k);
    });
    ctx.closePath();
  };

  // Semi-transparent overlay outside the card area (even-odd fill)
  ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.beginPath();
  ctx.rect(0, 0, slot.cv.width, slot.cv.height);
  tracePolygon();
  ctx.fill('evenodd');

  // Boundary outline
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.beginPath();
  tracePolygon();
  ctx.stroke();

  // Draw handles (circles on edge midpoints, squares on corners)
  const handleSize = 9 * Math.max(1, slot.cv.width / (slot.cv.clientWidth || slot.cv.width));
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#0b6e63';
  ctx.lineWidth = 2;

  // Edge anchors (round dots)
  polyPoints.forEach((p, i) => {
    const next = polyPoints[(i + 1) % 4];
    ctx.beginPath();
    ctx.arc(((p.x + next.x) / 2) * k, ((p.y + next.y) / 2) * k, handleSize * 0.85, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });

  // Corner handles (squares)
  polyPoints.forEach(p => {
    const px = p.x * k - handleSize;
    const py = p.y * k - handleSize;
    const sz = handleSize * 2;
    ctx.fillRect(px, py, sz, sz);
    ctx.strokeRect(px, py, sz, sz);
  });
}

function getRectangleCorners(c) {
  return [
    { n: 'tl', x: c.x, y: c.y, ax: c.x + c.w, ay: c.y + c.h },
    { n: 'tr', x: c.x + c.w, y: c.y, ax: c.x, ay: c.y + c.h },
    { n: 'bl', x: c.x, y: c.y + c.h, ax: c.x + c.w, ay: c.y },
    { n: 'br', x: c.x + c.w, y: c.y + c.h, ax: c.x, ay: c.y }
  ];
}

function bindCanvasEvents(slot) {
  const getPointerPoint = e => {
    const rect = slot.cv.getBoundingClientRect();
    const invScale = (slot.cv.width / rect.width) / slot.scale;
    return {
      x: (e.clientX - rect.left) * invScale,
      y: (e.clientY - rect.top) * invScale,
      hitRadius: 32 * invScale
    };
  };

  const testHit = pt => {
    if (slot.persp) {
      const vertIndex = slot.quad.findIndex(
        q => Math.abs(q.x - pt.x) < pt.hitRadius && Math.abs(q.y - pt.y) < pt.hitRadius
      );
      if (vertIndex >= 0) return { t: 'vert', i: vertIndex };

      const edgeIndex = slot.quad.findIndex((q, i) => {
        const next = slot.quad[(i + 1) % 4];
        const mx = (q.x + next.x) / 2;
        const my = (q.y + next.y) / 2;
        return Math.abs(mx - pt.x) < pt.hitRadius && Math.abs(my - pt.y) < pt.hitRadius;
      });
      if (edgeIndex >= 0) return { t: 'edge', i: edgeIndex };

      return isPointInPolygon(slot.quad, pt) ? { t: 'move' } : null;
    }

    const c = slot.crop;
    const cornerHit = getRectangleCorners(c).find(
      q => Math.abs(q.x - pt.x) < pt.hitRadius && Math.abs(q.y - pt.y) < pt.hitRadius
    );
    if (cornerHit) return { t: 'resize', h: cornerHit };

    if (pt.x > c.x && pt.x < c.x + c.w && pt.y > c.y && pt.y < c.y + c.h) {
      return { t: 'move' };
    }
    return null;
  };

  slot.cv.addEventListener('pointerdown', e => {
    if (!slot.img) return;
    const pt = getPointerPoint(e);
    const hit = testHit(pt);
    if (!hit) return;

    slot.dragMode = hit;
    slot.dragOffset = { x: pt.x - slot.crop.x, y: pt.y - slot.crop.y };
    slot.p0 = pt;
    slot.q0 = slot.quad.map(q => ({ ...q }));
    slot.cv.setPointerCapture(e.pointerId);
  });

  slot.cv.addEventListener('pointermove', e => {
    if (!slot.img) return;
    const pt = getPointerPoint(e);
    const c = slot.crop;
    const W = slot.img.width;
    const H = slot.img.height;

    if (!slot.dragMode) {
      const hit = testHit(pt);
      if (!hit) {
        slot.cv.style.cursor = 'default';
      } else if (hit.t === 'move') {
        slot.cv.style.cursor = 'move';
      } else if (hit.t === 'vert' || hit.t === 'edge') {
        slot.cv.style.cursor = 'crosshair';
      } else {
        slot.cv.style.cursor = (hit.h.n === 'tl' || hit.h.n === 'br') ? 'nwse-resize' : 'nesw-resize';
      }
      return;
    }

    const mode = slot.dragMode;
    if (mode.t === 'edge') {
      const i = mode.i;
      const j = (i + 1) % 4;
      const a = slot.q0[i];
      const b = slot.q0[j];
      let nx = -(b.y - a.y);
      let ny = b.x - a.x;
      const len = Math.hypot(nx, ny) || 1;
      nx /= len;
      ny /= len;

      const delta = (pt.x - slot.p0.x) * nx + (pt.y - slot.p0.y) * ny;
      slot.quad[i] = {
        x: Math.max(0, Math.min(W, a.x + nx * delta)),
        y: Math.max(0, Math.min(H, a.y + ny * delta))
      };
      slot.quad[j] = {
        x: Math.max(0, Math.min(W, b.x + nx * delta)),
        y: Math.max(0, Math.min(H, b.y + ny * delta))
      };
    } else if (mode.t === 'vert') {
      slot.quad[mode.i] = {
        x: Math.max(0, Math.min(W, pt.x)),
        y: Math.max(0, Math.min(H, pt.y))
      };
    } else if (slot.persp && mode.t === 'move') {
      const xs = slot.q0.map(q => q.x);
      const ys = slot.q0.map(q => q.y);
      const dx = Math.max(-Math.min(...xs), Math.min(W - Math.max(...xs), pt.x - slot.p0.x));
      const dy = Math.max(-Math.min(...ys), Math.min(H - Math.max(...ys), pt.y - slot.p0.y));
      slot.quad = slot.q0.map(q => ({ x: q.x + dx, y: q.y + dy }));
    } else if (mode.t === 'move') {
      c.x = Math.max(0, Math.min(W - c.w, pt.x - slot.dragOffset.x));
      c.y = Math.max(0, Math.min(H - c.h, pt.y - slot.dragOffset.y));
    } else {
      const { ax, ay } = mode.h;
      const sx = pt.x >= ax ? 1 : -1;
      const sy = pt.y >= ay ? 1 : -1;
      const maxW = sx > 0 ? W - ax : ax;
      const maxH = sy > 0 ? H - ay : ay;
      let w = Math.abs(pt.x - ax);
      let h = Math.abs(pt.y - ay);

      const targetRatio = slot.id === 'passport'
        ? getPassportOptions().aspectRatio
        : (getOptions().lockAspect ? CARD_ASPECT_RATIO : null);

      if (targetRatio) {
        w = Math.max(30, Math.min(w, maxW, maxH * targetRatio));
        h = w / targetRatio;
      } else {
        w = Math.max(30, Math.min(w, maxW));
        h = Math.max(30, Math.min(h, maxH));
      }
      c.x = sx > 0 ? ax : ax - w;
      c.y = sy > 0 ? ay : ay - h;
      c.w = w;
      c.h = h;
    }

    drawCropCanvas(slot);
    if (slot.id === 'passport') {
      requestPassportPreview();
    } else {
      requestPreview();
    }
  });

  const stopDrag = () => {
    slot.dragMode = null;
  };

  slot.cv.addEventListener('pointerup', stopDrag);
  slot.cv.addEventListener('pointercancel', stopDrag);
}

/* ==========================================================================
   6. Adjustment Panel & Image Filters
   ========================================================================== */

/**
 * Initializes the image filters and enhancement panel controls for ID card tool.
 */
function initAdjustmentsPanel() {
  const panel = $('#adjust');
  if (!panel) return;

  const defaultFilters = () => ({ mode: 'none', br: 0, ct: 0, sat: 0, sh: 0, flip: false });
  let activeTarget = 'both';

  const targets = [['both', 'Both sides'], ['front', 'Front only'], ['back', 'Back only']];
  const modes = [
    ['none', 'Original'],
    ['bw', 'Black &amp; white'],
    ['doc', 'Document'],
    ['sepia', 'Sepia']
  ];
  const sliders = [
    ['br', 'Brightness', -100, 100],
    ['ct', 'Contrast', -100, 100],
    ['sat', 'Colour', -100, 100],
    ['sh', 'Sharpen', 0, 100]
  ];

  panel.insertAdjacentHTML(
    'beforeend',
    `<div class="row no-margin"><span>Apply to</span>${targets.map(t => `<button data-t="${t[0]}">${t[1]}</button>`).join('')}</div>` +
    `<div class="row">${modes.map(m => `<button data-mode="${m[0]}">${m[1]}</button>`).join('')}</div>` +
    `<div class="sliders">${sliders.map(v => `<label>${v[1]}<input type="range" data-k="${v[0]}" min="${v[2]}" max="${v[3]}" value="0"></label>`).join('')}</div>` +
    `<div class="row"><button data-act="flip">Flip horizontally</button><button data-act="reset">Reset edits</button></div>` +
    `<p class="hint">Changes show in the A4 preview and in the download.</p>`
  );

  const getTargetSlots = () => (activeTarget === 'both' ? SLOT_IDS : [activeTarget]);

  const syncPanelUI = () => {
    const firstSlot = slots[getTargetSlots()[0]];
    if (!firstSlot) return;
    const f = firstSlot.filter;
    const setPressed = (el, val) => el.setAttribute('aria-pressed', val);

    panel.querySelectorAll('[data-t]').forEach(b => setPressed(b, b.dataset.t === activeTarget));
    panel.querySelectorAll('[data-mode]').forEach(b => setPressed(b, b.dataset.mode === f.mode));
    panel.querySelectorAll('[data-k]').forEach(inp => {
      inp.value = f[inp.dataset.k];
    });
    setPressed(panel.querySelector('[data-act="flip"]'), f.flip);
  };

  panel.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;

    if (btn.dataset.t) {
      activeTarget = btn.dataset.t;
    } else {
      const targetSlots = getTargetSlots();
      const currentFlip = slots[targetSlots[0]].filter.flip;

      targetSlots.forEach(id => {
        const s = slots[id];
        if (btn.dataset.mode) {
          s.filter.mode = btn.dataset.mode;
        } else if (btn.dataset.act === 'flip') {
          s.filter.flip = !currentFlip;
        } else if (btn.dataset.act === 'reset') {
          s.filter = defaultFilters();
        }
      });
    }

    syncPanelUI();
    requestPreview();
    if (previewModalState.isOpen) {
      renderPreviewCanvas();
    }
  });

  panel.addEventListener('input', e => {
    const key = e.target.dataset.k;
    if (key) {
      const val = +e.target.value;
      getTargetSlots().forEach(id => {
        slots[id].filter[key] = val;
      });
      requestPreview();
      if (previewModalState.isOpen) {
        renderPreviewCanvas();
      }
    }
  });

  syncPanelUI();
}

/**
 * Applies brightness, contrast, saturation, sepia/document filters,
 * and 3x3 Laplace sharpening to an image buffer.
 */
function applyFilters(ctx, width, height, filter) {
  if (filter.mode === 'none' && !filter.br && !filter.ct && !filter.sat && !filter.sh) {
    return;
  }

  const imgData = ctx.getImageData(0, 0, width, height);
  const data = imgData.data;
  const contrastFactor = (259 * (filter.ct + 255)) / (255 * (259 - filter.ct));
  const brightnessOffset = filter.br * 2.55;
  const saturationMult = 1 + filter.sat / 100;

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i];
    let g = data[i + 1];
    let b = data[i + 2];

    if (filter.mode === 'sepia') {
      const sr = 0.393 * r + 0.769 * g + 0.189 * b;
      const sg = 0.349 * r + 0.686 * g + 0.168 * b;
      const sb = 0.272 * r + 0.534 * g + 0.131 * b;
      r = sr;
      g = sg;
      b = sb;
    } else if (filter.mode === 'bw' || filter.mode === 'doc') {
      const gray = 0.299 * r + 0.587 * g + 0.114 * b;
      r = g = b = filter.mode === 'doc' ? (gray - 70) * (255 / 130) : gray;
    }

    if (saturationMult !== 1) {
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      r = lum + (r - lum) * saturationMult;
      g = lum + (g - lum) * saturationMult;
      b = lum + (b - lum) * saturationMult;
    }

    data[i] = (r + brightnessOffset - 128) * contrastFactor + 128;
    data[i + 1] = (g + brightnessOffset - 128) * contrastFactor + 128;
    data[i + 2] = (b + brightnessOffset - 128) * contrastFactor + 128;
  }

  if (filter.sh) {
    const src = new Uint8ClampedArray(data);
    const alpha = filter.sh / 100;
    const stride = width * 4;

    for (let y = 1; y < height - 1; y++) {
      const rowOffset = y * stride;
      for (let x = 1; x < width - 1; x++) {
        const offset = rowOffset + x * 4;
        for (let c = 0; c < 3; c++) {
          const k = offset + c;
          const val = src[k] + alpha * (4 * src[k] - src[k - 4] - src[k + 4] - src[k - stride] - src[k + stride]);
          data[k] = val;
        }
      }
    }
  }

  ctx.putImageData(imgData, 0, 0);
}

/* ==========================================================================
   7. Perspective Transformation (Homography & Bilinear Warp)
   ========================================================================== */

/**
 * Maps the 4 picked quadrilateral corners onto a rectified rectangle of dimensions
 * `outWidth` × `outHeight` using projective transformation with bilinear sampling.
 */
function warpPerspective(slot, outWidth, outHeight) {
  if (!slot.srcData) {
    const cacheCanvas = document.createElement('canvas');
    cacheCanvas.width = slot.img.width;
    cacheCanvas.height = slot.img.height;
    const cacheCtx = cacheCanvas.getContext('2d');
    cacheCtx.drawImage(slot.img, 0, 0);
    slot.srcData = cacheCtx.getImageData(0, 0, cacheCanvas.width, cacheCanvas.height);
  }

  const src = slot.srcData;
  const sw = src.width;
  const sh = src.height;
  const srcBytes = src.data;
  const [p0, p1, p2, p3] = slot.quad;

  const dx1 = p1.x - p2.x;
  const dx2 = p3.x - p2.x;
  const dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y;
  const dy2 = p3.y - p2.y;
  const dy3 = p0.y - p1.y + p2.y - p3.y;

  let g = 0;
  let h = 0;
  const denom = dx1 * dy2 - dx2 * dy1;
  if ((Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9) && Math.abs(denom) > 1e-9) {
    g = (dx3 * dy2 - dx2 * dy3) / denom;
    h = (dx1 * dy3 - dx3 * dy1) / denom;
  }

  const A = p1.x - p0.x + g * p1.x;
  const B = p3.x - p0.x + h * p3.x;
  const C = p0.x;
  const D = p1.y - p0.y + g * p1.y;
  const E = p3.y - p0.y + h * p3.y;
  const F = p0.y;

  const outCanvas = document.createElement('canvas');
  outCanvas.width = outWidth;
  outCanvas.height = outHeight;
  const outCtx = outCanvas.getContext('2d');
  const outImageData = outCtx.createImageData(outWidth, outHeight);
  const outBytes = outImageData.data;

  const Au = new Float32Array(outWidth);
  const Du = new Float32Array(outWidth);
  const gu = new Float32Array(outWidth);
  for (let i = 0; i < outWidth; i++) {
    const u = (i + 0.5) / outWidth;
    Au[i] = A * u;
    Du[i] = D * u;
    gu[i] = g * u;
  }

  let outIndex = 0;
  for (let j = 0; j < outHeight; j++) {
    const v = (j + 0.5) / outHeight;
    const BvC = B * v + C;
    const EvF = E * v + F;
    const hv1 = h * v + 1;

    for (let i = 0; i < outWidth; i++) {
      const invW = 1 / (gu[i] + hv1);
      const sx = (Au[i] + BvC) * invW - 0.5;
      const sy = (Du[i] + EvF) * invW - 0.5;

      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;

      const xa = x0 < 0 ? 0 : (x0 >= sw ? sw - 1 : x0);
      const xb = (x0 + 1) < 0 ? 0 : ((x0 + 1) >= sw ? sw - 1 : x0 + 1);
      const ya = y0 < 0 ? 0 : (y0 >= sh ? sh - 1 : y0);
      const yb = (y0 + 1) < 0 ? 0 : ((y0 + 1) >= sh ? sh - 1 : y0 + 1);

      const i00 = (ya * sw + xa) * 4;
      const i10 = (ya * sw + xb) * 4;
      const i01 = (yb * sw + xa) * 4;
      const i11 = (yb * sw + xb) * 4;

      const w00 = (1 - fx) * (1 - fy);
      const w10 = fx * (1 - fy);
      const w01 = (1 - fx) * fy;
      const w11 = fx * fy;

      outBytes[outIndex]     = srcBytes[i00]     * w00 + srcBytes[i10]     * w10 + srcBytes[i01]     * w01 + srcBytes[i11]     * w11;
      outBytes[outIndex + 1] = srcBytes[i00 + 1] * w00 + srcBytes[i10 + 1] * w10 + srcBytes[i01 + 1] * w01 + srcBytes[i11 + 1] * w11;
      outBytes[outIndex + 2] = srcBytes[i00 + 2] * w00 + srcBytes[i10 + 2] * w10 + srcBytes[i01 + 2] * w01 + srcBytes[i11 + 2] * w11;
      outBytes[outIndex + 3] = srcBytes[i00 + 3] * w00 + srcBytes[i10 + 3] * w10 + srcBytes[i01 + 3] * w01 + srcBytes[i11 + 3] * w11;

      outIndex += 4;
    }
  }

  outCtx.putImageData(outImageData, 0, 0);
  return outCanvas;
}

/**
 * Creates an offscreen canvas containing the cropped, perspective-corrected,
 * and filtered card or photo image.
 */
function createCardCanvas(slot, targetWidth, targetHeight) {
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingQuality = 'high';

  if (slot.filter.flip) {
    ctx.translate(targetWidth, 0);
    ctx.scale(-1, 1);
  }

  if (slot.persp) {
    ctx.drawImage(warpPerspective(slot, targetWidth, targetHeight), 0, 0);
  } else {
    const c = slot.crop;
    ctx.drawImage(slot.img, c.x, c.y, c.w, c.h, 0, 0, targetWidth, targetHeight);
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  applyFilters(ctx, targetWidth, targetHeight, slot.filter);
  return canvas;
}

function isPointInPolygon(polygon, point) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const pi = polygon[i];
    const pj = polygon[j];
    const intersect =
      pi.y > point.y !== pj.y > point.y &&
      point.x < ((pj.x - pi.x) * (point.y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

function calculateAspectRatio(slot, options) {
  if (slot.id === 'passport') {
    return getPassportOptions().aspectRatio;
  }
  if (!slot.persp) return slot.crop.w / slot.crop.h;
  if (options.lockAspect) return CARD_ASPECT_RATIO;

  const q = slot.quad;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const avgWidth = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2;
  const avgHeight = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2 || 1;
  return avgWidth / avgHeight;
}

/* ==========================================================================
   8. A4 Sheet Composition & Export (ID Card Tool)
   ========================================================================== */

function composeA4Sheet(canvas, dpi, showPlaceholders) {
  const options = getOptions();
  const pxPerMm = dpi / 25.4;
  const sheetWidth = Math.round(210 * pxPerMm);
  const sheetHeight = Math.round(297 * pxPerMm);

  canvas.width = sheetWidth;
  canvas.height = sheetHeight;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, sheetWidth, sheetHeight);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const items = SLOT_IDS.map(id => {
    const slot = slots[id];
    return {
      id,
      slot,
      w: options.cardWidth,
      h: options.cardWidth / (slot.img ? calculateAspectRatio(slot, options) : CARD_ASPECT_RATIO)
    };
  });

  if (options.layout === 'side') {
    options.gap = Math.min(options.gap, Math.max(0, 200 - 2 * options.cardWidth));
  }

  const isStack = options.layout === 'stack';
  const totalWidth = isStack
    ? options.cardWidth
    : items.length * options.cardWidth + options.gap * (items.length - 1);
  const totalHeight = isStack
    ? items.reduce((acc, it) => acc + it.h, 0) + options.gap * (items.length - 1)
    : Math.max(...items.map(it => it.h));

  let startX = Math.max(0, (210 - totalWidth) / 2);
  let startY = options.position === 'top' ? 25 : Math.max(0, (297 - totalHeight) / 2);

  items.forEach(item => {
    const cardPxX = startX * pxPerMm;
    const cardPxY = startY * pxPerMm;
    const cardPxW = item.w * pxPerMm;
    const cardPxH = item.h * pxPerMm;
    const cornerRadius = options.roundCorners ? 3.18 * pxPerMm : 0;

    const definePath = () => {
      ctx.beginPath();
      if (cornerRadius && ctx.roundRect) {
        ctx.roundRect(cardPxX, cardPxY, cardPxW, cardPxH, cornerRadius);
      } else {
        ctx.rect(cardPxX, cardPxY, cardPxW, cardPxH);
      }
    };

    if (item.slot.img) {
      ctx.save();
      definePath();
      ctx.clip();
      ctx.drawImage(
        createCardCanvas(item.slot, Math.round(cardPxW), Math.round(cardPxH)),
        cardPxX,
        cardPxY,
        cardPxW,
        cardPxH
      );
      ctx.restore();

      if (options.showGuide) {
        definePath();
        ctx.strokeStyle = '#b5bcc3';
        ctx.lineWidth = Math.max(1, 0.3 * pxPerMm);
        ctx.stroke();
      }
    } else if (showPlaceholders) {
      definePath();
      ctx.setLineDash([8, 6]);
      ctx.strokeStyle = '#b5bcc3';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.fillStyle = '#8a96a1';
      ctx.font = `${Math.round(cardPxW / 16)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(item.id === 'front' ? 'Front' : 'Back', cardPxX + cardPxW / 2, cardPxY + cardPxH / 2);
    }

    if (isStack) {
      startY += item.h + options.gap;
    } else {
      startX += item.w + options.gap;
    }
  });
}

function requestPreview() {
  if (previewRafId) cancelAnimationFrame(previewRafId);
  previewRafId = requestAnimationFrame(() => {
    composeA4Sheet($('#sheet'), 100, true);
    if (!modalState.isOpen) {
      SLOT_IDS.forEach(id => drawThumbnail(slots[id]));
    }
    if (previewModalState.isOpen && previewModalState.target === 'a4') {
      renderPreviewCanvas();
    }
    previewRafId = null;
  });
}

function createExportCanvas() {
  const canvas = document.createElement('canvas');
  composeA4Sheet(canvas, 300, false);
  return canvas;
}

function hasLoadedCard() {
  if (!SLOT_IDS.some(id => slots[id].img)) {
    alert('Please add at least one card image first.');
    return false;
  }
  return true;
}

async function executeWithLoading(buttonSelector, actionFn) {
  setButtonBusy(buttonSelector, true);
  await yieldEventLoop();
  try {
    await actionFn();
  } catch (err) {
    alert('Something went wrong: ' + (err.message || err));
  }
  setButtonBusy(buttonSelector, false);
}

// Export button actions for ID card tool
$('#png').addEventListener('click', () => {
  if (hasLoadedCard()) {
    executeWithLoading('#png', async () => {
      const blob = await canvasToBlob(createExportCanvas(), 'image/png');
      saveBlobFile(blob, 'id-card-a4.png');
    });
  }
});

$('#jpg').addEventListener('click', () => {
  if (hasLoadedCard()) {
    executeWithLoading('#jpg', async () => {
      const canvas = createExportCanvas();
      const maxKB = getMaxKB();
      const blob = maxKB
        ? await compressJpegToTarget(canvas, maxKB)
        : await canvasToBlob(canvas, 'image/jpeg', 0.95);
      saveBlobFile(blob, 'id-card-a4.jpg');
    });
  }
});

$('#pdf').addEventListener('click', () => {
  if (hasLoadedCard()) {
    executeWithLoading('#pdf', async () => {
      if (!window.jspdf) {
        alert('The PDF library did not load. Please download as JPEG or PNG instead.');
        return;
      }
      const pages = [{ c: createExportCanvas(), w: 210, h: 297 }];
      const maxKB = getMaxKB();
      const blob = maxKB
        ? await compressPdfToTarget(pages, maxKB)
        : convertPagesToPdf(pages, 0.95);
      saveBlobFile(blob, 'id-card-a4.pdf');
    });
  }
});

$('#print').addEventListener('click', () => {
  if (hasLoadedCard()) {
    executeWithLoading('#print', async () => {
      const canvas = document.createElement('canvas');
      composeA4Sheet(canvas, 200, false);
      const printImg = $('#printImg');
      printImg.src = canvas.toDataURL('image/jpeg', 0.95);
      await printImg.decode().catch(() => {});
      window.print();
    });
  }
});

['cw', 'gap', 'layout', 'pos', 'round', 'guide'].forEach(inputId => {
  const elem = $('#' + inputId);
  if (elem) elem.addEventListener('input', requestPreview);
});

$('#lock').addEventListener('change', () => {
  if ($('#lock').checked) {
    SLOT_IDS.forEach(id => {
      const s = slots[id];
      if (s.img) {
        initDefaultCrop(s);
        drawCropCanvas(s);
      }
    });
  }
  requestPreview();
});

window.addEventListener('resize', () => {
  fitModalCanvas();
  if (previewModalState.isOpen) {
    renderPreviewCanvas();
  }
});

/* ==========================================================================
   9. Passport Photo Tool Module
   ========================================================================== */

// Manual alignment state & positioned photo items
let passportManualItems = [];
let passportSelectedId = null;
let passportDragState = null;
let passportAspectRatio = 35 / 45;

function updateRatioBadge() {
  const badge = $('#pp-ratio-badge');
  if (!badge) return;
  const w = +$('#pp-w').value || 35;
  const h = +$('#pp-h').value || 45;
  const r = (h / w).toFixed(2);
  badge.textContent = `Ratio: ${w} : ${h} (1 : ${r})`;
}

function getTodayDateString() {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, '0');
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const year = now.getFullYear();
  return `${day}/${month}/${year}`;
}

function getPassportTextLines(opt) {
  const isUpper = opt.textUpper !== false;
  const formatText = str => (isUpper ? (str || '').toUpperCase() : (str || '')).trim();

  const name = formatText(opt.textName);
  const dateStr = formatText(opt.textDate) || getTodayDateString();
  const custom2 = formatText(opt.textCustom2);

  const lines = [];
  switch (opt.textType) {
    case 'name_dop':
      if (name) lines.push(name);
      lines.push(`DOP: ${dateStr}`);
      break;
    case 'name_dob':
      if (name) lines.push(name);
      lines.push(`DOB: ${dateStr}`);
      break;
    case 'dop':
      lines.push(`DOP: ${dateStr}`);
      break;
    case 'dob':
      lines.push(`DOB: ${dateStr}`);
      break;
    case 'name':
      if (name) lines.push(name);
      break;
    case 'custom':
      if (name) lines.push(name);
      if (custom2) lines.push(custom2);
      break;
  }
  return lines;
}

function renderPassportTextStrip(ctx, lines, pwPx, phPx, opt) {
  if (!lines || lines.length === 0) return;
  const numLines = lines.length;

  const stripH = Math.round(phPx * (numLines === 1 ? 0.135 : 0.22));
  const stripY = phPx - stripH;
  const style = opt.textStyle || 'white_strip';

  ctx.save();

  if (style === 'white_strip') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, stripY, pwPx, stripH);
    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = Math.max(1, Math.round(phPx / 500));
    ctx.beginPath();
    ctx.moveTo(0, stripY);
    ctx.lineTo(pwPx, stripY);
    ctx.stroke();
  } else if (style === 'black_strip') {
    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, stripY, pwPx, stripH);
  } else if (style === 'semi_overlay') {
    ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
    ctx.fillRect(0, stripY, pwPx, stripH);
  } else if (style === 'subtle_box') {
    const pad = Math.round(pwPx * 0.035);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(pad, stripY + pad / 2, pwPx - 2 * pad, stripH - pad);
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1;
    ctx.strokeRect(pad, stripY + pad / 2, pwPx - 2 * pad, stripH - pad);
  }

  const isDarkBg = style === 'black_strip' || style === 'semi_overlay';
  ctx.fillStyle = isDarkBg ? '#ffffff' : '#050505';

  const maxTextW = pwPx * 0.90;
  let fontSize = Math.round(stripH / (numLines === 1 ? 2.0 : 3.0));
  ctx.font = `700 ${fontSize}px "Segoe UI", Roboto, -apple-system, Arial, sans-serif`;

  for (const line of lines) {
    const measuredW = ctx.measureText(line).width;
    if (measuredW > maxTextW && measuredW > 0) {
      fontSize = Math.floor(fontSize * (maxTextW / measuredW));
    }
  }
  ctx.font = `700 ${fontSize}px "Segoe UI", Roboto, -apple-system, Arial, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  if (numLines === 1) {
    ctx.fillText(lines[0], pwPx / 2, stripY + stripH / 2);
  } else {
    const lineSpacing = stripH / 2.3;
    const startLineY = stripY + stripH / 2 - lineSpacing / 2;
    ctx.fillText(lines[0], pwPx / 2, startLineY);
    ctx.fillText(lines[1], pwPx / 2, startLineY + lineSpacing);
  }

  ctx.restore();
}

/**
 * Creates passport photo canvas with crop, adjustments, and bottom text strip.
 */
function createPassportPhotoCanvas(slot, pwPx, phPx) {
  const baseCanvas = createCardCanvas(slot, pwPx, phPx);
  const opt = getPassportOptions();

  if (!opt.textType || opt.textType === 'none') {
    return baseCanvas;
  }

  const lines = getPassportTextLines(opt);
  if (lines.length === 0) {
    return baseCanvas;
  }

  const canvas = document.createElement('canvas');
  canvas.width = pwPx;
  canvas.height = phPx;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(baseCanvas, 0, 0, pwPx, phPx);
  renderPassportTextStrip(ctx, lines, pwPx, phPx, opt);
  return canvas;
}

const passportSlot = {
  id: 'passport',
  el: null,
  drop: null,
  fileInput: null,
  img: null,
  crop: null,
  quad: null,
  srcData: null,
  persp: false,
  filter: { mode: 'none', br: 0, ct: 0, sat: 0, sh: 0, flip: false },
  scale: 1,
  dragMode: null,
  cv: document.createElement('canvas'),
  thumb: null
};
slots['passport'] = passportSlot;

function initPassportPhotoTool() {
  passportSlot.el = $('#pp-photo-card');
  passportSlot.drop = $('#pp-drop');
  passportSlot.fileInput = $('#pp-file');
  passportSlot.thumb = $('#pp-thumb-cv');

  if (!passportSlot.drop) return;

  // Upload trigger
  passportSlot.drop.addEventListener('click', () => passportSlot.fileInput.click());
  passportSlot.drop.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      passportSlot.fileInput.click();
    }
  });

  passportSlot.fileInput.addEventListener('change', () => {
    if (passportSlot.fileInput.files && passportSlot.fileInput.files[0]) {
      loadCardImage(passportSlot, passportSlot.fileInput.files[0]);
    }
  });

  ['dragover', 'dragenter'].forEach(evt => {
    passportSlot.drop.addEventListener(evt, e => {
      e.preventDefault();
      passportSlot.drop.classList.add('over');
    });
  });

  ['dragleave', 'drop'].forEach(evt => {
    passportSlot.drop.addEventListener(evt, e => {
      e.preventDefault();
      passportSlot.drop.classList.remove('over');
    });
  });

  passportSlot.drop.addEventListener('drop', e => {
    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith('image/')) {
      loadCardImage(passportSlot, file);
    }
  });

  bindCanvasEvents(passportSlot);

  // Preset selector
  $('#pp-preset').addEventListener('change', () => {
    const presetVal = $('#pp-preset').value;
    if (presetVal !== 'custom' && PASSPORT_PRESETS[presetVal]) {
      $('#pp-w').value = PASSPORT_PRESETS[presetVal].w;
      $('#pp-h').value = PASSPORT_PRESETS[presetVal].h;
      passportAspectRatio = PASSPORT_PRESETS[presetVal].w / PASSPORT_PRESETS[presetVal].h;
    }
    updateRatioBadge();
    if (passportSlot.img) {
      initDefaultCrop(passportSlot);
      drawPassportThumbnail();
    }
    const opt = getPassportOptions();
    if (opt.alignment === 'manual') {
      const paper = getPassportPaperDimensions();
      passportManualItems = calculateGridPositions(paper.w, paper.h, { ...opt, alignment: 'center' });
    }
    requestPassportPreview();
  });

  // Width input (X dimension) - maintains aspect ratio when locked
  $('#pp-w').addEventListener('input', () => {
    const newW = +$('#pp-w').value;
    const isLocked = $('#pp-lock-ratio') && $('#pp-lock-ratio').checked;
    if (isLocked && passportAspectRatio > 0 && newW > 0) {
      const newH = +(newW / passportAspectRatio).toFixed(1);
      $('#pp-h').value = newH;
    } else if (newW > 0 && +$('#pp-h').value > 0) {
      passportAspectRatio = newW / +$('#pp-h').value;
    }
    $('#pp-preset').value = 'custom';
    updateRatioBadge();
    if (passportSlot.img) {
      initDefaultCrop(passportSlot);
      drawPassportThumbnail();
    }
    const opt = getPassportOptions();
    if (opt.alignment === 'manual') {
      const paper = getPassportPaperDimensions();
      passportManualItems = calculateGridPositions(paper.w, paper.h, { ...opt, alignment: 'center' });
    }
    requestPassportPreview();
  });

  // Height input (Y dimension) - maintains aspect ratio when locked
  $('#pp-h').addEventListener('input', () => {
    const newH = +$('#pp-h').value;
    const isLocked = $('#pp-lock-ratio') && $('#pp-lock-ratio').checked;
    if (isLocked && passportAspectRatio > 0 && newH > 0) {
      const newW = +(newH * passportAspectRatio).toFixed(1);
      $('#pp-w').value = newW;
    } else if (newH > 0 && +$('#pp-w').value > 0) {
      passportAspectRatio = +$('#pp-w').value / newH;
    }
    $('#pp-preset').value = 'custom';
    updateRatioBadge();
    if (passportSlot.img) {
      initDefaultCrop(passportSlot);
      drawPassportThumbnail();
    }
    const opt = getPassportOptions();
    if (opt.alignment === 'manual') {
      const paper = getPassportPaperDimensions();
      passportManualItems = calculateGridPositions(paper.w, paper.h, { ...opt, alignment: 'center' });
    }
    requestPassportPreview();
  });

  // Lock aspect ratio checkbox
  const lockRatioCheck = $('#pp-lock-ratio');
  if (lockRatioCheck) {
    lockRatioCheck.addEventListener('change', () => {
      const w = +$('#pp-w').value;
      const h = +$('#pp-h').value;
      if (w > 0 && h > 0) {
        passportAspectRatio = w / h;
      }
      updateRatioBadge();
    });
  }

  // Synchronizes text field visibility based on chosen text type (DOP, DOB, Name, Custom)
  function syncPassportTextControls() {
    const type = $('#pp-text-type') ? $('#pp-text-type').value : 'none';
    const fieldsWrap = $('#pp-text-fields-wrap');
    const nameWrap = $('#pp-name-wrap');
    const dateWrap = $('#pp-date-wrap');
    const dateLabel = $('#pp-date-label');
    const custom2Wrap = $('#pp-custom2-wrap');

    if (!fieldsWrap) return;
    if (type === 'none') {
      fieldsWrap.style.display = 'none';
      return;
    }
    fieldsWrap.style.display = 'grid';

    if (type === 'dob' || type === 'dop') {
      nameWrap.style.display = 'none';
    } else {
      nameWrap.style.display = 'block';
    }

    if (type === 'name') {
      dateWrap.style.display = 'none';
    } else {
      dateWrap.style.display = 'flex';
      if (type.includes('dob')) {
        dateLabel.textContent = 'Date of Birth (DOB)';
      } else if (type.includes('dop')) {
        dateLabel.textContent = 'Date of Photo (DOP)';
      } else {
        dateLabel.textContent = 'Date';
      }
    }

    if (type === 'custom') {
      custom2Wrap.style.display = 'block';
    } else {
      custom2Wrap.style.display = 'none';
    }
  }

  // Pre-fill initial date with today's date
  const textDateInput = $('#pp-text-date');
  if (textDateInput && !textDateInput.value) {
    textDateInput.value = getTodayDateString();
  }

  // Text inputs & formatting listeners
  ['pp-text-type', 'pp-text-style', 'pp-text-upper'].forEach(id => {
    const el = $('#' + id);
    if (el) {
      el.addEventListener('change', () => {
        syncPassportTextControls();
        drawPassportThumbnail();
        requestPassportPreview();
      });
    }
  });

  ['pp-text-name', 'pp-text-date', 'pp-text-custom2'].forEach(id => {
    const el = $('#' + id);
    if (el) {
      el.addEventListener('input', () => {
        drawPassportThumbnail();
        requestPassportPreview();
      });
    }
  });

  const datePicker = $('#pp-date-picker');
  if (datePicker) {
    datePicker.addEventListener('change', () => {
      if (datePicker.value) {
        const [y, m, d] = datePicker.value.split('-');
        if ($('#pp-text-date')) $('#pp-text-date').value = `${d}/${m}/${y}`;
        drawPassportThumbnail();
        requestPassportPreview();
      }
    });
  }

  const todayBtn = $('#pp-today-btn');
  if (todayBtn) {
    todayBtn.addEventListener('click', () => {
      const todayStr = getTodayDateString();
      if ($('#pp-text-date')) $('#pp-text-date').value = todayStr;
      const now = new Date();
      if (datePicker) datePicker.value = now.toISOString().split('T')[0];
      drawPassportThumbnail();
      requestPassportPreview();
    });
  }

  // Paper & layout inputs
  ['pp-paper', 'pp-orient', 'pp-gap', 'pp-margin', 'pp-border', 'pp-border-style', 'pp-align'].forEach(id => {
    const el = $('#' + id);
    if (el) el.addEventListener('input', requestPassportPreview);
  });

  // Alignment dropdown handler
  const alignSelect = $('#pp-align');
  if (alignSelect) {
    alignSelect.addEventListener('change', () => {
      const isManual = alignSelect.value === 'manual';
      const manualBox = $('#pp-manual-controls');
      if (isManual) {
        const opt = getPassportOptions();
        const paper = getPassportPaperDimensions();
        if (passportManualItems.length === 0) {
          passportManualItems = calculateGridPositions(paper.w, paper.h, { ...opt, alignment: 'center' });
        }
        if (manualBox) manualBox.style.display = 'block';
      } else {
        if (manualBox) manualBox.style.display = 'none';
      }
      requestPassportPreview();
    });
  }

  // Quick toggle mode badge in preview sidebar
  const modeBadge = $('#pp-mode-badge');
  if (modeBadge) {
    modeBadge.addEventListener('click', () => {
      const sel = $('#pp-align');
      if (!sel) return;
      if (sel.value === 'manual') {
        sel.value = 'center';
      } else {
        const opt = getPassportOptions();
        const paper = getPassportPaperDimensions();
        passportManualItems = calculateGridPositions(paper.w, paper.h, opt);
        sel.value = 'manual';
      }
      requestPassportPreview();
    });
  }

  // Clamp manual photos when paper size or orientation changes
  ['pp-paper', 'pp-orient'].forEach(id => {
    const el = $('#' + id);
    if (el) {
      el.addEventListener('change', () => {
        const opt = getPassportOptions();
        const paper = getPassportPaperDimensions();
        if (opt.alignment === 'manual' && passportManualItems.length > 0) {
          passportManualItems.forEach(it => {
            it.x = Math.max(0, Math.min(paper.w - opt.photoWidth, it.x));
            it.y = Math.max(0, Math.min(paper.h - opt.photoHeight, it.y));
          });
        }
      });
    }
  });

  // Manual layout action buttons
  const addPhotoBtn = $('#pp-add-photo');
  if (addPhotoBtn) {
    addPhotoBtn.addEventListener('click', () => {
      const opt = getPassportOptions();
      const paper = getPassportPaperDimensions();
      if (opt.alignment !== 'manual') {
        passportManualItems = calculateGridPositions(paper.w, paper.h, opt);
        if ($('#pp-align')) $('#pp-align').value = 'manual';
      }
      const nextId = (passportManualItems.reduce((max, it) => Math.max(max, it.id), 0) || 0) + 1;
      const offset = (passportManualItems.length % 6) * 4;
      const newX = Math.max(0, Math.min(paper.w - opt.photoWidth, opt.margin + offset));
      const newY = Math.max(0, Math.min(paper.h - opt.photoHeight, opt.margin + offset));
      passportManualItems.push({ id: nextId, x: newX, y: newY });
      passportSelectedId = nextId;
      requestPassportPreview();
    });
  }

  const delPhotoBtn = $('#pp-del-photo');
  if (delPhotoBtn) {
    delPhotoBtn.addEventListener('click', () => {
      if (passportManualItems.length === 0) return;
      if (passportSelectedId !== null) {
        passportManualItems = passportManualItems.filter(it => it.id !== passportSelectedId);
        passportSelectedId = null;
      } else {
        passportManualItems.pop();
      }
      requestPassportPreview();
    });
  }

  const resetLayoutBtn = $('#pp-reset-layout');
  if (resetLayoutBtn) {
    resetLayoutBtn.addEventListener('click', () => {
      const opt = getPassportOptions();
      const paper = getPassportPaperDimensions();
      passportManualItems = calculateGridPositions(paper.w, paper.h, { ...opt, alignment: 'center' });
      passportSelectedId = null;
      requestPassportPreview();
    });
  }

  const snapGridCheck = $('#pp-snap-grid');
  if (snapGridCheck) {
    snapGridCheck.addEventListener('change', requestPassportPreview);
  }

  $('#pp-count-mode').addEventListener('change', () => {
    const isCustom = $('#pp-count-mode').value === 'custom';
    $('#pp-count-wrapper').style.display = isCustom ? 'grid' : 'none';
    requestPassportPreview();
  });

  $('#pp-count').addEventListener('input', requestPassportPreview);

  // Adjustments & sliders
  ['pp-br', 'pp-ct', 'pp-sat', 'pp-sh'].forEach(id => {
    const key = id.replace('pp-', '');
    $('#' + id).addEventListener('input', e => {
      passportSlot.filter[key] = +e.target.value;
      drawPassportThumbnail();
      requestPassportPreview();
      if (previewModalState.isOpen && (previewModalState.target === 'pp-photo' || previewModalState.target === 'pp-sheet')) {
        renderPreviewCanvas();
      }
    });
  });

  // Mode buttons
  document.querySelectorAll('#pp-modes button').forEach(btn => {
    btn.addEventListener('click', () => {
      passportSlot.filter.mode = btn.dataset.mode;
      document.querySelectorAll('#pp-modes button').forEach(b =>
        b.setAttribute('aria-pressed', b.dataset.mode === passportSlot.filter.mode)
      );
      drawPassportThumbnail();
      requestPassportPreview();
      if (previewModalState.isOpen) renderPreviewCanvas();
    });
  });

  // Rotate, flip, reset edits
  $('#pp-rot-cw').addEventListener('click', () => rotateSlot(passportSlot));
  $('#pp-flip').addEventListener('click', () => {
    passportSlot.filter.flip = !passportSlot.filter.flip;
    drawPassportThumbnail();
    requestPassportPreview();
    if (previewModalState.isOpen) renderPreviewCanvas();
  });

  $('#pp-reset-edits').addEventListener('click', () => {
    passportSlot.filter = { mode: 'none', br: 0, ct: 0, sat: 0, sh: 0, flip: false };
    ['pp-br', 'pp-ct', 'pp-sat', 'pp-sh'].forEach(id => { $('#' + id).value = 0; });
    document.querySelectorAll('#pp-modes button').forEach(b =>
      b.setAttribute('aria-pressed', b.dataset.mode === 'none')
    );
    drawPassportThumbnail();
    requestPassportPreview();
    if (previewModalState.isOpen) renderPreviewCanvas();
  });

  // Actions
  $('#pp-edit-crop').addEventListener('click', () => openModalEditor(passportSlot));
  $('#pp-crop-btn').addEventListener('click', () => openModalEditor(passportSlot));

  $('#pp-clear-photo').addEventListener('click', () => {
    passportSlot.img = null;
    passportSlot.crop = null;
    passportSlot.fileInput.value = '';
    $('#pp-editor-box').style.display = 'none';
    $('#pp-photo-actions').style.display = 'none';
    passportSlot.drop.style.display = 'grid';
    requestPassportPreview();
  });

  // Full-screen triggers
  $('#pp-fs-photo').addEventListener('click', () => {
    if (passportSlot.img) openPreviewModal('pp-photo');
  });
  $('#pp-preview-btn').addEventListener('click', () => {
    if (passportSlot.img) openPreviewModal('pp-photo');
  });
  $('#pp-thumb-cv').addEventListener('click', () => {
    if (passportSlot.img) openPreviewModal('pp-photo');
  });

  $('#pp-fs-sheet').addEventListener('click', () => openPreviewModal('pp-sheet'));
  // Double-clicking sheet opens full screen, single-click/drag moves photos
  $('#pp-sheet').addEventListener('dblclick', () => openPreviewModal('pp-sheet'));

  // Export & Print buttons
  $('#pp-print').addEventListener('click', printPassportPhotos);
  $('#pp-pdf').addEventListener('click', exportPassportPdf);
  $('#pp-jpg').addEventListener('click', exportPassportJpeg);
  $('#pp-single').addEventListener('click', exportSinglePassportPhoto);

  // Initialize interactive drag-and-drop & manual placement
  bindPassportSheetDragEvents();
}

function drawPassportThumbnail() {
  if (!passportSlot.img) return;
  const opt = getPassportOptions();
  const width = 280;
  const height = Math.round(width / opt.aspectRatio);
  const rendered = createPassportPhotoCanvas(passportSlot, width, height);

  const thumbCv = $('#pp-thumb-cv');
  thumbCv.width = width;
  thumbCv.height = height;
  const ctx = thumbCv.getContext('2d');
  ctx.drawImage(rendered, 0, 0);
}

/**
 * Calculates physical layout coordinates for grid-based photo alignment.
 */
function calculateGridPositions(paperW, paperH, opt) {
  const grid = calculateMaxGridCount(paperW, paperH, opt);
  const maxPhotos = grid.total;
  const countToDraw = opt.countMode === 'fill' ? maxPhotos : Math.min(opt.customCount, maxPhotos);
  if (grid.cols <= 0 || grid.rows <= 0 || countToDraw <= 0) return [];

  const activeCols = Math.min(grid.cols, countToDraw);
  const activeRows = Math.ceil(countToDraw / grid.cols);
  const gridW = activeCols * opt.photoWidth + (activeCols - 1) * opt.gap;
  const gridH = activeRows * opt.photoHeight + (activeRows - 1) * opt.gap;

  let startX = (paperW - gridW) / 2;
  let startY = (paperH - gridH) / 2;

  switch (opt.alignment) {
    case 'top-left':
      startX = opt.margin;
      startY = opt.margin;
      break;
    case 'top-center':
      startX = (paperW - gridW) / 2;
      startY = opt.margin;
      break;
    case 'top-right':
      startX = Math.max(opt.margin, paperW - opt.margin - gridW);
      startY = opt.margin;
      break;
    case 'bottom-left':
      startX = opt.margin;
      startY = Math.max(opt.margin, paperH - opt.margin - gridH);
      break;
    case 'bottom-center':
      startX = (paperW - gridW) / 2;
      startY = Math.max(opt.margin, paperH - opt.margin - gridH);
      break;
    case 'bottom-right':
      startX = Math.max(opt.margin, paperW - opt.margin - gridW);
      startY = Math.max(opt.margin, paperH - opt.margin - gridH);
      break;
    case 'center':
    default:
      startX = (paperW - gridW) / 2;
      startY = (paperH - gridH) / 2;
      break;
  }

  const items = [];
  for (let i = 0; i < countToDraw; i++) {
    const r = Math.floor(i / grid.cols);
    const c = i % grid.cols;
    items.push({
      id: i + 1,
      x: startX + c * (opt.photoWidth + opt.gap),
      y: startY + r * (opt.photoHeight + opt.gap)
    });
  }
  return items;
}

/**
 * Returns active photo positions (from manual free placement or aligned auto grid).
 */
function getEffectivePassportPositions(paper, opt) {
  if (opt.alignment === 'manual') {
    if (passportManualItems.length === 0) {
      passportManualItems = calculateGridPositions(paper.w, paper.h, { ...opt, alignment: 'center' });
    }
    return passportManualItems;
  }
  return calculateGridPositions(paper.w, paper.h, opt);
}

/**
 * Composes multi-photo passport layout onto the target canvas with alignment and manual placement.
 */
function composePassportSheet(canvas, dpi, isPreview) {
  const opt = getPassportOptions();
  const paper = getPassportPaperDimensions();
  const px = dpi / 25.4;
  const W = Math.round(paper.w * px);
  const H = Math.round(paper.h * px);

  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  const isManual = opt.alignment === 'manual';
  const items = getEffectivePassportPositions(paper, opt);
  const countToDraw = items.length;

  // Format alignment label for UI badge
  const alignLabel = isManual
    ? 'Manual placement'
    : (opt.alignment === 'center' ? 'Centered grid' : opt.alignment.replace('-', ' ') + ' grid');

  // Update badge summary
  $('#pp-layout-summary').innerHTML = `<b>${countToDraw} photo${countToDraw !== 1 ? 's' : ''}</b> on ${paper.name} <span style="font-size:11px;opacity:0.85;">(${alignLabel})</span>`;
  $('#pp-dpi-summary').textContent = `${dpi} DPI · ${Math.round(paper.w)} × ${Math.round(paper.h)} mm`;

  const modeBadge = $('#pp-mode-badge');
  if (modeBadge) {
    modeBadge.textContent = isManual ? 'MANUAL' : 'GRID';
    if (isManual) modeBadge.classList.add('manual');
    else modeBadge.classList.remove('manual');
  }

  const manualBox = $('#pp-manual-controls');
  if (manualBox) {
    manualBox.style.display = isManual ? 'block' : 'none';
  }

  const selInfo = $('#pp-selected-info');
  if (selInfo && isManual) {
    if (passportSelectedId !== null) {
      const cur = items.find(it => it.id === passportSelectedId);
      if (cur) {
        selInfo.innerHTML = `Selected: <b>Photo #${cur.id}</b> (${cur.x.toFixed(1)} × ${cur.y.toFixed(1)} mm)`;
      } else {
        selInfo.textContent = 'Click any photo on sheet to select & nudge';
      }
    } else {
      selInfo.textContent = 'Click any photo on sheet to select & nudge';
    }
  }

  if (countToDraw <= 0) {
    ctx.fillStyle = '#8a96a1';
    ctx.font = `${Math.round(20 * (dpi / 100))}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Photo size exceeds page margins', W / 2, H / 2);
    return;
  }

  let photoCanvas = null;
  const pwPx = Math.round(opt.photoWidth * px);
  const phPx = Math.round(opt.photoHeight * px);
  if (passportSlot.img) {
    photoCanvas = createPassportPhotoCanvas(passportSlot, pwPx, phPx);
  }

  // Draw alignment crosshairs if previewing and actively dragging near center
  if (isPreview && passportDragState && passportDragState.active) {
    const draggingItem = items.find(it => it.id === passportDragState.id);
    if (draggingItem) {
      const centerX = draggingItem.x + opt.photoWidth / 2;
      const centerY = draggingItem.y + opt.photoHeight / 2;
      ctx.save();
      ctx.strokeStyle = 'rgba(9, 105, 218, 0.45)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      if (Math.abs(centerX - paper.w / 2) < 2) {
        ctx.beginPath();
        ctx.moveTo(Math.round((paper.w / 2) * px), 0);
        ctx.lineTo(Math.round((paper.w / 2) * px), H);
        ctx.stroke();
      }
      if (Math.abs(centerY - paper.h / 2) < 2) {
        ctx.beginPath();
        ctx.moveTo(0, Math.round((paper.h / 2) * px));
        ctx.lineTo(W, Math.round((paper.h / 2) * px));
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  for (let i = 0; i < countToDraw; i++) {
    const it = items[i];
    const posX = Math.round(it.x * px);
    const posY = Math.round(it.y * px);

    if (photoCanvas) {
      ctx.drawImage(photoCanvas, posX, posY, pwPx, phPx);
    } else if (isPreview) {
      ctx.save();
      ctx.strokeStyle = '#b5bcc3';
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.2;
      ctx.strokeRect(posX, posY, pwPx, phPx);
      ctx.fillStyle = '#8a96a1';
      ctx.font = `${Math.round(pwPx / 10)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Passport', posX + pwPx / 2, posY + phPx / 2 - 8);
      ctx.fillText(`${opt.photoWidth}×${opt.photoHeight}mm`, posX + pwPx / 2, posY + phPx / 2 + 10);
      ctx.restore();
    }

    if (opt.hasBorder) {
      ctx.save();
      if (opt.borderStyle === 'light') {
        ctx.strokeStyle = '#b5bcc3';
        ctx.lineWidth = Math.max(1, 0.3 * px);
        ctx.strokeRect(posX, posY, pwPx, phPx);
      } else if (opt.borderStyle === 'black') {
        ctx.strokeStyle = '#111111';
        ctx.lineWidth = Math.max(1, 0.45 * px);
        ctx.strokeRect(posX, posY, pwPx, phPx);
      } else if (opt.borderStyle === 'white') {
        const bPad = 1.2 * px;
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = bPad * 2;
        ctx.strokeRect(posX + bPad, posY + bPad, pwPx - 2 * bPad, phPx - 2 * bPad);
        ctx.strokeStyle = '#d0d7de';
        ctx.lineWidth = 1;
        ctx.strokeRect(posX, posY, pwPx, phPx);
      }
      ctx.restore();
    }

    // High-visibility selection highlight with corner grab handles in preview mode
    if (isPreview && isManual && it.id === passportSelectedId) {
      ctx.save();
      ctx.strokeStyle = '#0969da';
      ctx.lineWidth = Math.max(2, 1.8 * (dpi / 100));
      ctx.setLineDash([]);
      ctx.strokeRect(posX, posY, pwPx, phPx);

      const handleSize = Math.max(6, Math.round(5 * (dpi / 100)));
      ctx.fillStyle = '#ffffff';
      ctx.strokeStyle = '#0969da';
      ctx.lineWidth = 1.5;
      const corners = [
        [posX, posY],
        [posX + pwPx, posY],
        [posX, posY + phPx],
        [posX + pwPx, posY + phPx]
      ];
      corners.forEach(([cx, cy]) => {
        ctx.fillRect(cx - handleSize / 2, cy - handleSize / 2, handleSize, handleSize);
        ctx.strokeRect(cx - handleSize / 2, cy - handleSize / 2, handleSize, handleSize);
      });
      ctx.restore();
    }
  }
}

/**
 * Handles mouse and touch drag-and-drop movement of passport photos directly on the print sheet canvas.
 */
function bindPassportSheetDragEvents() {
  const canvas = $('#pp-sheet');
  const tooltip = $('#pp-drag-tooltip');
  if (!canvas) return;

  function getPointerMm(e) {
    const paper = getPassportPaperDimensions();
    const rect = canvas.getBoundingClientRect();
    const clientX = e.touches && e.touches.length > 0 ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches && e.touches.length > 0 ? e.touches[0].clientY : e.clientY;
    const relX = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
    const relY = Math.max(0, Math.min(1, (clientY - rect.top) / rect.height));
    return {
      mmX: relX * paper.w,
      mmY: relY * paper.h,
      clientX,
      clientY,
      rect
    };
  }

  function startDrag(e) {
    const opt = getPassportOptions();
    const paper = getPassportPaperDimensions();
    const { mmX, mmY, clientX, clientY, rect } = getPointerMm(e);

    const items = getEffectivePassportPositions(paper, opt);

    // Hit test from uppermost photo downward
    let hit = null;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      if (
        mmX >= it.x &&
        mmX <= it.x + opt.photoWidth &&
        mmY >= it.y &&
        mmY <= it.y + opt.photoHeight
      ) {
        hit = it;
        break;
      }
    }

    if (hit) {
      // Auto-transition from grid to manual mode upon dragging
      if (opt.alignment !== 'manual') {
        passportManualItems = items.map(it => ({ ...it }));
        const alignEl = $('#pp-align');
        if (alignEl) alignEl.value = 'manual';
        const manualBox = $('#pp-manual-controls');
        if (manualBox) manualBox.style.display = 'block';
        const modeBadge = $('#pp-mode-badge');
        if (modeBadge) {
          modeBadge.textContent = 'MANUAL';
          modeBadge.classList.add('manual');
        }
        hit = passportManualItems.find(it => it.id === hit.id) || passportManualItems[0];
      }

      passportSelectedId = hit.id;
      passportDragState = {
        active: true,
        id: hit.id,
        startMmX: mmX,
        startMmY: mmY,
        itemStartX: hit.x,
        itemStartY: hit.y
      };

      canvas.classList.add('is-dragging');
      if (tooltip) {
        tooltip.style.display = 'block';
        tooltip.textContent = `X: ${hit.x.toFixed(1)} mm, Y: ${hit.y.toFixed(1)} mm`;
        tooltip.style.left = `${clientX - rect.left}px`;
        tooltip.style.top = `${clientY - rect.top}px`;
      }
      requestPassportPreview();
      e.preventDefault();
    } else {
      if (passportSelectedId !== null) {
        passportSelectedId = null;
        requestPassportPreview();
      }
    }
  }

  function moveDrag(e) {
    const opt = getPassportOptions();
    const paper = getPassportPaperDimensions();
    const { mmX, mmY, clientX, clientY, rect } = getPointerMm(e);

    if (passportDragState && passportDragState.active) {
      const item = passportManualItems.find(it => it.id === passportDragState.id);
      if (item) {
        const dx = mmX - passportDragState.startMmX;
        const dy = mmY - passportDragState.startMmY;
        let newX = passportDragState.itemStartX + dx;
        let newY = passportDragState.itemStartY + dy;

        const isSnap = $('#pp-snap-grid') && $('#pp-snap-grid').checked;
        if (isSnap) {
          newX = Math.round(newX / 2) * 2;
          newY = Math.round(newY / 2) * 2;
        }

        // Clamp inside paper bounds
        newX = Math.max(0, Math.min(paper.w - opt.photoWidth, newX));
        newY = Math.max(0, Math.min(paper.h - opt.photoHeight, newY));

        item.x = newX;
        item.y = newY;

        if (tooltip) {
          tooltip.style.display = 'block';
          tooltip.textContent = `X: ${newX.toFixed(1)} mm, Y: ${newY.toFixed(1)} mm`;
          tooltip.style.left = `${clientX - rect.left}px`;
          tooltip.style.top = `${clientY - rect.top}px`;
        }

        requestPassportPreview();
      }
      e.preventDefault();
    } else {
      // Hover cursor feedback
      const items = getEffectivePassportPositions(paper, opt);
      let isOver = false;
      for (let i = items.length - 1; i >= 0; i--) {
        const it = items[i];
        if (
          mmX >= it.x &&
          mmX <= it.x + opt.photoWidth &&
          mmY >= it.y &&
          mmY <= it.y + opt.photoHeight
        ) {
          isOver = true;
          break;
        }
      }
      canvas.style.cursor = isOver ? 'grab' : 'default';
    }
  }

  function endDrag() {
    if (passportDragState && passportDragState.active) {
      passportDragState = null;
      canvas.classList.remove('is-dragging');
      if (tooltip) tooltip.style.display = 'none';
      requestPassportPreview();
    }
  }

  canvas.addEventListener('mousedown', startDrag);
  window.addEventListener('mousemove', moveDrag);
  window.addEventListener('mouseup', endDrag);

  canvas.addEventListener('touchstart', startDrag, { passive: false });
  window.addEventListener('touchmove', moveDrag, { passive: false });
  window.addEventListener('touchend', endDrag);
  window.addEventListener('touchcancel', endDrag);

  // Keyboard micro-nudge & delete keys for selected photo
  window.addEventListener('keydown', e => {
    if (passportSelectedId === null) return;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement.tagName)) return;

    const opt = getPassportOptions();
    if (opt.alignment !== 'manual') return;

    const item = passportManualItems.find(it => it.id === passportSelectedId);
    if (!item) return;

    const paper = getPassportPaperDimensions();
    const step = e.shiftKey ? 5 : (e.altKey ? 0.2 : 1);

    if (e.key === 'ArrowLeft') {
      item.x = Math.max(0, item.x - step);
      e.preventDefault();
      requestPassportPreview();
    } else if (e.key === 'ArrowRight') {
      item.x = Math.min(paper.w - opt.photoWidth, item.x + step);
      e.preventDefault();
      requestPassportPreview();
    } else if (e.key === 'ArrowUp') {
      item.y = Math.max(0, item.y - step);
      e.preventDefault();
      requestPassportPreview();
    } else if (e.key === 'ArrowDown') {
      item.y = Math.min(paper.h - opt.photoHeight, item.y + step);
      e.preventDefault();
      requestPassportPreview();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      passportManualItems = passportManualItems.filter(it => it.id !== passportSelectedId);
      passportSelectedId = null;
      e.preventDefault();
      requestPassportPreview();
    }
  });
}

function requestPassportPreview() {
  if (passportPreviewRafId) cancelAnimationFrame(passportPreviewRafId);
  passportPreviewRafId = requestAnimationFrame(() => {
    composePassportSheet($('#pp-sheet'), 100, true);
    if (previewModalState.isOpen && previewModalState.target === 'pp-sheet') {
      renderPreviewCanvas();
    }
    passportPreviewRafId = null;
  });
}

function printPassportPhotos() {
  if (!passportSlot.img) {
    alert('Please upload a passport photo first.');
    return;
  }
  executeWithLoading('#pp-print', async () => {
    const paper = getPassportPaperDimensions();
    const c = document.createElement('canvas');
    composePassportSheet(c, 200, false);

    const printImg = $('#printImg');
    printImg.src = c.toDataURL('image/jpeg', 0.95);
    await printImg.decode().catch(() => {});

    let styleEl = $('#print-page-style');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'print-page-style';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = `
      @media print {
        @page { size: ${paper.w}mm ${paper.h}mm; margin: 0; }
        #printImg { width: ${paper.w}mm !important; height: ${paper.h}mm !important; }
      }
    `;
    window.print();
  });
}

function exportPassportPdf() {
  executeWithLoading('#pp-pdf', async () => {
    if (!window.jspdf) {
      alert('The PDF library did not load. Please download as JPEG instead.');
      return;
    }
    const paper = getPassportPaperDimensions();
    const c = document.createElement('canvas');
    composePassportSheet(c, 300, false);

    const { jsPDF } = window.jspdf;
    const orientation = paper.w > paper.h ? 'l' : 'p';
    const pdf = new jsPDF({
      unit: 'mm',
      format: [paper.w, paper.h],
      orientation,
      compress: true
    });
    pdf.addImage(c.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, paper.w, paper.h, undefined, 'FAST');
    const blob = pdf.output('blob');
    saveBlobFile(blob, `passport-photos-${paper.name.replace(/\s+/g, '_')}.pdf`);
  });
}

function exportPassportJpeg() {
  executeWithLoading('#pp-jpg', async () => {
    const paper = getPassportPaperDimensions();
    const c = document.createElement('canvas');
    composePassportSheet(c, 300, false);
    const blob = await canvasToBlob(c, 'image/jpeg', 0.95);
    saveBlobFile(blob, `passport-photos-${paper.name.replace(/\s+/g, '_')}.jpg`);
  });
}

function exportSinglePassportPhoto() {
  if (!passportSlot.img) {
    alert('Please upload a passport photo first.');
    return;
  }
  executeWithLoading('#pp-single', async () => {
    const opt = getPassportOptions();
    const px = 300 / 25.4;
    const w = Math.round(opt.photoWidth * px);
    const h = Math.round(opt.photoHeight * px);
    const c = createPassportPhotoCanvas(passportSlot, w, h);
    const blob = await canvasToBlob(c, 'image/jpeg', 0.98);
    saveBlobFile(blob, `passport-photo-${opt.photoWidth}x${opt.photoHeight}mm.jpg`);
  });
}

/* ==========================================================================
   10. Shared Utility Functions
   ========================================================================== */

const formatFileSize = bytes =>
  bytes >= 1048576
    ? (bytes / 1048576).toFixed(2) + ' MB'
    : (bytes / 1024).toFixed(1) + ' KB';

const canvasToBlob = (canvas, type, quality) =>
  new Promise(resolve => canvas.toBlob(resolve, type, quality));

const yieldEventLoop = () => new Promise(resolve => setTimeout(resolve, 0));

const updateStatusText = (element, text) => {
  element.textContent = text;
};

function setButtonBusy(selector, isBusy) {
  const btn = $(selector);
  if (!btn) return;
  if (isBusy) {
    btn.dataset.originalText = btn.textContent;
    btn.textContent = 'Working…';
  } else {
    btn.textContent = btn.dataset.originalText || btn.textContent;
  }
  btn.disabled = isBusy;
}

async function saveBlobFile(blob, filename) {
  try {
    const claudeDownloads = window.claude && (await claude.use('downloads'));
    if (claudeDownloads) {
      await claudeDownloads.save({ filename, data: blob });
      return;
    }
  } catch (err) {
    if (err && err.code === 'declined') return;
  }

  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60000);
}

async function fileToCanvas(file) {
  const bitmap = await createImageBitmap(file).catch(() => null);
  const source =
    bitmap ||
    (await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Could not read file: ' + file.name));
      img.src = URL.createObjectURL(file);
    }));

  const canvas = document.createElement('canvas');
  canvas.width = source.width || source.naturalWidth;
  canvas.height = source.height || source.naturalHeight;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(source, 0, 0);

  if (source.src) {
    URL.revokeObjectURL(source.src);
  }
  return canvas;
}

async function compressJpegToTarget(canvas, targetKB) {
  const byteLimit = targetKB * 1024;
  let currentCanvas = canvas;

  for (let pass = 0; pass < 8; pass++) {
    let blob = await canvasToBlob(currentCanvas, 'image/jpeg', 0.92);
    if (blob.size <= byteLimit) return blob;

    let low = 0.05;
    let high = 0.92;
    let bestBlob = null;
    for (let i = 0; i < 7; i++) {
      const mid = (low + high) / 2;
      blob = await canvasToBlob(currentCanvas, 'image/jpeg', mid);
      if (blob.size <= byteLimit) {
        bestBlob = blob;
        low = mid;
      } else {
        high = mid;
      }
    }
    if (bestBlob) return bestBlob;

    const scaledCanvas = document.createElement('canvas');
    scaledCanvas.width = Math.max(50, Math.round(currentCanvas.width * 0.8));
    scaledCanvas.height = Math.max(50, Math.round(currentCanvas.height * 0.8));
    const ctx = scaledCanvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, scaledCanvas.width, scaledCanvas.height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(currentCanvas, 0, 0, scaledCanvas.width, scaledCanvas.height);
    currentCanvas = scaledCanvas;
    await yieldEventLoop();
  }

  return canvasToBlob(currentCanvas, 'image/jpeg', 0.05);
}

function convertPagesToPdf(pages, quality) {
  const { jsPDF } = window.jspdf;
  let pdf = null;

  pages.forEach(page => {
    const orientation = page.w > page.h ? 'l' : 'p';
    const format = [Math.min(page.w, page.h), Math.max(page.w, page.h)];
    if (!pdf) {
      pdf = new jsPDF({ unit: 'mm', format, orientation, compress: true });
    } else {
      pdf.addPage(format, orientation);
    }
    const box = page.box || [0, 0, page.w, page.h];
    pdf.addImage(
      page.c.toDataURL('image/jpeg', quality),
      'JPEG',
      box[0],
      box[1],
      box[2],
      box[3],
      undefined,
      'FAST'
    );
  });

  return pdf.output('blob');
}

function rescalePages(pages, factor) {
  return pages.map(p => {
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(50, Math.round(p.c.width * factor));
    canvas.height = Math.max(50, Math.round(p.c.height * factor));
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(p.c, 0, 0, canvas.width, canvas.height);
    return { ...p, c: canvas };
  });
}

async function compressPdfToTarget(pages, targetKB) {
  const byteLimit = targetKB * 1024;
  let currentPages = pages;

  for (let pass = 0; pass < 7; pass++) {
    let blob = convertPagesToPdf(currentPages, 0.9);
    if (blob.size <= byteLimit) return blob;

    let low = 0.08;
    let high = 0.9;
    let bestBlob = null;
    for (let i = 0; i < 6; i++) {
      await yieldEventLoop();
      const mid = (low + high) / 2;
      blob = convertPagesToPdf(currentPages, mid);
      if (blob.size <= byteLimit) {
        bestBlob = blob;
        low = mid;
      } else {
        high = mid;
      }
    }
    if (bestBlob) return bestBlob;

    currentPages = rescalePages(currentPages, 0.8);
    await yieldEventLoop();
  }

  return convertPagesToPdf(currentPages, 0.08);
}

async function extractPdfPages(file, dpi, progressCallback) {
  if (!window.pdfjsLib) {
    throw new Error('PDF reader library did not load. Please check your internet connection.');
  }
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

  const fileData = await file.arrayBuffer();
  const pdfDoc = await pdfjsLib.getDocument({ data: fileData }).promise;
  const renderedPages = [];

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    if (progressCallback) {
      progressCallback(`Reading page ${pageNum} of ${pdfDoc.numPages}…`);
    }

    const page = await pdfDoc.getPage(pageNum);
    const baseViewport = page.getViewport({ scale: 1 });
    let scale = dpi / 72;
    const totalPixels = baseViewport.width * baseViewport.height * scale * scale;
    if (totalPixels > 16e6) {
      scale *= Math.sqrt(16e6 / totalPixels);
    }

    const scaledViewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(scaledViewport.width);
    canvas.height = Math.ceil(scaledViewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    await page.render({ canvasContext: ctx, viewport: scaledViewport }).promise;
    renderedPages.push({
      c: canvas,
      w: (baseViewport.width * 25.4) / 72,
      h: (baseViewport.height * 25.4) / 72
    });
    await yieldEventLoop();
  }

  return renderedPages;
}

function createPdfPageLayout(canvas, fitMode) {
  if (fitMode === 'img') {
    return {
      c: canvas,
      w: (canvas.width * 25.4) / 150,
      h: (canvas.height * 25.4) / 150
    };
  }
  const isLandscape = canvas.width > canvas.height;
  const pageWidth = isLandscape ? 297 : 210;
  const pageHeight = isLandscape ? 210 : 297;
  const scale = Math.min(pageWidth / canvas.width, pageHeight / canvas.height);
  const imgW = canvas.width * scale;
  const imgH = canvas.height * scale;

  return {
    c: canvas,
    w: pageWidth,
    h: pageHeight,
    box: [(pageWidth - imgW) / 2, (pageHeight - imgH) / 2, imgW, imgH]
  };
}

const isPdfFile = f => /pdf/i.test(f.type) || /\.pdf$/i.test(f.name);
const getFileStem = f => f.name.replace(/\.[^.]+$/, '');

function appendResultRow(container, blob, filename, extraInfo) {
  const row = document.createElement('div');
  row.className = 'res';

  const label = document.createElement('span');
  label.textContent = `${filename} · ${formatFileSize(blob.size)}${extraInfo ? ' · ' + extraInfo : ''}`;

  const downloadBtn = document.createElement('button');
  downloadBtn.className = 'primary';
  downloadBtn.textContent = 'Download';
  downloadBtn.addEventListener('click', () => saveBlobFile(blob, filename));

  row.append(label, downloadBtn);
  container.append(row);
}

function addDownloadAllButton(container, items, label) {
  if (items.length <= 1) return;

  const row = document.createElement('div');
  row.className = 'res batch-header';

  const title = document.createElement('span');
  title.innerHTML = `<b>${items.length} ${label || 'files ready'}</b>`;

  const btn = document.createElement('button');
  btn.className = 'primary';
  btn.textContent = `Download all (${items.length})`;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    for (let i = 0; i < items.length; i++) {
      btn.textContent = `Saving ${i + 1}/${items.length}…`;
      await saveBlobFile(items[i].blob, items[i].name);
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    btn.textContent = 'Downloaded all';
    btn.disabled = false;
  });

  row.append(title, btn);
  container.prepend(row);
}

/* ==========================================================================
   11. Multi-file Dropzone Initializers (Convert & Compress)
   ========================================================================== */

const selectedFilesStore = { cv: [], cp: [] };

function setupDropzone(prefix, allowMultiple) {
  const dropzone = $(`#${prefix}-drop`);
  const fileInput = $(`#${prefix}-file`);
  if (!dropzone || !fileInput) return;

  const updateSelectionUI = files => {
    selectedFilesStore[prefix] = allowMultiple ? files : files.slice(0, 1);
    const container = document.createElement('div');
    const boldText = document.createElement('b');
    const count = selectedFilesStore[prefix].length;

    if (count === 1) {
      boldText.textContent = `${selectedFilesStore[prefix][0].name} (${formatFileSize(selectedFilesStore[prefix][0].size)})`;
    } else {
      const names = selectedFilesStore[prefix].slice(0, 3).map(f => f.name).join(', ');
      boldText.textContent = `${count} files selected: ${names}${count > 3 ? '…' : ''}`;
    }

    const hint = document.createElement('span');
    hint.className = 'drop-subhint';
    hint.textContent = 'Tap or drop to change files';

    container.append(boldText, hint);
    dropzone.replaceChildren(container);
  };

  dropzone.addEventListener('click', () => fileInput.click());
  dropzone.addEventListener('keydown', e => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) {
      updateSelectionUI([...fileInput.files]);
    }
  });

  ['dragover', 'dragenter'].forEach(eventName => {
    dropzone.addEventListener(eventName, e => {
      e.preventDefault();
      dropzone.classList.add('over');
    });
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropzone.addEventListener(eventName, e => {
      e.preventDefault();
      dropzone.classList.remove('over');
    });
  });

  dropzone.addEventListener('drop', e => {
    if (e.dataTransfer.files.length) {
      updateSelectionUI([...e.dataTransfer.files]);
    }
  });
}

setupDropzone('cv', true);
setupDropzone('cp', true);

/* ==========================================================================
   12. Batch File Conversion Tool
   ========================================================================== */

$('#cv-go').addEventListener('click', async () => {
  const files = selectedFilesStore.cv;
  const outputContainer = $('#cv-out');
  const statusNote = $('#cv-note');
  outputContainer.replaceChildren();

  if (!files.length) {
    return updateStatusText(statusNote, 'Choose at least one file first.');
  }

  const targetFormat = $('#cv-to').value;
  const quality = Math.min(100, Math.max(10, +$('#cv-q').value || 90)) / 100;
  const dpi = +$('#cv-dpi').value;
  const fitMode = $('#cv-fit').value;

  setButtonBusy('#cv-go', true);
  await yieldEventLoop();
  const completedItems = [];

  try {
    const pdfPagesAccumulator = [];
    const skippedFiles = [];

    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      const prefix = files.length > 1 ? `[${index + 1}/${files.length}] ` : '';
      updateStatusText(statusNote, `${prefix}Working on ${file.name}…`);
      await yieldEventLoop();

      if (isPdfFile(file)) {
        if (targetFormat === 'pdf') {
          skippedFiles.push(file.name);
          continue;
        }
        const rendered = await extractPdfPages(file, dpi, msg =>
          updateStatusText(statusNote, `${prefix}${msg}`)
        );
        for (let p = 0; p < rendered.length; p++) {
          const blob = await canvasToBlob(rendered[p].c, 'image/jpeg', quality);
          const filename =
            getFileStem(file) + (rendered.length > 1 ? '-page' + (p + 1) : '') + '.jpg';
          appendResultRow(outputContainer, blob, filename);
          completedItems.push({ blob, name: filename });
        }
      } else {
        const canvas = await fileToCanvas(file);
        if (targetFormat === 'jpg') {
          const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
          const filename = getFileStem(file) + '.jpg';
          appendResultRow(outputContainer, blob, filename);
          completedItems.push({ blob, name: filename });
        } else {
          pdfPagesAccumulator.push(createPdfPageLayout(canvas, fitMode));
        }
      }
    }

    if (pdfPagesAccumulator.length) {
      const pdfBlob = convertPagesToPdf(pdfPagesAccumulator, quality);
      const filename = (files.length === 1 ? getFileStem(files[0]) : 'converted') + '.pdf';
      appendResultRow(outputContainer, pdfBlob, filename);
      completedItems.push({ blob: pdfBlob, name: filename });
    }

    addDownloadAllButton(outputContainer, completedItems, 'converted files');
    updateStatusText(
      statusNote,
      'Done.' +
        (skippedFiles.length
          ? ' Skipped files that are already PDF: ' + skippedFiles.join(', ') + '.'
          : '')
    );
  } catch (err) {
    updateStatusText(statusNote, 'Could not convert: ' + (err.message || err));
  }

  setButtonBusy('#cv-go', false);
});

/* ==========================================================================
   13. Batch File Compression Tool
   ========================================================================== */

$('#cp-go').addEventListener('click', async () => {
  const files = selectedFilesStore.cp;
  const outputContainer = $('#cp-out');
  const statusNote = $('#cp-note');
  const targetKB = +$('#cp-kb').value;

  outputContainer.replaceChildren();

  if (!files.length) {
    return updateStatusText(statusNote, 'Choose at least one file to compress.');
  }
  if (!(targetKB >= 5)) {
    return updateStatusText(statusNote, 'Enter a target size of at least 5 KB.');
  }

  setButtonBusy('#cp-go', true);
  await yieldEventLoop();

  const completedItems = [];
  let underCount = 0;
  let targetMetCount = 0;

  try {
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      const prefix = files.length > 1 ? `[${index + 1}/${files.length}] ` : '';
      updateStatusText(statusNote, `${prefix}Compressing ${file.name}…`);
      await yieldEventLoop();

      if (file.size <= targetKB * 1024) {
        const filename = getFileStem(file) + (isPdfFile(file) ? '.pdf' : '.jpg');
        appendResultRow(
          outputContainer,
          file,
          filename,
          `already ${formatFileSize(file.size)} (under ${targetKB} KB target)`
        );
        completedItems.push({ blob: file, name: filename });
        underCount++;
        continue;
      }

      try {
        let compressedBlob;
        if (isPdfFile(file)) {
          const pages = await extractPdfPages(file, 150, msg =>
            updateStatusText(statusNote, `${prefix}${file.name}: ${msg}`)
          );
          updateStatusText(statusNote, `${prefix}Optimizing PDF ${file.name}…`);
          await yieldEventLoop();
          compressedBlob = await compressPdfToTarget(pages, targetKB);
        } else {
          compressedBlob = await compressJpegToTarget(await fileToCanvas(file), targetKB);
        }

        const filename =
          getFileStem(file) + '-compressed.' + (isPdfFile(file) ? 'pdf' : 'jpg');
        const metTarget = compressedBlob.size <= targetKB * 1024;
        if (metTarget) targetMetCount++;

        appendResultRow(
          outputContainer,
          compressedBlob,
          filename,
          `was ${formatFileSize(file.size)}${metTarget ? '' : ' · best reached'}`
        );
        completedItems.push({ blob: compressedBlob, name: filename });
      } catch (err) {
        const errorRow = document.createElement('div');
        errorRow.className = 'res error-msg';
        errorRow.textContent = `${file.name}: Failed — ${err.message || err}`;
        outputContainer.append(errorRow);
      }
    }

    addDownloadAllButton(outputContainer, completedItems, 'compressed files');
    const totalMet = targetMetCount + underCount;

    if (files.length === 1) {
      if (underCount === 1) {
        updateStatusText(
          statusNote,
          `This file was already ${formatFileSize(files[0].size)}, under your ${targetKB} KB target.`
        );
      } else if (targetMetCount === 1) {
        updateStatusText(statusNote, 'Done. The file is under your target.');
      } else {
        updateStatusText(statusNote, 'Smallest size reached, but still above target.');
      }
    } else {
      updateStatusText(
        statusNote,
        `Done. Processed ${completedItems.length} of ${files.length} file(s). ${totalMet} under ${targetKB} KB.`
      );
    }
  } catch (err) {
    updateStatusText(statusNote, 'Could not compress: ' + (err.message || err));
  }

  setButtonBusy('#cp-go', false);
});

/* ==========================================================================
   14. Full-Screen Interactive Crop Editor Modal & Loupe
   ========================================================================== */

function mountThumbnail(slot) {
  slot.thumb = document.createElement('canvas');
  slot.thumb.className = 'thumb';
  slot.thumb.title = 'Click to open full screen preview';
  slot.thumb.addEventListener('click', () => openPreviewModal(slot.id));

  const actionRow = document.createElement('div');
  actionRow.className = 'row';
  actionRow.style.justifyContent = 'center';
  actionRow.style.gap = '8px';

  const previewBtn = document.createElement('button');
  previewBtn.className = 'btn';
  previewBtn.type = 'button';
  previewBtn.title = 'Preview card in full screen';
  previewBtn.innerHTML = `
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;margin-right:4px;" aria-hidden="true">
      <polyline points="15 3 21 3 21 9"></polyline>
      <polyline points="9 21 3 21 3 15"></polyline>
      <line x1="21" y1="3" x2="14" y2="10"></line>
      <line x1="3" y1="21" x2="10" y2="14"></line>
    </svg>Full screen
  `;
  previewBtn.addEventListener('click', () => openPreviewModal(slot.id));

  const editBtn = document.createElement('button');
  editBtn.className = 'primary';
  editBtn.type = 'button';
  editBtn.textContent = 'Edit crop';
  editBtn.addEventListener('click', () => openModalEditor(slot));

  actionRow.append(previewBtn, editBtn);
  slot.cv.replaceWith(slot.thumb);
  slot.thumb.after(actionRow);

  ['pointerdown', 'pointermove'].forEach(evt =>
    slot.cv.addEventListener(evt, e => updateMagnifierLoupe(slot, e))
  );

  ['pointerup', 'pointercancel'].forEach(evt =>
    slot.cv.addEventListener(evt, () => {
      $('#loupe').hidden = true;
    })
  );
}

function drawThumbnail(slot) {
  if (!slot.img || !slot.thumb) return;
  const width = 360;
  const height = Math.max(40, Math.round(width / calculateAspectRatio(slot, getOptions())));
  const rendered = createCardCanvas(slot, width, height);
  slot.thumb.width = width;
  slot.thumb.height = height;
  slot.thumb.getContext('2d').drawImage(rendered, 0, 0);
}

function syncModalHint() {
  const hint = $('#m-hint');
  if (hint) {
    hint.textContent = modalState.currentSlot?.id === 'passport'
      ? 'Drag corners or box to frame your passport photo. Aspect ratio is locked to preset.'
      : 'Drag the square corners onto the card corners. Drag the round dots on each edge to resize. Drag inside to move.';
  }
}

function fitModalCanvas() {
  const slot = modalState.currentSlot;
  if (!modalState.isOpen || !slot) return;

  drawCropCanvas(slot);
  const stageRect = $('#m-stage').getBoundingClientRect();
  const scale = Math.min(
    (stageRect.width - 24) / slot.cv.width,
    (stageRect.height - 24) / slot.cv.height
  );
  slot.cv.style.width = Math.floor(slot.cv.width * scale) + 'px';
  slot.cv.style.height = Math.floor(slot.cv.height * scale) + 'px';
  drawCropCanvas(slot);
}

function openModalEditor(slot) {
  if (!slot.img) return;
  modalState.currentSlot = slot;
  modalState.isOpen = true;
  modalState.snapshot = {
    img: slot.img,
    crop: { ...slot.crop },
    quad: slot.quad.map(q => ({ ...q })),
    persp: slot.persp
  };

  $('#m-title').textContent =
    slot.id === 'passport'
      ? 'Passport photo crop'
      : (slot.id === 'front' ? 'Front side' : 'Back side');

  $('#m-stage').replaceChildren(slot.cv);
  $('#editor').hidden = false;
  document.body.classList.add('lock');

  syncModalHint();
  fitModalCanvas();
}

function closeModalEditor(commitChanges) {
  const slot = modalState.currentSlot;
  if (!slot) return;

  if (!commitChanges) {
    const snap = modalState.snapshot;
    slot.img = snap.img;
    slot.crop = snap.crop;
    slot.quad = snap.quad;
    slot.persp = snap.persp;
    slot.srcData = null;
  }

  modalState.isOpen = false;
  modalState.currentSlot = null;
  $('#editor').hidden = true;
  document.body.classList.remove('lock');

  slot.cv.style.width = '';
  slot.cv.style.height = '';
  slot.cv.remove();

  if (slot.id === 'passport') {
    drawPassportThumbnail();
    requestPassportPreview();
  } else {
    requestPreview();
  }

  if (previewModalState.isOpen) {
    renderPreviewCanvas();
  }
}

function computeConvexHull(points) {
  points.sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower = [];
  const upper = [];

  for (const p of points) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) {
      lower.pop();
    }
    lower.push(p);
  }

  for (let i = points.length - 1; i >= 0; i--) {
    const p = points[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) {
      upper.pop();
    }
    upper.push(p);
  }

  upper.pop();
  lower.pop();
  return lower.concat(upper);
}

function intersectSegments(a, b, c, d) {
  const denom = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / denom;
  return t > 1 ? { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) } : null;
}

function simplifyToQuadrilateral(poly) {
  let points = poly.slice();
  while (points.length > 4) {
    const n = points.length;
    let best = null;

    for (let i = 0; i < n; i++) {
      const a = points[(i + n - 1) % n];
      const b = points[i];
      const c = points[(i + 1) % n];
      const d = points[(i + 2) % n];
      const intersection = intersectSegments(a, b, c, d);
      if (!intersection) continue;

      const area = Math.abs((b.x - intersection.x) * (c.y - intersection.y) - (c.x - intersection.x) * (b.y - intersection.y)) / 2;
      if (!best || area < best.area) {
        best = { i, intersection, area };
      }
    }

    if (!best) return points;
    const dropIndex = (best.i + 1) % n;
    points = points
      .map((p, k) => (k === best.i ? best.intersection : p))
      .filter((_, k) => k !== dropIndex);
  }
  return points;
}

function detectCardCorners(img) {
  const scaleFactor = Math.min(1, 320 / Math.max(img.width, img.height));
  const w = Math.max(8, Math.round(img.width * scaleFactor));
  const h = Math.max(8, Math.round(img.height * scaleFactor));

  const cv = document.createElement('canvas');
  cv.width = w;
  cv.height = h;
  const ctx = cv.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, w, h);

  const imgData = ctx.getImageData(0, 0, w, h).data;
  const totalPixels = w * h;
  const margin = Math.max(2, Math.round(Math.min(w, h) * 0.03));
  const borderPixels = [];

  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      if (i < margin || j < margin || i >= w - margin || j >= h - margin) {
        borderPixels.push((j * w + i) * 4);
      }
    }
  }

  const medianChannel = channelOffset => {
    const samples = borderPixels.map(idx => imgData[idx + channelOffset]).sort((a, b) => a - b);
    return samples[samples.length >> 1];
  };

  const bgR = medianChannel(0);
  const bgG = medianChannel(1);
  const bgB = medianChannel(2);

  const distMap = new Uint8Array(totalPixels);
  const histogram = new Array(256).fill(0);

  for (let p = 0; p < totalPixels; p++) {
    const dr = imgData[p * 4] - bgR;
    const dg = imgData[p * 4 + 1] - bgG;
    const db = imgData[p * 4 + 2] - bgB;
    const dist = Math.min(255, Math.round(Math.sqrt(dr * dr + dg * dg + db * db) * 0.58));
    distMap[p] = dist;
    histogram[dist]++;
  }

  let totalSum = 0;
  for (let i = 0; i < 256; i++) totalSum += i * histogram[i];

  let weightBg = 0;
  let sumBg = 0;
  let maxVariance = -1;
  let optimalThreshold = 20;

  for (let t = 0; t < 256; t++) {
    weightBg += histogram[t];
    if (!weightBg) continue;
    const weightFg = totalPixels - weightBg;
    if (!weightFg) break;

    sumBg += t * histogram[t];
    const meanBg = sumBg / weightBg;
    const meanFg = (totalSum - sumBg) / weightFg;
    const betweenVariance = weightBg * weightFg * (meanBg - meanFg) * (meanBg - meanFg);

    if (betweenVariance > maxVariance) {
      maxVariance = betweenVariance;
      optimalThreshold = t;
    }
  }

  optimalThreshold = Math.max(14, optimalThreshold);

  const visited = new Uint8Array(totalPixels);
  const queue = new Int32Array(totalPixels);
  let bestStart = 0;
  let bestLength = 0;
  let queueHead = 0;

  for (let s0 = 0; s0 < totalPixels; s0++) {
    if (visited[s0] || distMap[s0] <= optimalThreshold) continue;
    const componentStart = queueHead;
    queue[queueHead++] = s0;
    visited[s0] = 1;

    for (let k = componentStart; k < queueHead; k++) {
      const idx = queue[k];
      const px = idx % w;
      const py = (idx / w) | 0;

      if (px > 0 && !visited[idx - 1] && distMap[idx - 1] > optimalThreshold) {
        visited[idx - 1] = 1;
        queue[queueHead++] = idx - 1;
      }
      if (px < w - 1 && !visited[idx + 1] && distMap[idx + 1] > optimalThreshold) {
        visited[idx + 1] = 1;
        queue[queueHead++] = idx + 1;
      }
      if (py > 0 && !visited[idx - w] && distMap[idx - w] > optimalThreshold) {
        visited[idx - w] = 1;
        queue[queueHead++] = idx - w;
      }
      if (py < h - 1 && !visited[idx + w] && distMap[idx + w] > optimalThreshold) {
        visited[idx + w] = 1;
        queue[queueHead++] = idx + w;
      }
    }

    const componentLength = queueHead - componentStart;
    if (componentLength > bestLength) {
      bestLength = componentLength;
      bestStart = componentStart;
    }
  }

  if (bestLength < totalPixels * 0.12 || bestLength > totalPixels * 0.97) {
    return null;
  }

  const componentMask = new Uint8Array(totalPixels);
  for (let k = 0; k < bestLength; k++) {
    componentMask[queue[bestStart + k]] = 1;
  }

  const boundaryPoints = [];
  for (let k = 0; k < bestLength; k++) {
    const idx = queue[bestStart + k];
    const px = idx % w;
    const py = (idx / w) | 0;

    if (
      px === 0 ||
      py === 0 ||
      px === w - 1 ||
      py === h - 1 ||
      !componentMask[idx - 1] ||
      !componentMask[idx + 1] ||
      !componentMask[idx - w] ||
      !componentMask[idx + w]
    ) {
      boundaryPoints.push({ x: px, y: py });
    }
  }

  const hull = computeConvexHull(boundaryPoints);
  if (hull.length < 4) return null;

  const quad = simplifyToQuadrilateral(hull);
  if (quad.length !== 4) return null;

  const originalQuad = quad.map(p => ({
    x: Math.max(0, Math.min(img.width, p.x / scaleFactor)),
    y: Math.max(0, Math.min(img.height, p.y / scaleFactor))
  }));

  const cx = originalQuad.reduce((acc, p) => acc + p.x, 0) / 4;
  const cy = originalQuad.reduce((acc, p) => acc + p.y, 0) / 4;
  originalQuad.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));

  let topIndex = 0;
  originalQuad.forEach((p, i) => {
    if (p.x + p.y < originalQuad[topIndex].x + originalQuad[topIndex].y) {
      topIndex = i;
    }
  });

  return [0, 1, 2, 3].map(i => originalQuad[(topIndex + i) % 4]);
}

function autoSelectCard(slot, silentMode, retryCount) {
  let detectedCorners = null;
  try {
    detectedCorners = detectCardCorners(slot.img);
  } catch (err) {
    detectedCorners = null;
  }

  if (!detectedCorners) {
    if (!silentMode && modalState.isOpen) {
      $('#m-hint').textContent =
        'Could not find the card edges automatically. Please drag the corners manually.';
    }
    return false;
  }

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const cardW = (dist(detectedCorners[0], detectedCorners[1]) + dist(detectedCorners[3], detectedCorners[2])) / 2;
  const cardH = (dist(detectedCorners[0], detectedCorners[3]) + dist(detectedCorners[1], detectedCorners[2])) / 2;

  if (!retryCount && cardH > cardW * 1.15) {
    rotateSlot(slot);
    return autoSelectCard(slot, silentMode, true);
  }

  const tiltAngle =
    Math.max(
      ...[
        [detectedCorners[0], detectedCorners[1]],
        [detectedCorners[3], detectedCorners[2]]
      ].map(p => Math.abs(Math.atan2(p[1].y - p[0].y, p[1].x - p[0].x))),
      ...[
        [detectedCorners[0], detectedCorners[3]],
        [detectedCorners[1], detectedCorners[2]]
      ].map(p => Math.abs(Math.atan2(p[1].x - p[0].x, p[1].y - p[0].y)))
    ) * (180 / Math.PI);

  const xs = detectedCorners.map(p => p.x);
  const ys = detectedCorners.map(p => p.y);

  slot.quad = detectedCorners.map(p => ({ ...p }));
  slot.crop = {
    x: Math.min(...xs),
    y: Math.min(...ys),
    w: Math.max(...xs) - Math.min(...xs),
    h: Math.max(...ys) - Math.min(...ys)
  };

  if (tiltAngle > 3) {
    slot.persp = true;
    const perspBtn = slot.el.querySelector('[data-act="persp"]');
    if (perspBtn) perspBtn.setAttribute('aria-pressed', 'true');
  }

  if (modalState.isOpen) {
    fitModalCanvas();
    syncModalHint();
    requestPreview();
  }
  return true;
}

function updateMagnifierLoupe(slot, event) {
  const loupeCanvas = $('#loupe');
  const mode = slot.dragMode;

  if (!modalState.isOpen || !mode || mode.t === 'move') {
    loupeCanvas.hidden = true;
    return;
  }

  const c = slot.crop;
  const rectCorners = [
    { x: c.x, y: c.y },
    { x: c.x + c.w, y: c.y },
    { x: c.x + c.w, y: c.y + c.h },
    { x: c.x, y: c.y + c.h }
  ];
  const poly = slot.persp ? slot.quad : rectCorners;

  const activePoint =
    mode.t === 'vert'
      ? slot.quad[mode.i]
      : mode.t === 'edge'
      ? {
          x: (slot.quad[mode.i].x + slot.quad[(mode.i + 1) % 4].x) / 2,
          y: (slot.quad[mode.i].y + slot.quad[(mode.i + 1) % 4].y) / 2
        }
      : { tl: rectCorners[0], tr: rectCorners[1], br: rectCorners[2], bl: rectCorners[3] }[mode.h.n];

  const LOUPE_SIZE = 300;
  const displayScale = slot.cv.clientWidth / slot.img.width || 1;
  const sampleWidth = 150 / 4 / displayScale;
  const originX = activePoint.x - sampleWidth / 2;
  const originY = activePoint.y - sampleWidth / 2;
  const zoomFactor = LOUPE_SIZE / sampleWidth;

  loupeCanvas.width = LOUPE_SIZE;
  loupeCanvas.height = LOUPE_SIZE;
  const ctx = loupeCanvas.getContext('2d');
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, LOUPE_SIZE, LOUPE_SIZE);
  ctx.imageSmoothingQuality = 'high';

  ctx.drawImage(
    slot.img,
    originX,
    originY,
    sampleWidth,
    sampleWidth,
    0,
    0,
    LOUPE_SIZE,
    LOUPE_SIZE
  );

  ctx.strokeStyle = '#3cc2b0';
  ctx.lineWidth = 2;
  ctx.beginPath();
  poly.forEach((q, i) => {
    const qx = (q.x - originX) * zoomFactor;
    const qy = (q.y - originY) * zoomFactor;
    if (i === 0) ctx.moveTo(qx, qy);
    else ctx.lineTo(qx, qy);
  });
  ctx.closePath();
  ctx.stroke();

  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(LOUPE_SIZE / 2, LOUPE_SIZE / 2 - 22);
  ctx.lineTo(LOUPE_SIZE / 2, LOUPE_SIZE / 2 + 22);
  ctx.moveTo(LOUPE_SIZE / 2 - 22, LOUPE_SIZE / 2);
  ctx.lineTo(LOUPE_SIZE / 2 + 22, LOUPE_SIZE / 2);
  ctx.stroke();

  const stageRect = $('#m-stage').getBoundingClientRect();
  let leftPos = stageRect.left + 10;
  const topPos = stageRect.top + 10;
  if (event.clientX < leftPos + 210 && event.clientY < topPos + 210) {
    leftPos = stageRect.right - 160;
  }
  loupeCanvas.style.left = leftPos + 'px';
  loupeCanvas.style.top = topPos + 'px';
  loupeCanvas.hidden = false;
}

$('#m-auto').addEventListener('click', () => {
  if (modalState.currentSlot) autoSelectCard(modalState.currentSlot, false);
});

$('#m-rot').addEventListener('click', () => {
  const slot = modalState.currentSlot;
  if (slot) {
    rotateSlot(slot);
    fitModalCanvas();
  }
});

$('#m-reset').addEventListener('click', () => {
  const slot = modalState.currentSlot;
  if (slot) {
    initDefaultCrop(slot);
    syncModalHint();
    fitModalCanvas();
    if (slot.id === 'passport') requestPassportPreview();
    else requestPreview();
  }
});

$('#m-cancel').addEventListener('click', () => closeModalEditor(false));
$('#m-done').addEventListener('click', () => closeModalEditor(true));

/* ==========================================================================
   15. Full-Screen Card, Photo & Sheet Preview Modal
   ========================================================================== */

/**
 * Opens the full-screen preview modal for high-resolution card or photo inspection.
 * @param {'front'|'back'|'a4'|'pp-photo'|'pp-sheet'} targetId Target view to open.
 */
function openPreviewModal(targetId) {
  if (targetId === 'front' || targetId === 'back') {
    if (!slots[targetId]?.img) {
      const other = targetId === 'front' ? 'back' : 'front';
      if (slots[other]?.img) targetId = other;
      else if (hasLoadedCard()) targetId = 'a4';
      else {
        alert('Please add at least one card image first.');
        return;
      }
    }
  } else if (targetId === 'a4') {
    if (!hasLoadedCard()) return;
  } else if (targetId === 'pp-photo' && !passportSlot.img) {
    alert('Please upload a passport photo first.');
    return;
  }

  previewModalState.isOpen = true;
  previewModalState.target = targetId;
  previewModalState.zoom = 1;
  previewModalState.panX = 0;
  previewModalState.panY = 0;

  $('#card-preview-modal').hidden = false;
  document.body.classList.add('lock');

  syncPreviewSideTabs();
  renderPreviewCanvas();
}

function closePreviewModal() {
  previewModalState.isOpen = false;
  $('#card-preview-modal').hidden = true;
  document.body.classList.remove('lock');
}

function switchPreviewTarget(targetId) {
  if (targetId === 'front' || targetId === 'back') {
    if (!slots[targetId]?.img) {
      alert(`No ${targetId} card image has been added yet.`);
      return;
    }
  } else if (targetId === 'pp-photo' && !passportSlot.img) {
    alert('No passport photo has been uploaded yet.');
    return;
  }
  previewModalState.target = targetId;
  previewModalState.zoom = 1;
  previewModalState.panX = 0;
  previewModalState.panY = 0;

  syncPreviewSideTabs();
  renderPreviewCanvas();
}

function syncPreviewSideTabs() {
  const current = previewModalState.target;
  const isPassportMode = current.startsWith('pp-');
  const switcher = $('#pv-side-switcher');

  if (isPassportMode) {
    switcher.innerHTML = `
      <button data-pv="pp-photo" class="pv-tab" aria-pressed="${current === 'pp-photo'}">Passport photo</button>
      <button data-pv="pp-sheet" class="pv-tab" aria-pressed="${current === 'pp-sheet'}">Print sheet</button>
    `;
  } else {
    switcher.innerHTML = `
      <button data-pv="front" class="pv-tab" aria-pressed="${current === 'front'}" style="opacity:${slots.front?.img ? '1' : '0.45'}">Front</button>
      <button data-pv="back" class="pv-tab" aria-pressed="${current === 'back'}" style="opacity:${slots.back?.img ? '1' : '0.45'}">Back</button>
      <button data-pv="a4" class="pv-tab" aria-pressed="${current === 'a4'}">A4 Sheet</button>
    `;
  }

  switcher.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => switchPreviewTarget(btn.dataset.pv));
  });
}

function renderPreviewCanvas() {
  const target = previewModalState.target;
  const pvCanvas = $('#pv-canvas');
  const titleEl = $('#pv-title');
  const subtitleEl = $('#pv-subtitle');
  const dimEl = $('#pv-dimensions');
  const editCropBtn = $('#pv-edit-crop');

  if (target === 'front' || target === 'back') {
    const slot = slots[target];
    if (!slot || !slot.img) return;

    const width = Math.min(2400, Math.max(1200, slot.img.width || 1600));
    const height = Math.max(50, Math.round(width / calculateAspectRatio(slot, getOptions())));
    const rendered = createCardCanvas(slot, width, height);

    pvCanvas.width = width;
    pvCanvas.height = height;
    const ctx = pvCanvas.getContext('2d');
    ctx.drawImage(rendered, 0, 0);

    titleEl.textContent = `${slot.id === 'front' ? 'Front side' : 'Back side'} — Full Screen Preview`;
    subtitleEl.textContent = 'High resolution inspection view';
    dimEl.textContent = `Physical card scale: 85.6 × 54.0 mm · ${width} × ${height} px`;
    editCropBtn.style.display = 'inline-block';
  } else if (target === 'a4') {
    composeA4Sheet(pvCanvas, 200, false);
    titleEl.textContent = 'A4 Sheet — Full Screen Preview';
    subtitleEl.textContent = 'True 100% scale A4 printable layout';
    dimEl.textContent = `Standard A4 (210 × 297 mm) · ${pvCanvas.width} × ${pvCanvas.height} px`;
    editCropBtn.style.display = 'none';
  } else if (target === 'pp-photo') {
    const opt = getPassportOptions();
    if (!passportSlot.img) return;

    const width = 1200;
    const height = Math.round(width / opt.aspectRatio);
    const rendered = createPassportPhotoCanvas(passportSlot, width, height);

    pvCanvas.width = width;
    pvCanvas.height = height;
    const ctx = pvCanvas.getContext('2d');
    ctx.drawImage(rendered, 0, 0);

    titleEl.textContent = `Passport Photo (${opt.photoWidth} × ${opt.photoHeight} mm) — Full Screen Preview`;
    subtitleEl.textContent = 'High resolution single photo crop';
    dimEl.textContent = `Physical dimensions: ${opt.photoWidth} × ${opt.photoHeight} mm · 300 DPI`;
    editCropBtn.style.display = 'inline-block';
  } else if (target === 'pp-sheet') {
    composePassportSheet(pvCanvas, 200, false);
    const paper = getPassportPaperDimensions();
    titleEl.textContent = `Passport Print Sheet (${paper.name}) — Full Screen Preview`;
    subtitleEl.textContent = 'Physical layout preview with borders';
    dimEl.textContent = `Paper size: ${paper.name} (${Math.round(paper.w)} × ${Math.round(paper.h)} mm)`;
    editCropBtn.style.display = 'none';
  }

  applyPreviewTransform();
}

function applyPreviewTransform() {
  const inner = $('#pv-stage-inner');
  if (!inner) return;
  inner.style.transform = `translate(${previewModalState.panX}px, ${previewModalState.panY}px) scale(${previewModalState.zoom})`;
  $('#pv-zoom-level').textContent = `${Math.round(previewModalState.zoom * 100)}%`;
}

function setPreviewZoom(zoomVal) {
  previewModalState.zoom = Math.max(0.4, Math.min(4.0, zoomVal));
  if (previewModalState.zoom <= 1) {
    previewModalState.panX = 0;
    previewModalState.panY = 0;
  }
  applyPreviewTransform();
}

function resetPreviewZoom() {
  previewModalState.zoom = 1;
  previewModalState.panX = 0;
  previewModalState.panY = 0;
  applyPreviewTransform();
}

$('#pv-zoom-in').addEventListener('click', () => setPreviewZoom(previewModalState.zoom * 1.25));
$('#pv-zoom-out').addEventListener('click', () => setPreviewZoom(previewModalState.zoom / 1.25));
$('#pv-zoom-fit').addEventListener('click', resetPreviewZoom);

$('#pv-stage').addEventListener('wheel', e => {
  if (!previewModalState.isOpen) return;
  e.preventDefault();
  const delta = e.deltaY < 0 ? 1.15 : 0.87;
  setPreviewZoom(previewModalState.zoom * delta);
}, { passive: false });

const pvStage = $('#pv-stage');
const pvInner = $('#pv-stage-inner');

pvStage.addEventListener('pointerdown', e => {
  if (!previewModalState.isOpen) return;
  previewModalState.isPanning = true;
  previewModalState.startPointerX = e.clientX;
  previewModalState.startPointerY = e.clientY;
  previewModalState.basePanX = previewModalState.panX;
  previewModalState.basePanY = previewModalState.panY;
  pvInner.classList.add('panning');
  pvStage.setPointerCapture(e.pointerId);
});

pvStage.addEventListener('pointermove', e => {
  if (!previewModalState.isPanning) return;
  const dx = e.clientX - previewModalState.startPointerX;
  const dy = e.clientY - previewModalState.startPointerY;
  previewModalState.panX = previewModalState.basePanX + dx / previewModalState.zoom;
  previewModalState.panY = previewModalState.basePanY + dy / previewModalState.zoom;
  applyPreviewTransform();
});

const stopPanning = () => {
  previewModalState.isPanning = false;
  pvInner.classList.remove('panning');
};
pvStage.addEventListener('pointerup', stopPanning);
pvStage.addEventListener('pointercancel', stopPanning);

$('#pv-close').addEventListener('click', closePreviewModal);
$('#pv-done').addEventListener('click', closePreviewModal);

$('#pv-edit-crop').addEventListener('click', () => {
  const target = previewModalState.target;
  closePreviewModal();
  if (target === 'pp-photo') {
    openModalEditor(passportSlot);
  } else if (slots[target]) {
    openModalEditor(slots[target]);
  }
});

$('#pv-download').addEventListener('click', async () => {
  const target = previewModalState.target;
  if (target === 'front' || target === 'back') {
    const slot = slots[target];
    if (!slot || !slot.img) return;
    const width = Math.min(2400, Math.max(1200, slot.img.width || 1600));
    const height = Math.max(50, Math.round(width / calculateAspectRatio(slot, getOptions())));
    const canvas = createCardCanvas(slot, width, height);
    const blob = await canvasToBlob(canvas, 'image/png');
    saveBlobFile(blob, `id-card-${target}.png`);
  } else if (target === 'a4') {
    const canvas = createExportCanvas();
    const blob = await canvasToBlob(canvas, 'image/png');
    saveBlobFile(blob, 'id-card-a4-preview.png');
  } else if (target === 'pp-photo') {
    exportSinglePassportPhoto();
  } else if (target === 'pp-sheet') {
    exportPassportJpeg();
  }
});

window.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (previewModalState.isOpen) {
      closePreviewModal();
      return;
    }
    if (modalState.isOpen) {
      closeModalEditor(false);
      return;
    }
  }

  if (previewModalState.isOpen) {
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      setPreviewZoom(previewModalState.zoom * 1.25);
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      setPreviewZoom(previewModalState.zoom / 1.25);
    } else if (e.key === '0') {
      e.preventDefault();
      resetPreviewZoom();
    }
  }
});

/* ==========================================================================
   16. Hash-based SPA Router & Navigation
   ========================================================================== */

const APP_PAGES = ['home', 'a4', 'passport', 'convert', 'compress'];
const ROUTE_ALIASES = {
  'a4-id': 'a4',
  id: 'a4',
  passport: 'passport',
  'passport-photo': 'passport',
  passports: 'passport',
  photo: 'passport',
  home: 'home',
  '': 'home'
};
const PAGE_TITLES = {
  home: 'Card & File Tools — Free & Private In-Browser Tools',
  a4: 'ID Card to A4 — Fit & Print ID Cards',
  passport: 'Passport Size Photo Maker — Print on A4, 4×6, 5×7',
  convert: 'Convert Files — PDF & Image Converter',
  compress: 'Compress Files — Target Size Optimizer'
};

function handleRouteChange() {
  const hashKey = (location.hash.slice(1) || '').trim().toLowerCase();
  const activePage = ROUTE_ALIASES[hashKey] || (APP_PAGES.includes(hashKey) ? hashKey : 'home');

  APP_PAGES.forEach(page => {
    const pageElement = $('#p-' + page);
    if (pageElement) pageElement.hidden = page !== activePage;

    const navTab = document.querySelector(`[data-tab="${page}"]`);
    if (navTab) navTab.setAttribute('aria-selected', page === activePage);
  });

  document.title = PAGE_TITLES[activePage] || 'Card & File Tools';

  if (activePage === 'a4') {
    SLOT_IDS.forEach(id => slots[id].img && drawCropCanvas(slots[id]));
    fitModalCanvas();
    requestPreview();
  } else if (activePage === 'passport') {
    if (passportSlot.img) {
      drawPassportThumbnail();
    }
    requestPassportPreview();
  }
}

window.addEventListener('hashchange', handleRouteChange);

// Initialize application modules
initPassportPhotoTool();
handleRouteChange();
requestPreview();
requestPassportPreview();
