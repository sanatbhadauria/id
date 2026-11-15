use crate::layout::{calculate_sheet_layout, SheetLayout};
use crate::models::{BorderStyle, ComposeOptions, CropRect, ImageAdjustments, TextStripStyle};
use cairo::{Context, Format, ImageSurface, PdfSurface};
use gdk_pixbuf::{Colorspace, InterpType, Pixbuf};
use std::io::Cursor;
use std::path::Path;

/// Core rendering engine error type.
#[derive(Debug)]
pub enum EngineError {
    ImageLoad(String),
    Cairo(cairo::Error),
    Io(std::io::Error),
}

impl std::fmt::Display for EngineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            EngineError::ImageLoad(msg) => write!(f, "Failed to load image: {}", msg),
            EngineError::Cairo(err) => write!(f, "Cairo rendering error: {}", err),
            EngineError::Io(err) => write!(f, "I/O error: {}", err),
        }
    }
}

impl std::error::Error for EngineError {}

impl From<cairo::Error> for EngineError {
    fn from(err: cairo::Error) -> Self {
        EngineError::Cairo(err)
    }
}

impl From<cairo::IoError> for EngineError {
    fn from(err: cairo::IoError) -> Self {
        EngineError::ImageLoad(format!("Cairo I/O error: {}", err))
    }
}

impl From<std::io::Error> for EngineError {
    fn from(err: std::io::Error) -> Self {
        EngineError::Io(err)
    }
}

/// Loads a Pixbuf from file path or raw bytes.
pub fn load_pixbuf(path_or_bytes: &PathOrBytes) -> Result<Pixbuf, EngineError> {
    match path_or_bytes {
        PathOrBytes::FilePath(path) => {
            Pixbuf::from_file(path).map_err(|e| EngineError::ImageLoad(e.to_string()))
        }
        PathOrBytes::Bytes(bytes) => {
            let cursor = Cursor::new(bytes.to_vec());
            Pixbuf::from_read(cursor).map_err(|e| EngineError::ImageLoad(e.to_string()))
        }
    }
}

pub enum PathOrBytes<'a> {
    FilePath(&'a Path),
    Bytes(&'a [u8]),
}

/// Applies rotation, flipping, cropping, adjustments, and sizing to produce a processed single photo Pixbuf.
pub fn process_single_photo_pixbuf(
    source: &Pixbuf,
    target_w_px: i32,
    target_h_px: i32,
    crop: Option<CropRect>,
    adjustments: &ImageAdjustments,
) -> Result<Pixbuf, EngineError> {
    let mut current = source.clone();

    // 1. Rotation
    match adjustments.rotate % 360 {
        90 => {
            current = current
                .rotate_simple(gdk_pixbuf::PixbufRotation::Clockwise)
                .ok_or_else(|| EngineError::ImageLoad("Failed to rotate 90°".to_string()))?;
        }
        180 => {
            current = current
                .rotate_simple(gdk_pixbuf::PixbufRotation::Upsidedown)
                .ok_or_else(|| EngineError::ImageLoad("Failed to rotate 180°".to_string()))?;
        }
        270 => {
            current = current
                .rotate_simple(gdk_pixbuf::PixbufRotation::Counterclockwise)
                .ok_or_else(|| EngineError::ImageLoad("Failed to rotate 270°".to_string()))?;
        }
        _ => {}
    }

    // 2. Horizontal flip
    if adjustments.flip_h {
        current = current
            .flip(true)
            .ok_or_else(|| EngineError::ImageLoad("Failed to flip photo".to_string()))?;
    }

    let orig_w = current.width() as f64;
    let orig_h = current.height() as f64;
    let target_aspect = (target_w_px as f64) / (target_h_px as f64);

    // 3. Crop Rectangle Calculation
    let (cx, cy, cw, ch) = match crop {
        Some(c) => {
            // Apply scale slider to crop center if scale != 1.0
            let scale = adjustments.scale.clamp(0.5, 2.0);
            let scaled_w = (c.w / scale).clamp(0.1, 1.0);
            let scaled_h = (c.h / scale).clamp(0.1, 1.0);
            let center_x = c.x + c.w / 2.0;
            let center_y = c.y + c.h / 2.0;

            let final_x = (center_x - scaled_w / 2.0).clamp(0.0, 1.0 - scaled_w);
            let final_y = (center_y - scaled_h / 2.0).clamp(0.0, 1.0 - scaled_h);

            let px_x = (final_x * orig_w).round() as i32;
            let px_y = (final_y * orig_h).round() as i32;
            let px_w = (scaled_w * orig_w).round() as i32;
            let px_h = (scaled_h * orig_h).round() as i32;
            (px_x, px_y, px_w, px_h)
        }
        None => {
            // Intelligent auto-centering aspect crop
            let orig_aspect = orig_w / orig_h;
            let (cw_f, ch_f) = if orig_aspect > target_aspect {
                let h = orig_h;
                let w = h * target_aspect;
                (w, h)
            } else {
                let w = orig_w;
                let h = w / target_aspect;
                (w, h)
            };

            let scale = adjustments.scale.clamp(0.5, 2.0);
            let final_w = (cw_f / scale).clamp(30.0, orig_w);
            let final_h = (ch_f / scale).clamp(30.0, orig_h);

            let px_x = (((orig_w - final_w) / 2.0).round() as i32).max(0);
            let px_y = (((orig_h - final_h) / 2.0).round() as i32).max(0);
            let px_w = (final_w.round() as i32).min(current.width() - px_x);
            let px_h = (final_h.round() as i32).min(current.height() - px_y);
            (px_x, px_y, px_w, px_h)
        }
    };

    let safe_x = cx.clamp(0, current.width() - 1);
    let safe_y = cy.clamp(0, current.height() - 1);
    let safe_w = cw.clamp(1, current.width() - safe_x);
    let safe_h = ch.clamp(1, current.height() - safe_y);

    let cropped = current.new_subpixbuf(safe_x, safe_y, safe_w, safe_h);

    let scaled = cropped
        .scale_simple(target_w_px, target_h_px, InterpType::Bilinear)
        .ok_or_else(|| EngineError::ImageLoad("Failed to scale photo to target size".to_string()))?;

    let final_pixbuf = apply_color_adjustments(&scaled, adjustments)?;
    Ok(final_pixbuf)
}

fn apply_color_adjustments(
    pixbuf: &Pixbuf,
    adj: &ImageAdjustments,
) -> Result<Pixbuf, EngineError> {
    let has_brightness = adj.brightness.abs() > 0.001;
    let has_contrast = adj.contrast.abs() > 0.001;
    let has_saturation = adj.saturation.abs() > 0.001;
    let is_grayscale = adj.grayscale;

    if !has_brightness && !has_contrast && !has_saturation && !is_grayscale {
        return Ok(pixbuf.clone());
    }

    let w = pixbuf.width();
    let h = pixbuf.height();
    let n_channels = pixbuf.n_channels();
    let has_alpha = pixbuf.has_alpha();
    let rowstride = pixbuf.rowstride() as usize;

    let result = Pixbuf::new(Colorspace::Rgb, has_alpha, 8, w, h)
        .ok_or_else(|| EngineError::ImageLoad("Cannot allocate adjusted pixbuf".to_string()))?;

    let src_bytes = unsafe { pixbuf.pixels() };
    let dst_bytes = unsafe { result.pixels() };

    let br = adj.brightness.clamp(-100.0, 100.0) * 2.55;
    let ct = adj.contrast.clamp(-100.0, 100.0);
    let cf = (259.0 * (ct + 255.0)) / (255.0 * (259.0 - ct).max(1.0));
    let sat_factor = (1.0 + adj.saturation.clamp(-100.0, 100.0) / 100.0).max(0.0);

    for y in 0..h as usize {
        let src_row = y * rowstride;
        let dst_row = y * (result.rowstride() as usize);

        for x in 0..w as usize {
            let src_idx = src_row + x * (n_channels as usize);
            let dst_idx = dst_row + x * (if has_alpha { 4 } else { 3 });

            let mut r = src_bytes[src_idx] as f64;
            let mut g = src_bytes[src_idx + 1] as f64;
            let mut b = src_bytes[src_idx + 2] as f64;

            if has_brightness {
                r += br;
                g += br;
                b += br;
            }

            if has_contrast {
                r = cf * (r - 128.0) + 128.0;
                g = cf * (g - 128.0) + 128.0;
                b = cf * (b - 128.0) + 128.0;
            }

            if is_grayscale {
                let gray = (0.299 * r + 0.587 * g + 0.114 * b).clamp(0.0, 255.0);
                r = gray;
                g = gray;
                b = gray;
            } else if has_saturation {
                let gray = 0.299 * r + 0.587 * g + 0.114 * b;
                r = (gray + (r - gray) * sat_factor).clamp(0.0, 255.0);
                g = (gray + (g - gray) * sat_factor).clamp(0.0, 255.0);
                b = (gray + (b - gray) * sat_factor).clamp(0.0, 255.0);
            }

            dst_bytes[dst_idx] = r.clamp(0.0, 255.0) as u8;
            dst_bytes[dst_idx + 1] = g.clamp(0.0, 255.0) as u8;
            dst_bytes[dst_idx + 2] = b.clamp(0.0, 255.0) as u8;

            if has_alpha {
                dst_bytes[dst_idx + 3] = src_bytes[src_idx + 3];
            }
        }
    }

    Ok(result)
}

/// Converts a GdkPixbuf into a Cairo ImageSurface via in-memory PNG.
pub fn pixbuf_to_cairo_surface(pixbuf: &Pixbuf) -> Result<ImageSurface, EngineError> {
    let png_bytes = pixbuf
        .save_to_bufferv("png", &[])
        .map_err(|e| EngineError::ImageLoad(format!("Pixbuf to PNG error: {}", e)))?;
    let mut cursor = Cursor::new(png_bytes);
    ImageSurface::create_from_png(&mut cursor)
        .map_err(|e| EngineError::ImageLoad(format!("Cairo create_from_png error: {}", e)))
}

/// Renders a single passport photo onto a Cairo context at specified physical (x, y, w, h).
pub fn render_passport_photo(
    ctx: &Context,
    photo_surface: &ImageSurface,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    opts: &ComposeOptions,
) -> Result<(), EngineError> {
    ctx.save()?;

    // 1. Draw photo image scaled into (x, y, w, h)
    ctx.save()?;
    let img_w = photo_surface.width() as f64;
    let img_h = photo_surface.height() as f64;

    ctx.translate(x, y);
    ctx.scale(w / img_w, h / img_h);
    ctx.set_source_surface(photo_surface, 0.0, 0.0)?;
    ctx.paint()?;
    ctx.restore()?;

    // 2. Draw Text Strip (Name / DOP / DOB) if present
    let lines = opts.text_strip.get_lines();
    if !lines.is_empty() {
        render_text_strip(ctx, x, y, w, h, &lines, opts.text_strip.style)?;
    }

    // 3. Draw Cutting Borders or Marks
    render_photo_borders(ctx, x, y, w, h, opts.border)?;

    ctx.restore()?;
    Ok(())
}

fn render_text_strip(
    ctx: &Context,
    photo_x: f64,
    photo_y: f64,
    photo_w: f64,
    photo_h: f64,
    lines: &[String],
    style: TextStripStyle,
) -> Result<(), EngineError> {
    let num_lines = lines.len();
    let strip_h = photo_h * if num_lines == 1 { 0.14 } else { 0.23 };
    let strip_y = photo_y + photo_h - strip_h;

    ctx.save()?;

    match style {
        TextStripStyle::WhiteStrip => {
            ctx.set_source_rgb(1.0, 1.0, 1.0);
            ctx.rectangle(photo_x, strip_y, photo_w, strip_h);
            ctx.fill()?;
            ctx.set_source_rgba(0.0, 0.0, 0.0, 0.15);
            ctx.set_line_width(strip_h * 0.02);
            ctx.move_to(photo_x, strip_y);
            ctx.line_to(photo_x + photo_w, strip_y);
            ctx.stroke()?;
            ctx.set_source_rgb(0.05, 0.05, 0.05);
        }
        TextStripStyle::BlackStrip => {
            ctx.set_source_rgb(0.08, 0.10, 0.14);
            ctx.rectangle(photo_x, strip_y, photo_w, strip_h);
            ctx.fill()?;
            ctx.set_source_rgb(1.0, 1.0, 1.0);
        }
        TextStripStyle::Overlay => {
            ctx.set_source_rgba(0.08, 0.10, 0.14, 0.85);
            ctx.rectangle(photo_x, strip_y, photo_w, strip_h);
            ctx.fill()?;
            ctx.set_source_rgb(1.0, 1.0, 1.0);
        }
    }

    ctx.select_font_face("Sans", cairo::FontSlant::Normal, cairo::FontWeight::Bold);
    let max_text_w = photo_w * 0.92;
    let mut font_size = strip_h / (if num_lines == 1 { 2.1 } else { 3.1 });

    ctx.set_font_size(font_size);
    for line in lines {
        if let Ok(ext) = ctx.text_extents(line) {
            if ext.width() > max_text_w && ext.width() > 0.0 {
                font_size = (font_size * (max_text_w / ext.width())).max(4.0);
                ctx.set_font_size(font_size);
            }
        }
    }

    let center_x = photo_x + photo_w / 2.0;
    if num_lines == 1 {
        let text = &lines[0];
        if let Ok(ext) = ctx.text_extents(text) {
            let ty = strip_y + (strip_h / 2.0) - (ext.height() / 2.0) - ext.y_bearing();
            let tx = center_x - (ext.width() / 2.0) - ext.x_bearing();
            ctx.move_to(tx, ty);
            ctx.show_text(text)?;
        }
    } else {
        let line_h = strip_h / (num_lines as f64);
        for (i, line) in lines.iter().enumerate() {
            if let Ok(ext) = ctx.text_extents(line) {
                let cy = strip_y + (i as f64 + 0.5) * line_h;
                let ty = cy - (ext.height() / 2.0) - ext.y_bearing();
                let tx = center_x - (ext.width() / 2.0) - ext.x_bearing();
                ctx.move_to(tx, ty);
                ctx.show_text(line)?;
            }
        }
    }

    ctx.restore()?;
    Ok(())
}

fn render_photo_borders(
    ctx: &Context,
    x: f64,
    y: f64,
    w: f64,
    h: f64,
    border: BorderStyle,
) -> Result<(), EngineError> {
    ctx.save()?;
    match border {
        BorderStyle::Hairline => {
            ctx.set_source_rgba(0.70, 0.74, 0.80, 0.85);
            ctx.set_line_width(0.25);
            ctx.rectangle(x, y, w, h);
            ctx.stroke()?;
        }
        BorderStyle::Dashed => {
            ctx.set_source_rgba(0.40, 0.45, 0.55, 0.90);
            ctx.set_line_width(0.35);
            ctx.set_dash(&[3.0, 2.0], 0.0);
            ctx.rectangle(x, y, w, h);
            ctx.stroke()?;
        }
        BorderStyle::CropMarks => {
            ctx.set_source_rgba(0.30, 0.35, 0.42, 0.95);
            ctx.set_line_width(0.35);
            let mark_len = 3.0;

            ctx.move_to(x - mark_len, y);
            ctx.line_to(x, y);
            ctx.move_to(x, y - mark_len);
            ctx.line_to(x, y);

            ctx.move_to(x + w, y);
            ctx.line_to(x + w + mark_len, y);
            ctx.move_to(x + w, y - mark_len);
            ctx.line_to(x + w, y);

            ctx.move_to(x - mark_len, y + h);
            ctx.line_to(x, y + h);
            ctx.move_to(x, y + h);
            ctx.line_to(x, y + h + mark_len);

            ctx.move_to(x + w, y + h);
            ctx.line_to(x + w + mark_len, y + h);
            ctx.move_to(x + w, y + h);
            ctx.line_to(x + w, y + h + mark_len);

            ctx.stroke()?;
        }
        BorderStyle::None => {}
    }
    ctx.restore()?;
    Ok(())
}

/// Generates a true physical 100% scale PDF file.
pub fn export_pdf(
    source_pixbuf: &Pixbuf,
    opts: &ComposeOptions,
    output_path: &Path,
) -> Result<SheetLayout, EngineError> {
    let layout = calculate_sheet_layout(opts);
    let paper_w_pts = layout.paper_w_pts();
    let paper_h_pts = layout.paper_h_pts();

    let (pw_mm, ph_mm) = opts.preset.dimensions_mm();
    let pw_px = ((pw_mm * 300.0 / 25.4).round()) as i32;
    let ph_px = ((ph_mm * 300.0 / 25.4).round()) as i32;

    let single_pixbuf = process_single_photo_pixbuf(
        source_pixbuf,
        pw_px,
        ph_px,
        opts.crop,
        &opts.adjustments,
    )?;
    let photo_surface = pixbuf_to_cairo_surface(&single_pixbuf)?;

    let pdf_surface = PdfSurface::new(paper_w_pts, paper_h_pts, output_path)?;
    let ctx = Context::new(&pdf_surface)?;

    ctx.set_source_rgb(1.0, 1.0, 1.0);
    ctx.paint()?;

    let pts_per_mm = 72.0 / 25.4;

    for item in &layout.items {
        let x_pts = item.x_mm * pts_per_mm;
        let y_pts = item.y_mm * pts_per_mm;
        let w_pts = item.w_mm * pts_per_mm;
        let h_pts = item.h_mm * pts_per_mm;

        render_passport_photo(&ctx, &photo_surface, x_pts, y_pts, w_pts, h_pts, opts)?;
    }

    pdf_surface.finish();
    Ok(layout)
}

/// Generates a high-resolution composite sheet image (PNG or JPEG) at specified DPI.
pub fn export_sheet_image(
    source_pixbuf: &Pixbuf,
    opts: &ComposeOptions,
    output_path: &Path,
    is_jpeg: bool,
    jpeg_quality: i32,
) -> Result<SheetLayout, EngineError> {
    let layout = calculate_sheet_layout(opts);
    let dpi = opts.dpi.max(100);

    let paper_w_px = layout.paper_w_px(dpi) as i32;
    let paper_h_px = layout.paper_h_px(dpi) as i32;

    let (pw_mm, ph_mm) = opts.preset.dimensions_mm();
    let pw_px = ((pw_mm * (dpi as f64) / 25.4).round()) as i32;
    let ph_px = ((ph_mm * (dpi as f64) / 25.4).round()) as i32;

    let single_pixbuf = process_single_photo_pixbuf(
        source_pixbuf,
        pw_px,
        ph_px,
        opts.crop,
        &opts.adjustments,
    )?;
    let photo_surface = pixbuf_to_cairo_surface(&single_pixbuf)?;

    let surface = ImageSurface::create(Format::ARgb32, paper_w_px, paper_h_px)?;
    let ctx = Context::new(&surface)?;

    ctx.set_source_rgb(1.0, 1.0, 1.0);
    ctx.paint()?;

    let px_per_mm = (dpi as f64) / 25.4;

    for item in &layout.items {
        let x_px = item.x_mm * px_per_mm;
        let y_px = item.y_mm * px_per_mm;
        let w_px = item.w_mm * px_per_mm;
        let h_px = item.h_mm * px_per_mm;

        render_passport_photo(&ctx, &photo_surface, x_px, y_px, w_px, h_px, opts)?;
    }

    if is_jpeg {
        let mut png_bytes = Vec::new();
        surface.write_to_png(&mut png_bytes)?;
        let cursor = Cursor::new(png_bytes);
        let out_pixbuf = Pixbuf::from_read(cursor)
            .map_err(|e| EngineError::ImageLoad(format!("Pixbuf conversion error: {}", e)))?;

        let q_str = jpeg_quality.clamp(10, 100).to_string();
        out_pixbuf
            .savev(output_path, "jpeg", &[("quality", &q_str)])
            .map_err(|e| EngineError::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())))?;
    } else {
        let mut file = std::fs::File::create(output_path)?;
        surface.write_to_png(&mut file)?;
    }

    Ok(layout)
}

/// Generates a single cropped passport photo at standard 300 DPI for online application portals.
pub fn export_single_photo(
    source_pixbuf: &Pixbuf,
    opts: &ComposeOptions,
    output_path: &Path,
    is_jpeg: bool,
    jpeg_quality: i32,
) -> Result<(u32, u32), EngineError> {
    let (pw_mm, ph_mm) = opts.preset.dimensions_mm();
    let dpi = opts.dpi.max(150);
    let pw_px = ((pw_mm * (dpi as f64) / 25.4).round()) as i32;
    let ph_px = ((ph_mm * (dpi as f64) / 25.4).round()) as i32;

    let single_pixbuf = process_single_photo_pixbuf(
        source_pixbuf,
        pw_px,
        ph_px,
        opts.crop,
        &opts.adjustments,
    )?;
    let photo_surface = pixbuf_to_cairo_surface(&single_pixbuf)?;

    let surface = ImageSurface::create(Format::ARgb32, pw_px, ph_px)?;
    let ctx = Context::new(&surface)?;

    let mut single_opts = opts.clone();
    single_opts.border = BorderStyle::None;

    render_passport_photo(&ctx, &photo_surface, 0.0, 0.0, pw_px as f64, ph_px as f64, &single_opts)?;

    if is_jpeg {
        let mut png_bytes = Vec::new();
        surface.write_to_png(&mut png_bytes)?;
        let cursor = Cursor::new(png_bytes);
        let out_pixbuf = Pixbuf::from_read(cursor)
            .map_err(|e| EngineError::ImageLoad(format!("Pixbuf conversion error: {}", e)))?;

        let q_str = jpeg_quality.clamp(10, 100).to_string();
        out_pixbuf
            .savev(output_path, "jpeg", &[("quality", &q_str)])
            .map_err(|e| EngineError::Io(std::io::Error::new(std::io::ErrorKind::Other, e.to_string())))?;
    } else {
        let mut file = std::fs::File::create(output_path)?;
        surface.write_to_png(&mut file)?;
    }

    Ok((pw_px as u32, ph_px as u32))
}
