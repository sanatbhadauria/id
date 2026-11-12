/**
 * Card & File Tools — Core Application Logic
 * 
 * Features:
 * - ID Card to A4 Composer with physical scale (85.6 × 54 mm, ISO/IEC 7810 ID-1 standard)
 * - 4-corner perspective correction with projective bilinear warping
 * - Auto card edge detection (background separation, Otsu thresholding, convex hull, quad fit)
 * - Interactive full-screen editor with corner loupe magnifier
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

/** Modal editor state */
const modalState = {
  currentSlot: null,
  snapshot: null,
  isOpen: false
};

/** RequestAnimationFrame ID for debounced sheet preview rendering */
let previewRafId = null;

/* ==========================================================================
   2. Configuration & Option Helpers
   ========================================================================== */

/**
 * Reads layout and styling options from the UI controls.
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

/* ==========================================================================
   3. Slot Initialization & Event Binding
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

// Setup filter adjustments panel
initAdjustmentsPanel();

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
    autoSelectCard(slot, true);
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
  slot.editor.style.display = 'block';
  drawCropCanvas(slot);
  requestPreview();
}

/**
 * Initializes crop rectangle to default centered ~92% bounds matching card aspect ratio.
 */
function initDefaultCrop(slot) {
  const W = slot.img.width;
  const H = slot.img.height;
  const ratio = getOptions().lockAspect ? CARD_ASPECT_RATIO : W / H;
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
  drawCropCanvas(slot);
  requestPreview();
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

  // Card boundary outline
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

/**
 * Returns rectangular corner definition for axis-aligned crop mode.
 */
function getRectangleCorners(c) {
  return [
    { n: 'tl', x: c.x, y: c.y, ax: c.x + c.w, ay: c.y + c.h },
    { n: 'tr', x: c.x + c.w, y: c.y, ax: c.x, ay: c.y + c.h },
    { n: 'bl', x: c.x, y: c.y + c.h, ax: c.x + c.w, ay: c.y },
    { n: 'br', x: c.x + c.w, y: c.y + c.h, ax: c.x, ay: c.y }
  ];
}

/**
 * Binds pointer events for dragging corners, edges, and moving the crop area.
 */
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
      // Test 4 corner vertices
      const vertIndex = slot.quad.findIndex(
        q => Math.abs(q.x - pt.x) < pt.hitRadius && Math.abs(q.y - pt.y) < pt.hitRadius
      );
      if (vertIndex >= 0) return { t: 'vert', i: vertIndex };

      // Test 4 edge midpoints
      const edgeIndex = slot.quad.findIndex((q, i) => {
        const next = slot.quad[(i + 1) % 4];
        const mx = (q.x + next.x) / 2;
        const my = (q.y + next.y) / 2;
        return Math.abs(mx - pt.x) < pt.hitRadius && Math.abs(my - pt.y) < pt.hitRadius;
      });
      if (edgeIndex >= 0) return { t: 'edge', i: edgeIndex };

      // Test inside polygon for whole-quad movement
      return isPointInPolygon(slot.quad, pt) ? { t: 'move' } : null;
    }

    // Axis-aligned mode
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

    // Hover cursor updates when not dragging
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

    // Active dragging transformations
    const mode = slot.dragMode;
    if (mode.t === 'edge') {
      // Move edge along its normal vector
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
      // Move single vertex
      slot.quad[mode.i] = {
        x: Math.max(0, Math.min(W, pt.x)),
        y: Math.max(0, Math.min(H, pt.y))
      };
    } else if (slot.persp && mode.t === 'move') {
      // Translate entire perspective quad while keeping bounds within image
      const xs = slot.q0.map(q => q.x);
      const ys = slot.q0.map(q => q.y);
      const dx = Math.max(-Math.min(...xs), Math.min(W - Math.max(...xs), pt.x - slot.p0.x));
      const dy = Math.max(-Math.min(...ys), Math.min(H - Math.max(...ys), pt.y - slot.p0.y));
      slot.quad = slot.q0.map(q => ({ x: q.x + dx, y: q.y + dy }));
    } else if (mode.t === 'move') {
      // Move axis-aligned crop box
      c.x = Math.max(0, Math.min(W - c.w, pt.x - slot.dragOffset.x));
      c.y = Math.max(0, Math.min(H - c.h, pt.y - slot.dragOffset.y));
    } else {
      // Resize axis-aligned crop box with anchor point
      const { ax, ay } = mode.h;
      const sx = pt.x >= ax ? 1 : -1;
      const sy = pt.y >= ay ? 1 : -1;
      const maxW = sx > 0 ? W - ax : ax;
      const maxH = sy > 0 ? H - ay : ay;
      let w = Math.abs(pt.x - ax);
      let h = Math.abs(pt.y - ay);

      if (getOptions().lockAspect) {
        w = Math.max(30, Math.min(w, maxW, maxH * CARD_ASPECT_RATIO));
        h = w / CARD_ASPECT_RATIO;
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
    requestPreview();
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
 * Initializes the image filters and enhancement panel controls.
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
  });

  panel.addEventListener('input', e => {
    const key = e.target.dataset.k;
    if (key) {
      const val = +e.target.value;
      getTargetSlots().forEach(id => {
        slots[id].filter[key] = val;
      });
      requestPreview();
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

  // Pixel color adjustment pass
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

  // 3x3 Sharpening convolution pass
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
 * 
 * Optimized to precalculate row invariant factors, eliminating redundant calculations.
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

  // Projective transformation homography matrix parameters
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

  // Precompute column invariant terms across X axis
  const Au = new Float32Array(outWidth);
  const Du = new Float32Array(outWidth);
  const gu = new Float32Array(outWidth);
  for (let i = 0; i < outWidth; i++) {
    const u = (i + 0.5) / outWidth;
    Au[i] = A * u;
    Du[i] = D * u;
    gu[i] = g * u;
  }

  // Bilinear sampling pixel loop
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

      // Coordinate boundary clamps
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
 * and filtered card image.
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

/**
 * Tests whether a point lies within a polygon using the ray-casting algorithm.
 */
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

/**
 * Calculates aspect ratio of the card crop selection.
 */
function calculateAspectRatio(slot, options) {
  if (!slot.persp) return slot.crop.w / slot.crop.h;
  if (options.lockAspect) return CARD_ASPECT_RATIO;

  const q = slot.quad;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const avgWidth = (dist(q[0], q[1]) + dist(q[3], q[2])) / 2;
  const avgHeight = (dist(q[0], q[3]) + dist(q[1], q[2])) / 2 || 1;
  return avgWidth / avgHeight;
}

/* ==========================================================================
   8. A4 Sheet Composition & Export
   ========================================================================== */

/**
 * Renders the A4 document layout onto a canvas with true physical scale.
 * 
 * Standard A4: 210 mm × 297 mm.
 * At 100 DPI: 827 × 1169 px (preview).
 * At 300 DPI: 2480 × 3508 px (high-res export).
 * 
 * @param {HTMLCanvasElement} canvas Destination canvas.
 * @param {number} dpi Target DPI resolution.
 * @param {boolean} showPlaceholders Whether to draw empty slot outlines.
 */
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
    const cornerRadius = options.roundCorners ? 3.18 * pxPerMm : 0; // standard CR-80 radius is ~3.18 mm

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

/**
 * Batched preview rendering using requestAnimationFrame.
 */
function requestPreview() {
  if (previewRafId) cancelAnimationFrame(previewRafId);
  previewRafId = requestAnimationFrame(() => {
    composeA4Sheet($('#sheet'), 100, true);
    if (!modalState.isOpen) {
      SLOT_IDS.forEach(id => drawThumbnail(slots[id]));
    }
    previewRafId = null;
  });
}

/**
 * Creates full 300 DPI canvas export.
 */
function createExportCanvas() {
  const canvas = document.createElement('canvas');
  composeA4Sheet(canvas, 300, false);
  return canvas;
}

/**
 * Verifies that at least one card image is loaded before export.
 */
function hasLoadedCard() {
  if (!SLOT_IDS.some(id => slots[id].img)) {
    alert('Please add at least one card image first.');
    return false;
  }
  return true;
}

/**
 * Wraps an async button operation with loading state handling.
 */
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

// Export button actions
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

// Sheet configuration input changes
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

window.addEventListener('resize', () => fitModalCanvas());

/* ==========================================================================
   9. Shared Utility Functions
   ========================================================================== */

/**
 * Formats byte size into human-readable KB or MB string.
 */
const formatFileSize = bytes =>
  bytes >= 1048576
    ? (bytes / 1048576).toFixed(2) + ' MB'
    : (bytes / 1024).toFixed(1) + ' KB';

/**
 * Converts a canvas element to a Blob wrapped in a Promise.
 */
const canvasToBlob = (canvas, type, quality) =>
  new Promise(resolve => canvas.toBlob(resolve, type, quality));

/**
 * Yields back to browser event loop to allow UI updates and rendering.
 */
const yieldEventLoop = () => new Promise(resolve => setTimeout(resolve, 0));

/**
 * Sets text content of an element.
 */
const updateStatusText = (element, text) => {
  element.textContent = text;
};

/**
 * Toggles disabled and "Working..." status on a button during long operations.
 */
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

/**
 * Triggers a browser download for a Blob file without leaking memory.
 */
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

/**
 * Reads any image File or Blob into an offscreen canvas with white background.
 */
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

/**
 * Multi-pass binary search JPEG compression to reach target KB size.
 */
async function compressJpegToTarget(canvas, targetKB) {
  const byteLimit = targetKB * 1024;
  let currentCanvas = canvas;

  for (let pass = 0; pass < 8; pass++) {
    let blob = await canvasToBlob(currentCanvas, 'image/jpeg', 0.92);
    if (blob.size <= byteLimit) return blob;

    // Binary search across JPEG quality levels
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

    // Quality alone was insufficient: scale down dimensions by 20%
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

/**
 * Converts a list of page canvas objects to a PDF Blob using jsPDF.
 */
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

/**
 * Rescales page canvas dimensions by factor f.
 */
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

/**
 * Compresses a multi-page PDF document to meet target KB size limit.
 */
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

/**
 * Extracts and renders all pages of a PDF file to canvases at specified DPI.
 */
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

/**
 * Prepares page metadata for image-to-PDF compilation.
 */
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

/**
 * Appends a processed result row with filename, size, and download button.
 */
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

/**
 * Prepends a batch "Download all" action button if multiple files were generated.
 */
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
   10. Multi-file Dropzone Initializers
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
   11. Batch File Conversion Tool
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
   12. Batch File Compression Tool
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

      // Check if file is already under the target limit
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
   13. Full-Screen Interactive Editor Modal & Loupe
   ========================================================================== */

function mountThumbnail(slot) {
  slot.thumb = document.createElement('canvas');
  slot.thumb.className = 'thumb';
  slot.thumb.title = 'Tap to edit the crop';
  slot.thumb.addEventListener('click', () => openModalEditor(slot));

  const actionRow = document.createElement('div');
  actionRow.className = 'row';
  actionRow.style.justifyContent = 'center';

  const editBtn = document.createElement('button');
  editBtn.className = 'primary';
  editBtn.textContent = 'Edit crop';
  editBtn.addEventListener('click', () => openModalEditor(slot));

  actionRow.append(editBtn);
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
    hint.textContent =
      'Drag the square corners onto the card corners. Drag the round dots on each edge to resize. Drag inside to move.';
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

  $('#m-title').textContent = slot.id === 'front' ? 'Front side' : 'Back side';
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

  requestPreview();
}

/**
 * Convex hull calculation via monotone chain Graham scan.
 */
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

/**
 * Finds intersection point between two line segments (a-b and c-d).
 */
function intersectSegments(a, b, c, d) {
  const denom = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / denom;
  return t > 1 ? { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) } : null;
}

/**
 * Iteratively simplifies a convex polygon into a 4-corner quadrilateral.
 */
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

/**
 * Automated card detection algorithm:
 * 1. Downscales image to thumbnail for fast processing.
 * 2. Samples border ring to estimate background color.
 * 3. Calculates Euclidean color distance map.
 * 4. Applies Otsu's thresholding to isolate card foreground.
 * 5. Identifies largest connected component via BFS flood-fill.
 * 6. Finds convex hull and simplifies to 4-corner quad.
 * 7. Orders corners cyclically (top-left, top-right, bottom-right, bottom-left).
 */
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

  // Median background color estimation
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

  // Otsu's thresholding
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

  // Connected component labeling (BFS flood fill)
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

  // Extract edge boundary pixels
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

  // Rescale back to original image dimensions
  const originalQuad = quad.map(p => ({
    x: Math.max(0, Math.min(img.width, p.x / scaleFactor)),
    y: Math.max(0, Math.min(img.height, p.y / scaleFactor))
  }));

  // Sort corners by angle around centroid
  const cx = originalQuad.reduce((acc, p) => acc + p.x, 0) / 4;
  const cy = originalQuad.reduce((acc, p) => acc + p.y, 0) / 4;
  originalQuad.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));

  // Find top-left corner (minimum sum of x + y)
  let topIndex = 0;
  originalQuad.forEach((p, i) => {
    if (p.x + p.y < originalQuad[topIndex].x + originalQuad[topIndex].y) {
      topIndex = i;
    }
  });

  return [0, 1, 2, 3].map(i => originalQuad[(topIndex + i) % 4]);
}

/**
 * Runs card detection and automatically sets up perspective crop.
 */
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

  // Auto-rotate if card was scanned vertically
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

/**
 * Magnifier loupe displayed while dragging corners or edges.
 */
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

  // Overlay quad boundary
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

  // Overlay center crosshairs
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(LOUPE_SIZE / 2, LOUPE_SIZE / 2 - 22);
  ctx.lineTo(LOUPE_SIZE / 2, LOUPE_SIZE / 2 + 22);
  ctx.moveTo(LOUPE_SIZE / 2 - 22, LOUPE_SIZE / 2);
  ctx.lineTo(LOUPE_SIZE / 2 + 22, LOUPE_SIZE / 2);
  ctx.stroke();

  // Position loupe without blocking user cursor
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

// Modal control toolbar buttons
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
    requestPreview();
  }
});

$('#m-cancel').addEventListener('click', () => closeModalEditor(false));
$('#m-done').addEventListener('click', () => closeModalEditor(true));

window.addEventListener('keydown', e => {
  if (e.key === 'Escape' && modalState.isOpen) {
    closeModalEditor(false);
  }
});

/* ==========================================================================
   14. Hash-based SPA Router & Navigation
   ========================================================================== */

const APP_PAGES = ['home', 'a4', 'convert', 'compress'];
const ROUTE_ALIASES = {
  'a4-id': 'a4',
  id: 'a4',
  home: 'home',
  '': 'home'
};
const PAGE_TITLES = {
  home: 'Card & File Tools — Free & Private In-Browser Tools',
  a4: 'ID Card to A4 — Fit & Print ID Cards',
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
  }
}

window.addEventListener('hashchange', handleRouteChange);

// Initial application boot
handleRouteChange();
requestPreview();
