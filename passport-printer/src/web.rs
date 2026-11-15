use crate::engine::{
    export_pdf, export_sheet_image, export_single_photo, load_pixbuf, process_single_photo_pixbuf,
    pixbuf_to_cairo_surface, render_passport_photo, PathOrBytes,
};
use crate::layout::calculate_sheet_layout;
use crate::models::{
    Alignment, BorderStyle, ComposeOptions, CropRect, ImageAdjustments, Orientation, PaperSize,
    PhotoPreset, TextStripConfig, TextStripStyle, TextStripType,
};
use crate::print::print_document;
use cairo::{Context, Format, ImageSurface};
use serde::{Deserialize, Serialize};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::sync::Arc;

/// JSON payload received from Web UI.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebRenderRequest {
    pub image_base64: String,
    pub paper: String,
    pub orientation: String,
    pub preset: String,
    pub custom_w: Option<f64>,
    pub custom_h: Option<f64>,
    pub count: Option<usize>,
    pub alignment: String,
    pub gap_mm: f64,
    pub margin_mm: f64,
    pub border: String,
    pub text_type: String,
    pub text_name: String,
    pub text_date: String,
    pub text_custom2: String,
    pub text_style: String,
    pub brightness: f64,
    pub contrast: f64,
    pub saturation: f64,
    pub grayscale: bool,
    pub rotate: u32,
    pub flip_h: bool,
    pub scale: f64,
    pub crop_x: Option<f64>,
    pub crop_y: Option<f64>,
    pub crop_w: Option<f64>,
    pub crop_h: Option<f64>,
}

impl WebRenderRequest {
    pub fn to_compose_options(&self) -> ComposeOptions {
        let paper = if let (Some(w), Some(h)) = (self.custom_w, self.custom_h) {
            if self.paper == "custom" {
                PaperSize::Custom(w, h)
            } else {
                PaperSize::parse(&self.paper).unwrap_or(PaperSize::FourBySix)
            }
        } else {
            PaperSize::parse(&self.paper).unwrap_or(PaperSize::FourBySix)
        };

        let preset = if let (Some(w), Some(h)) = (self.custom_w, self.custom_h) {
            if self.preset == "custom" {
                PhotoPreset::Custom(w, h)
            } else {
                PhotoPreset::parse(&self.preset).unwrap_or(PhotoPreset::Standard35x45)
            }
        } else {
            PhotoPreset::parse(&self.preset).unwrap_or(PhotoPreset::Standard35x45)
        };

        let crop = if let (Some(x), Some(y), Some(w), Some(h)) =
            (self.crop_x, self.crop_y, self.crop_w, self.crop_h)
        {
            Some(CropRect { x, y, w, h })
        } else {
            None
        };

        ComposeOptions {
            paper,
            orientation: Orientation::parse(&self.orientation),
            preset,
            count: self.count,
            alignment: Alignment::parse(&self.alignment),
            gap_mm: self.gap_mm,
            margin_mm: self.margin_mm,
            border: BorderStyle::parse(&self.border),
            text_strip: TextStripConfig {
                strip_type: TextStripType::parse(&self.text_type),
                name: self.text_name.clone(),
                date: self.text_date.clone(),
                custom_line2: self.text_custom2.clone(),
                style: TextStripStyle::parse(&self.text_style),
                uppercase: true,
            },
            crop,
            adjustments: ImageAdjustments {
                brightness: self.brightness,
                contrast: self.contrast,
                saturation: self.saturation,
                grayscale: self.grayscale,
                rotate: self.rotate,
                flip_h: self.flip_h,
                scale: self.scale,
            },
            dpi: 300,
        }
    }
}

/// Starts the embedded web studio.
pub fn start_web_server(requested_port: u16) {
    let mut port = requested_port;
    let listener = loop {
        match TcpListener::bind(("127.0.0.1", port)) {
            Ok(l) => break l,
            Err(_) => {
                port += 1;
                if port > requested_port + 50 {
                    eprintln!("Error: Could not bind to any local port between {} and {}", requested_port, port);
                    return;
                }
            }
        }
    };

    let url = format!("http://127.0.0.1:{}", port);
    println!("\n╔═══════════════════════════════════════════════════════════════╗");
    println!("║       Passport Photo Studio — Interactive Web Interface       ║");
    println!("╠═══════════════════════════════════════════════════════════════╣");
    println!("║  Local Server running at: {:<35} ║", url);
    println!("║  Opening browser automatically...                             ║");
    println!("║  Press Ctrl+C in terminal to stop server                      ║");
    println!("╚═══════════════════════════════════════════════════════════════╝\n");

    let _ = open::that(&url);

    let html_content = Arc::new(include_str!("index.html").to_string());

    for stream in listener.incoming() {
        if let Ok(stream) = stream {
            let html = Arc::clone(&html_content);
            std::thread::spawn(move || {
                handle_http_client(stream, html);
            });
        }
    }
}

fn handle_http_client(mut stream: TcpStream, html: Arc<String>) {
    let mut buffer = Vec::new();
    let mut temp = [0u8; 4096];

    // Read headers
    let header_end_pos;
    loop {
        match stream.read(&mut temp) {
            Ok(0) => return,
            Ok(n) => {
                buffer.extend_from_slice(&temp[..n]);
                if let Some(pos) = find_subsequence(&buffer, b"\r\n\r\n") {
                    header_end_pos = pos + 4;
                    break;
                }
            }
            Err(_) => return,
        }
    }

    let (method, path, content_length) = {
        let header_str = String::from_utf8_lossy(&buffer[..header_end_pos]);
        let first_line = header_str.lines().next().unwrap_or("");
        let parts: Vec<&str> = first_line.split_whitespace().collect();
        let m = parts.first().copied().unwrap_or("").to_string();
        let p = parts.get(1).copied().unwrap_or("").to_string();
        let mut cl = 0usize;
        for line in header_str.lines() {
            if line.to_lowercase().starts_with("content-length:") {
                if let Some(val) = line.split(':').nth(1) {
                    cl = val.trim().parse::<usize>().unwrap_or(0);
                }
            }
        }
        (m, p, cl)
    };

    // Read remaining body if POST
    while buffer.len() - header_end_pos < content_length {
        match stream.read(&mut temp) {
            Ok(0) => break,
            Ok(n) => buffer.extend_from_slice(&temp[..n]),
            Err(_) => break,
        }
    }

    let body = &buffer[header_end_pos..];

    match (method.as_str(), path.as_str()) {
        ("GET", "/") | ("GET", "/index.html") => {
            let bytes = html.as_bytes();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                bytes.len()
            );
            let _ = stream.write_all(response.as_bytes());
            let _ = stream.write_all(bytes);
        }
        ("POST", "/api/preview") => {
            handle_api_preview(&mut stream, body);
        }
        ("POST", "/api/export/pdf") => {
            handle_api_export_pdf(&mut stream, body);
        }
        ("POST", "/api/export/jpeg") => {
            handle_api_export_jpeg(&mut stream, body);
        }
        ("POST", "/api/export/single") => {
            handle_api_export_single(&mut stream, body);
        }
        ("POST", "/api/print") => {
            handle_api_print(&mut stream, body);
        }
        _ => {
            let not_found = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
            let _ = stream.write_all(not_found.as_bytes());
        }
    }
}

fn handle_api_preview(stream: &mut TcpStream, body: &[u8]) {
    if let Ok(req) = serde_json::from_slice::<WebRenderRequest>(body) {
        let opts = req.to_compose_options();
        if let Ok(raw_bytes) = parse_base64_image(&req.image_base64) {
            if let Ok(source_pixbuf) = load_pixbuf(&PathOrBytes::Bytes(&raw_bytes)) {
                let layout = calculate_sheet_layout(&opts);
                let dpi = 150u32;
                let pw_px = layout.paper_w_px(dpi) as i32;
                let ph_px = layout.paper_h_px(dpi) as i32;

                let (p_w_mm, p_h_mm) = opts.preset.dimensions_mm();
                let photo_px_w = ((p_w_mm * (dpi as f64) / 25.4).round()) as i32;
                let photo_px_h = ((p_h_mm * (dpi as f64) / 25.4).round()) as i32;

                if let Ok(single_pixbuf) = process_single_photo_pixbuf(
                    &source_pixbuf,
                    photo_px_w,
                    photo_px_h,
                    opts.crop,
                    &opts.adjustments,
                ) {
                    if let Ok(photo_surface) = pixbuf_to_cairo_surface(&single_pixbuf) {
                        if let Ok(surface) = ImageSurface::create(Format::ARgb32, pw_px, ph_px) {
                            if let Ok(ctx) = Context::new(&surface) {
                                ctx.set_source_rgb(1.0, 1.0, 1.0);
                                let _ = ctx.paint();

                                let px_per_mm = (dpi as f64) / 25.4;
                                for item in &layout.items {
                                    let x = item.x_mm * px_per_mm;
                                    let y = item.y_mm * px_per_mm;
                                    let w = item.w_mm * px_per_mm;
                                    let h = item.h_mm * px_per_mm;
                                    let _ = render_passport_photo(&ctx, &photo_surface, x, y, w, h, &opts);
                                }

                                let mut png_data = Vec::new();
                                if surface.write_to_png(&mut png_data).is_ok() {
                                    send_binary_response(stream, "image/png", &png_data);
                                    return;
                                }
                            }
                        }
                    }
                }
            }
        }
    }
    send_error_response(stream, "Failed to render preview");
}

fn handle_api_export_pdf(stream: &mut TcpStream, body: &[u8]) {
    if let Ok(req) = serde_json::from_slice::<WebRenderRequest>(body) {
        let opts = req.to_compose_options();
        if let Ok(raw_bytes) = parse_base64_image(&req.image_base64) {
            if let Ok(source_pixbuf) = load_pixbuf(&PathOrBytes::Bytes(&raw_bytes)) {
                let temp_dir = std::env::temp_dir();
                let temp_pdf = temp_dir.join(format!("passport-photos-{}.pdf", std::process::id()));

                if export_pdf(&source_pixbuf, &opts, &temp_pdf).is_ok() {
                    if let Ok(pdf_bytes) = std::fs::read(&temp_pdf) {
                        let _ = std::fs::remove_file(&temp_pdf);
                        send_attachment_response(stream, "application/pdf", "passport-photos.pdf", &pdf_bytes);
                        return;
                    }
                }
            }
        }
    }
    send_error_response(stream, "Failed to generate PDF");
}

fn handle_api_export_jpeg(stream: &mut TcpStream, body: &[u8]) {
    if let Ok(req) = serde_json::from_slice::<WebRenderRequest>(body) {
        let opts = req.to_compose_options();
        if let Ok(raw_bytes) = parse_base64_image(&req.image_base64) {
            if let Ok(source_pixbuf) = load_pixbuf(&PathOrBytes::Bytes(&raw_bytes)) {
                let temp_dir = std::env::temp_dir();
                let temp_jpg = temp_dir.join(format!("passport-sheet-{}.jpg", std::process::id()));

                if export_sheet_image(&source_pixbuf, &opts, &temp_jpg, true, 95).is_ok() {
                    if let Ok(jpg_bytes) = std::fs::read(&temp_jpg) {
                        let _ = std::fs::remove_file(&temp_jpg);
                        send_attachment_response(stream, "image/jpeg", "passport-sheet-300dpi.jpg", &jpg_bytes);
                        return;
                    }
                }
            }
        }
    }
    send_error_response(stream, "Failed to generate JPEG sheet");
}

fn handle_api_export_single(stream: &mut TcpStream, body: &[u8]) {
    if let Ok(req) = serde_json::from_slice::<WebRenderRequest>(body) {
        let opts = req.to_compose_options();
        if let Ok(raw_bytes) = parse_base64_image(&req.image_base64) {
            if let Ok(source_pixbuf) = load_pixbuf(&PathOrBytes::Bytes(&raw_bytes)) {
                let temp_dir = std::env::temp_dir();
                let (pw, ph) = opts.preset.dimensions_mm();
                let filename = format!("passport-photo-{}x{}mm.jpg", pw as i32, ph as i32);
                let temp_file = temp_dir.join(&filename);

                if export_single_photo(&source_pixbuf, &opts, &temp_file, true, 95).is_ok() {
                    if let Ok(img_bytes) = std::fs::read(&temp_file) {
                        let _ = std::fs::remove_file(&temp_file);
                        send_attachment_response(stream, "image/jpeg", &filename, &img_bytes);
                        return;
                    }
                }
            }
        }
    }
    send_error_response(stream, "Failed to generate single photo");
}

fn handle_api_print(stream: &mut TcpStream, body: &[u8]) {
    if let Ok(req) = serde_json::from_slice::<WebRenderRequest>(body) {
        let opts = req.to_compose_options();
        if let Ok(raw_bytes) = parse_base64_image(&req.image_base64) {
            if let Ok(source_pixbuf) = load_pixbuf(&PathOrBytes::Bytes(&raw_bytes)) {
                let temp_dir = std::env::temp_dir();
                let temp_pdf = temp_dir.join(format!("passport-print-{}.pdf", std::process::id()));

                if export_pdf(&source_pixbuf, &opts, &temp_pdf).is_ok() {
                    let msg = print_document(&temp_pdf, &opts.paper.key()).unwrap_or_else(|e| e);
                    let resp = format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                        msg.len(),
                        msg
                    );
                    let _ = stream.write_all(resp.as_bytes());
                    return;
                }
            }
        }
    }
    send_error_response(stream, "Failed to print document");
}

fn parse_base64_image(data_uri_or_base64: &str) -> Result<Vec<u8>, String> {
    let clean = if let Some(idx) = data_uri_or_base64.find(',') {
        &data_uri_or_base64[idx + 1..]
    } else {
        data_uri_or_base64
    };

    decode_base64(clean.trim()).map_err(|e| format!("Base64 decode error: {}", e))
}

fn decode_base64(input: &str) -> Result<Vec<u8>, &'static str> {
    let mut out = Vec::with_capacity(input.len() * 3 / 4);
    let mut buf = 0u32;
    let mut bits = 0u32;

    for b in input.bytes() {
        let val = match b {
            b'A'..=b'Z' => (b - b'A') as u32,
            b'a'..=b'z' => (b - b'a' + 26) as u32,
            b'0'..=b'9' => (b - b'0' + 52) as u32,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\r' | b'\n' | b' ' => continue,
            _ => return Err("Invalid character in base64"),
        };
        buf = (buf << 6) | val;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xFF) as u8);
        }
    }
    Ok(out)
}

fn send_binary_response(stream: &mut TcpStream, content_type: &str, data: &[u8]) {
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
        content_type,
        data.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(data);
}

fn send_attachment_response(stream: &mut TcpStream, content_type: &str, filename: &str, data: &[u8]) {
    let header = format!(
        "HTTP/1.1 200 OK\r\nContent-Type: {}\r\nContent-Disposition: attachment; filename=\"{}\"\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n",
        content_type,
        filename,
        data.len()
    );
    let _ = stream.write_all(header.as_bytes());
    let _ = stream.write_all(data);
}

fn send_error_response(stream: &mut TcpStream, message: &str) {
    let resp = format!(
        "HTTP/1.1 500 Internal Server Error\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
        message.len(),
        message
    );
    let _ = stream.write_all(resp.as_bytes());
}

fn find_subsequence(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack.windows(needle.len()).position(|window| window == needle)
}
