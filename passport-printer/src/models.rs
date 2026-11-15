use serde::{Deserialize, Serialize};

/// Standard paper sizes in millimeters.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PaperSize {
    #[serde(rename = "4x6")]
    FourBySix, // 101.6 x 152.4 mm (4R)
    #[serde(rename = "5x7")]
    FiveBySeven, // 127.0 x 177.8 mm (5R)
    A4,        // 210.0 x 297.0 mm
    A5,        // 148.0 x 210.0 mm
    Letter,    // 215.9 x 279.4 mm (8.5 x 11 inch)
    Custom(f64, f64),
}

impl PaperSize {
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_lowercase().trim() {
            "4x6" | "4r" | "photo" => Some(PaperSize::FourBySix),
            "5x7" | "5r" => Some(PaperSize::FiveBySeven),
            "a4" => Some(PaperSize::A4),
            "a5" => Some(PaperSize::A5),
            "letter" | "usletter" => Some(PaperSize::Letter),
            custom => {
                if let Some((w, h)) = custom.split_once('x') {
                    if let (Ok(width), Ok(height)) = (w.trim().parse::<f64>(), h.trim().parse::<f64>()) {
                        return Some(PaperSize::Custom(width, height));
                    }
                }
                None
            }
        }
    }

    pub fn dimensions_mm(&self) -> (f64, f64) {
        match self {
            PaperSize::FourBySix => (101.6, 152.4),
            PaperSize::FiveBySeven => (127.0, 177.8),
            PaperSize::A4 => (210.0, 297.0),
            PaperSize::A5 => (148.0, 210.0),
            PaperSize::Letter => (215.9, 279.4),
            PaperSize::Custom(w, h) => (*w, *h),
        }
    }

    pub fn name(&self) -> String {
        match self {
            PaperSize::FourBySix => "4 × 6 inch (4R Photo)".to_string(),
            PaperSize::FiveBySeven => "5 × 7 inch (5R Photo)".to_string(),
            PaperSize::A4 => "A4 (210 × 297 mm)".to_string(),
            PaperSize::A5 => "A5 (148 × 210 mm)".to_string(),
            PaperSize::Letter => "US Letter (8.5 × 11 in)".to_string(),
            PaperSize::Custom(w, h) => format!("Custom ({} × {} mm)", w, h),
        }
    }

    pub fn key(&self) -> String {
        match self {
            PaperSize::FourBySix => "4x6".to_string(),
            PaperSize::FiveBySeven => "5x7".to_string(),
            PaperSize::A4 => "a4".to_string(),
            PaperSize::A5 => "a5".to_string(),
            PaperSize::Letter => "letter".to_string(),
            PaperSize::Custom(w, h) => format!("{}x{}", w, h),
        }
    }
}

/// Sheet orientation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Orientation {
    Auto,
    Portrait,
    Landscape,
}

impl Orientation {
    pub fn parse(s: &str) -> Self {
        match s.to_lowercase().trim() {
            "portrait" | "port" | "p" => Orientation::Portrait,
            "landscape" | "land" | "l" => Orientation::Landscape,
            _ => Orientation::Auto,
        }
    }
}

/// Standard international passport & visa photo presets.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PhotoPreset {
    /// 35 x 45 mm: Standard Passport (India, UK, Schengen / EU, Australia, Singapore, etc.)
    #[serde(rename = "35x45")]
    Standard35x45,
    /// 51 x 51 mm / 2 x 2 inch: US Visa & Passport, India OCI
    #[serde(rename = "51x51")]
    Us2x2,
    /// 35 x 35 mm: India Police, State Boards, Bank Exams
    #[serde(rename = "35x35")]
    India35x35,
    /// 30 x 40 mm: Japan, Korea, Indonesia
    #[serde(rename = "30x40")]
    Japan30x40,
    /// 33 x 48 mm: China Visa & Passport
    #[serde(rename = "33x48")]
    China33x48,
    /// 50 x 70 mm: Canada Passport
    #[serde(rename = "50x70")]
    Canada50x70,
    /// Custom dimensions (width mm, height mm)
    Custom(f64, f64),
}

impl PhotoPreset {
    pub fn parse(s: &str) -> Option<Self> {
        match s.to_lowercase().trim() {
            "35x45" | "passport" | "standard" | "uk" | "schengen" | "india" => {
                Some(PhotoPreset::Standard35x45)
            }
            "51x51" | "2x2" | "us" | "us-visa" | "oci" => Some(PhotoPreset::Us2x2),
            "35x35" => Some(PhotoPreset::India35x35),
            "30x40" | "japan" | "korea" => Some(PhotoPreset::Japan30x40),
            "33x48" | "china" => Some(PhotoPreset::China33x48),
            "50x70" | "canada" => Some(PhotoPreset::Canada50x70),
            custom => {
                if let Some((w, h)) = custom.split_once('x') {
                    if let (Ok(width), Ok(height)) = (w.trim().parse::<f64>(), h.trim().parse::<f64>()) {
                        return Some(PhotoPreset::Custom(width, height));
                    }
                }
                None
            }
        }
    }

    pub fn dimensions_mm(&self) -> (f64, f64) {
        match self {
            PhotoPreset::Standard35x45 => (35.0, 45.0),
            PhotoPreset::Us2x2 => (50.8, 50.8),
            PhotoPreset::India35x35 => (35.0, 35.0),
            PhotoPreset::Japan30x40 => (30.0, 40.0),
            PhotoPreset::China33x48 => (33.0, 48.0),
            PhotoPreset::Canada50x70 => (50.0, 70.0),
            PhotoPreset::Custom(w, h) => (*w, *h),
        }
    }

    #[allow(dead_code)]
    pub fn aspect_ratio(&self) -> f64 {
        let (w, h) = self.dimensions_mm();
        w / h
    }

    pub fn name(&self) -> String {
        match self {
            PhotoPreset::Standard35x45 => "35 × 45 mm (Standard Passport / UK / Schengen / India)".to_string(),
            PhotoPreset::Us2x2 => "51 × 51 mm / 2 × 2\" (US Visa & Passport / India OCI)".to_string(),
            PhotoPreset::India35x35 => "35 × 35 mm (State Exams / Police)".to_string(),
            PhotoPreset::Japan30x40 => "30 × 40 mm (Japan / Korea / Indonesia)".to_string(),
            PhotoPreset::China33x48 => "33 × 48 mm (China Visa & Passport)".to_string(),
            PhotoPreset::Canada50x70 => "50 × 70 mm (Canada Passport)".to_string(),
            PhotoPreset::Custom(w, h) => format!("Custom ({} × {} mm)", w, h),
        }
    }

    #[allow(dead_code)]
    pub fn key(&self) -> String {
        match self {
            PhotoPreset::Standard35x45 => "35x45".to_string(),
            PhotoPreset::Us2x2 => "51x51".to_string(),
            PhotoPreset::India35x35 => "35x35".to_string(),
            PhotoPreset::Japan30x40 => "30x40".to_string(),
            PhotoPreset::China33x48 => "33x48".to_string(),
            PhotoPreset::Canada50x70 => "50x70".to_string(),
            PhotoPreset::Custom(w, h) => format!("{}x{}", w, h),
        }
    }
}

/// Grid alignment within paper sheet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Alignment {
    Center,
    TopLeft,
}

impl Alignment {
    pub fn parse(s: &str) -> Self {
        match s.to_lowercase().trim() {
            "topleft" | "top-left" | "tl" => Alignment::TopLeft,
            _ => Alignment::Center,
        }
    }
}

/// Cutting guide border style around photos.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BorderStyle {
    Hairline,
    Dashed,
    CropMarks,
    None,
}

impl BorderStyle {
    pub fn parse(s: &str) -> Self {
        match s.to_lowercase().trim() {
            "dashed" => BorderStyle::Dashed,
            "cropmarks" | "crop-marks" | "marks" => BorderStyle::CropMarks,
            "none" | "off" | "false" => BorderStyle::None,
            _ => BorderStyle::Hairline,
        }
    }
}

/// Text strip type for government/exam portals.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextStripType {
    None,
    NameDop,
    NameDob,
    Dop,
    Dob,
    Name,
    Custom,
}

impl TextStripType {
    pub fn parse(s: &str) -> Self {
        match s.to_lowercase().trim() {
            "name_dop" | "name-dop" | "namedop" => TextStripType::NameDop,
            "name_dob" | "name-dob" | "namedob" => TextStripType::NameDob,
            "dop" => TextStripType::Dop,
            "dob" => TextStripType::Dob,
            "name" => TextStripType::Name,
            "custom" => TextStripType::Custom,
            _ => TextStripType::None,
        }
    }
}

/// Visual style for text strip.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TextStripStyle {
    WhiteStrip,
    BlackStrip,
    Overlay,
}

impl TextStripStyle {
    pub fn parse(s: &str) -> Self {
        match s.to_lowercase().trim() {
            "black" | "black_strip" | "black-strip" => TextStripStyle::BlackStrip,
            "overlay" | "semi" => TextStripStyle::Overlay,
            _ => TextStripStyle::WhiteStrip,
        }
    }
}

/// Configuration for bottom text & date stamps.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TextStripConfig {
    pub strip_type: TextStripType,
    pub name: String,
    pub date: String,
    pub custom_line2: String,
    pub style: TextStripStyle,
    pub uppercase: bool,
}

impl Default for TextStripConfig {
    fn default() -> Self {
        Self {
            strip_type: TextStripType::None,
            name: String::new(),
            date: String::new(),
            custom_line2: String::new(),
            style: TextStripStyle::WhiteStrip,
            uppercase: true,
        }
    }
}

impl TextStripConfig {
    pub fn get_lines(&self) -> Vec<String> {
        let fmt = |s: &str| -> String {
            if self.uppercase {
                s.trim().to_uppercase()
            } else {
                s.trim().to_string()
            }
        };

        let name = fmt(&self.name);
        let date = if self.date.trim().is_empty() {
            let now = std::time::SystemTime::now();
            let dt = chrono_format_today(now);
            fmt(&dt)
        } else {
            fmt(&self.date)
        };
        let custom2 = fmt(&self.custom_line2);

        let mut lines = Vec::new();
        match self.strip_type {
            TextStripType::None => {}
            TextStripType::NameDop => {
                if !name.is_empty() {
                    lines.push(name);
                }
                lines.push(format!("DOP: {}", date));
            }
            TextStripType::NameDob => {
                if !name.is_empty() {
                    lines.push(name);
                }
                lines.push(format!("DOB: {}", date));
            }
            TextStripType::Dop => {
                lines.push(format!("DOP: {}", date));
            }
            TextStripType::Dob => {
                lines.push(format!("DOB: {}", date));
            }
            TextStripType::Name => {
                if !name.is_empty() {
                    lines.push(name);
                }
            }
            TextStripType::Custom => {
                if !name.is_empty() {
                    lines.push(name);
                }
                if !custom2.is_empty() {
                    lines.push(custom2);
                }
            }
        }
        lines
    }
}

fn chrono_format_today(st: std::time::SystemTime) -> String {
    use std::time::UNIX_EPOCH;
    if let Ok(duration) = st.duration_since(UNIX_EPOCH) {
        let secs = duration.as_secs();
        // Convert Unix timestamp to DD/MM/YYYY (UTC)
        let days = secs / 86400;
        let mut y = 1970i64;
        let mut d = days as i64;
        loop {
            let leap = (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0);
            let days_in_year = if leap { 366 } else { 365 };
            if d >= days_in_year {
                d -= days_in_year;
                y += 1;
            } else {
                break;
            }
        }
        let leap = (y % 4 == 0 && y % 100 != 0) || (y % 400 == 0);
        let days_in_months = [
            31,
            if leap { 29 } else { 28 },
            31,
            30,
            31,
            30,
            31,
            31,
            30,
            31,
            30,
            31,
        ];
        let mut m = 1;
        for dim in days_in_months {
            if d >= dim {
                d -= dim;
                m += 1;
            } else {
                break;
            }
        }
        let day = d + 1;
        return format!("{:02}/{:02}/{:04}", day, m, y);
    }
    "01/01/2026".to_string()
}

/// Normalized crop box [0.0..1.0] relative to original image dimensions.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct CropRect {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

impl Default for CropRect {
    fn default() -> Self {
        Self {
            x: 0.0,
            y: 0.0,
            w: 1.0,
            h: 1.0,
        }
    }
}

/// Image adjustment parameters.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct ImageAdjustments {
    pub brightness: f64, // -100.0 .. +100.0
    pub contrast: f64,   // -100.0 .. +100.0
    pub saturation: f64, // -100.0 .. +100.0
    pub grayscale: bool,
    pub rotate: u32,     // 0, 90, 180, 270
    pub flip_h: bool,
    pub scale: f64,      // 0.5 .. 2.0 (1.0 = 100%)
}

impl Default for ImageAdjustments {
    fn default() -> Self {
        Self {
            brightness: 0.0,
            contrast: 0.0,
            saturation: 0.0,
            grayscale: false,
            rotate: 0,
            flip_h: false,
            scale: 1.0,
        }
    }
}

/// Full compose request options.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ComposeOptions {
    pub paper: PaperSize,
    pub orientation: Orientation,
    pub preset: PhotoPreset,
    pub count: Option<usize>, // None = fill page
    pub alignment: Alignment,
    pub gap_mm: f64,          // default: 2.5 mm
    pub margin_mm: f64,       // default: 5.0 mm
    pub border: BorderStyle,
    pub text_strip: TextStripConfig,
    pub crop: Option<CropRect>,
    pub adjustments: ImageAdjustments,
    pub dpi: u32,             // default: 300 DPI
}

impl Default for ComposeOptions {
    fn default() -> Self {
        Self {
            paper: PaperSize::FourBySix,
            orientation: Orientation::Auto,
            preset: PhotoPreset::Standard35x45,
            count: None,
            alignment: Alignment::Center,
            gap_mm: 2.5,
            margin_mm: 5.0,
            border: BorderStyle::Hairline,
            text_strip: TextStripConfig::default(),
            crop: None,
            adjustments: ImageAdjustments::default(),
            dpi: 300,
        }
    }
}
