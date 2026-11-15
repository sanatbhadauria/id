mod engine;
mod layout;
mod models;
mod print;
mod web;

use clap::{Args, Parser, Subcommand};
use engine::{export_pdf, export_sheet_image, export_single_photo, load_pixbuf, PathOrBytes};
use models::{
    Alignment, BorderStyle, ComposeOptions, ImageAdjustments, Orientation, PaperSize, PhotoPreset,
    TextStripConfig, TextStripStyle, TextStripType,
};
use print::print_document;
use std::path::PathBuf;

#[derive(Parser, Debug)]
#[command(
    name = "passport-photo-printer",
    author = "Sanat Bhadauria",
    version = "1.0.0",
    about = "High-precision passport and visa photo grid composer, editor, and print studio in Rust.",
    long_about = "Compose multi-photo grids for 4×6\", 5×7\", A4, A5, and Letter photo paper with millimeter precision, candidate name/date stamps, cutting borders, and true 100% scale vector PDF & 300 DPI image outputs."
)]
struct Cli {
    #[command(subcommand)]
    command: Option<Commands>,

    #[command(flatten)]
    compose_args: Option<ComposeCliArgs>,
}

#[derive(Subcommand, Debug)]
enum Commands {
    /// Compose photos onto a multi-photo print sheet (PDF or high-res image)
    Compose(ComposeCliArgs),

    /// Crop and export a single compliant passport photo for online application portals
    Crop(CropCliArgs),

    /// Compose sheet and send directly to your printer or system viewer
    Print(ComposeCliArgs),

    /// Launch the interactive browser-based visual studio
    Web {
        /// Local port to bind web server (default: 8080)
        #[arg(short, long, default_value_t = 8080)]
        port: u16,
    },

    /// List standard international passport sizes, paper dimensions, and portal guidelines
    Presets,
}

#[derive(Args, Debug, Clone)]
pub struct ComposeCliArgs {
    /// Path to input photo file (JPEG, PNG, WebP, TIFF, BMP)
    #[arg(short, long)]
    input: Option<PathBuf>,

    /// Path to output file (.pdf, .jpg, or .png)
    #[arg(short, long, default_value = "passport-photos.pdf")]
    output: PathBuf,

    /// Photo size preset: 35x45, 51x51 (2x2"), 35x35, 30x40, 33x48, 50x70, or custom WxH in mm
    #[arg(long, default_value = "35x45")]
    preset: String,

    /// Paper size: 4x6 (4R), 5x7 (5R), a4, a5, letter, or custom WxH in mm
    #[arg(long, default_value = "4x6")]
    paper: String,

    /// Sheet orientation: auto, portrait, or landscape
    #[arg(long, default_value = "auto")]
    orientation: String,

    /// Number of photos to print (omit to fill entire page)
    #[arg(short = 'n', long)]
    count: Option<usize>,

    /// Grid alignment: center or topleft
    #[arg(long, default_value = "center")]
    alignment: String,

    /// Spacing between photos in millimeters
    #[arg(long, default_value_t = 2.5)]
    gap: f64,

    /// Sheet outer margin in millimeters
    #[arg(long, default_value_t = 5.0)]
    margin: f64,

    /// Cutting guide border style: hairline, dashed, cropmarks, or none
    #[arg(long, default_value = "hairline")]
    border: String,

    /// Text stamp format: none, name_dop, name_dob, dop, dob, name, or custom
    #[arg(long, default_value = "none")]
    text_type: String,

    /// Candidate full name for text stamp
    #[arg(long)]
    name: Option<String>,

    /// Date for text stamp in DD/MM/YYYY (omit to use today's date)
    #[arg(long)]
    date: Option<String>,

    /// Optional line 2 text for custom text stamps
    #[arg(long)]
    custom_line2: Option<String>,

    /// Text strip style: white_strip, black_strip, or overlay
    #[arg(long, default_value = "white_strip")]
    text_style: String,

    /// Brightness adjustment [-100 .. 100]
    #[arg(long, default_value_t = 0.0)]
    brightness: f64,

    /// Contrast adjustment [-100 .. 100]
    #[arg(long, default_value_t = 0.0)]
    contrast: f64,

    /// Color saturation adjustment [-100 .. 100]
    #[arg(long, default_value_t = 0.0)]
    saturation: f64,

    /// Convert photo to grayscale / black & white
    #[arg(long, default_value_t = false)]
    grayscale: bool,

    /// Rotate photo clockwise: 0, 90, 180, 270 degrees
    #[arg(long, default_value_t = 0)]
    rotate: u32,

    /// Flip photo horizontally
    #[arg(long, default_value_t = false)]
    flip: bool,

    /// Simultaneous zoom scale factor [0.5 .. 2.0]
    #[arg(long, default_value_t = 1.0)]
    scale: f64,

    /// Output resolution in DPI for image outputs (default: 300)
    #[arg(long, default_value_t = 300)]
    dpi: u32,

    /// JPEG quality [10 .. 100] for JPEG outputs
    #[arg(long, default_value_t = 95)]
    jpeg_quality: i32,
}

#[derive(Args, Debug, Clone)]
pub struct CropCliArgs {
    /// Path to input photo file
    #[arg(short, long)]
    input: PathBuf,

    /// Path to output photo file (default: passport-single.jpg)
    #[arg(short, long, default_value = "passport-single.jpg")]
    output: PathBuf,

    /// Photo size preset: 35x45, 51x51, 35x35, 30x40, 33x48, 50x70, or custom WxH
    #[arg(long, default_value = "35x45")]
    preset: String,

    /// Text stamp format: none, name_dop, name_dob, dop, dob, name, or custom
    #[arg(long, default_value = "none")]
    text_type: String,

    /// Candidate full name
    #[arg(long)]
    name: Option<String>,

    /// Date in DD/MM/YYYY
    #[arg(long)]
    date: Option<String>,

    /// Text strip style: white_strip, black_strip, or overlay
    #[arg(long, default_value = "white_strip")]
    text_style: String,

    /// Brightness adjustment [-100 .. 100]
    #[arg(long, default_value_t = 0.0)]
    brightness: f64,

    /// Contrast adjustment [-100 .. 100]
    #[arg(long, default_value_t = 0.0)]
    contrast: f64,

    /// Saturation adjustment [-100 .. 100]
    #[arg(long, default_value_t = 0.0)]
    saturation: f64,

    /// Convert to grayscale
    #[arg(long, default_value_t = false)]
    grayscale: bool,

    /// Rotate clockwise: 0, 90, 180, 270
    #[arg(long, default_value_t = 0)]
    rotate: u32,

    /// Flip horizontally
    #[arg(long, default_value_t = false)]
    flip: bool,

    /// Zoom scale factor [0.5 .. 2.0]
    #[arg(long, default_value_t = 1.0)]
    scale: f64,

    /// Output DPI (default: 300)
    #[arg(long, default_value_t = 300)]
    dpi: u32,

    /// JPEG quality [10 .. 100]
    #[arg(long, default_value_t = 95)]
    jpeg_quality: i32,
}

fn main() {
    let cli = Cli::parse();

    match cli.command {
        Some(Commands::Compose(args)) => run_compose(args, false),
        Some(Commands::Crop(args)) => run_crop(args),
        Some(Commands::Print(args)) => run_compose(args, true),
        Some(Commands::Web { port }) => web::start_web_server(port),
        Some(Commands::Presets) => print_presets_table(),
        None => {
            // Check if top-level arguments with an input file were provided
            if let Some(args) = cli.compose_args {
                if args.input.is_some() {
                    run_compose(args, false);
                    return;
                }
            }
            // Default action: launch visual interactive web studio
            println!("No CLI command provided. Launching visual Passport Photo Studio in your browser...");
            web::start_web_server(8080);
        }
    }
}

fn build_compose_options(args: &ComposeCliArgs) -> ComposeOptions {
    let paper = PaperSize::parse(&args.paper).unwrap_or_else(|| {
        eprintln!("Warning: Unknown paper '{}', using 4x6 (4R)", args.paper);
        PaperSize::FourBySix
    });

    let preset = PhotoPreset::parse(&args.preset).unwrap_or_else(|| {
        eprintln!("Warning: Unknown preset '{}', using 35x45 mm", args.preset);
        PhotoPreset::Standard35x45
    });

    ComposeOptions {
        paper,
        orientation: Orientation::parse(&args.orientation),
        preset,
        count: args.count,
        alignment: Alignment::parse(&args.alignment),
        gap_mm: args.gap.max(0.0),
        margin_mm: args.margin.max(0.0),
        border: BorderStyle::parse(&args.border),
        text_strip: TextStripConfig {
            strip_type: TextStripType::parse(&args.text_type),
            name: args.name.clone().unwrap_or_default(),
            date: args.date.clone().unwrap_or_default(),
            custom_line2: args.custom_line2.clone().unwrap_or_default(),
            style: TextStripStyle::parse(&args.text_style),
            uppercase: true,
        },
        crop: None,
        adjustments: ImageAdjustments {
            brightness: args.brightness,
            contrast: args.contrast,
            saturation: args.saturation,
            grayscale: args.grayscale,
            rotate: args.rotate,
            flip_h: args.flip,
            scale: args.scale.clamp(0.5, 2.0),
        },
        dpi: args.dpi,
    }
}

fn run_compose(args: ComposeCliArgs, print_directly: bool) {
    let input_path = match &args.input {
        Some(p) => p,
        None => {
            eprintln!("Error: Input photo file is required (--input <file>). Run with --help for details.");
            std::process::exit(1);
        }
    };

    if !input_path.exists() {
        eprintln!("Error: Input file does not exist: {}", input_path.display());
        std::process::exit(1);
    }

    println!("Loading photo from: {}", input_path.display());
    let source_pixbuf = match load_pixbuf(&PathOrBytes::FilePath(input_path)) {
        Ok(pb) => pb,
        Err(e) => {
            eprintln!("Error loading image: {}", e);
            std::process::exit(1);
        }
    };

    let opts = build_compose_options(&args);
    let output_path = &args.output;
    let ext = output_path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("pdf")
        .to_lowercase();

    let is_pdf = ext == "pdf";
    let is_jpeg = ext == "jpg" || ext == "jpeg";

    println!(
        "Composing {} on {} ({:?})...",
        opts.preset.name(),
        opts.paper.name(),
        opts.orientation
    );

    let layout = if is_pdf {
        match export_pdf(&source_pixbuf, &opts, output_path) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("Error generating PDF: {}", e);
                std::process::exit(1);
            }
        }
    } else {
        match export_sheet_image(&source_pixbuf, &opts, output_path, is_jpeg, args.jpeg_quality) {
            Ok(l) => l,
            Err(e) => {
                eprintln!("Error generating image: {}", e);
                std::process::exit(1);
            }
        }
    };

    println!("\n✓ Success! Generated:");
    println!("  Output File:   {}", output_path.display());
    println!("  Total Photos:  {} placed on sheet", layout.items.len());
    println!("  Grid Format:   {} columns × {} rows", layout.cols, layout.rows);
    println!("  Physical Size: {:.1} × {:.1} mm (100% True Scale)", layout.paper_w_mm, layout.paper_h_mm);
    if is_pdf {
        println!("  Output Format: Vector PDF (Print at 100% scale without shrinking)");
    } else {
        println!("  Resolution:    {} DPI ({} × {} px)", args.dpi, layout.paper_w_px(args.dpi), layout.paper_h_px(args.dpi));
    }

    if print_directly {
        println!("\nSending document to printer...");
        match print_document(output_path, &opts.paper.key()) {
            Ok(msg) => println!("✓ {}", msg),
            Err(err) => eprintln!("Print notice: {}", err),
        }
    }
}

fn run_crop(args: CropCliArgs) {
    if !args.input.exists() {
        eprintln!("Error: Input file does not exist: {}", args.input.display());
        std::process::exit(1);
    }

    let source_pixbuf = match load_pixbuf(&PathOrBytes::FilePath(&args.input)) {
        Ok(pb) => pb,
        Err(e) => {
            eprintln!("Error loading image: {}", e);
            std::process::exit(1);
        }
    };

    let preset = PhotoPreset::parse(&args.preset).unwrap_or(PhotoPreset::Standard35x45);
    let opts = ComposeOptions {
        preset,
        text_strip: TextStripConfig {
            strip_type: TextStripType::parse(&args.text_type),
            name: args.name.unwrap_or_default(),
            date: args.date.unwrap_or_default(),
            custom_line2: String::new(),
            style: TextStripStyle::parse(&args.text_style),
            uppercase: true,
        },
        adjustments: ImageAdjustments {
            brightness: args.brightness,
            contrast: args.contrast,
            saturation: args.saturation,
            grayscale: args.grayscale,
            rotate: args.rotate,
            flip_h: args.flip,
            scale: args.scale,
        },
        dpi: args.dpi,
        ..Default::default()
    };

    let is_jpeg = args
        .output
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.eq_ignore_ascii_case("jpg") || s.eq_ignore_ascii_case("jpeg"))
        .unwrap_or(true);

    match export_single_photo(&source_pixbuf, &opts, &args.output, is_jpeg, args.jpeg_quality) {
        Ok((w_px, h_px)) => {
            let (w_mm, h_mm) = opts.preset.dimensions_mm();
            println!("\n✓ Single passport photo exported successfully!");
            println!("  File:       {}", args.output.display());
            println!("  Dimensions: {:.1} × {:.1} mm ({} × {} px at {} DPI)", w_mm, h_mm, w_px, h_px, args.dpi);
            println!("  Ready for online upload portals (UPSC, SSC, OCI, Visa).");
        }
        Err(e) => {
            eprintln!("Error exporting photo: {}", e);
            std::process::exit(1);
        }
    }
}

fn print_presets_table() {
    println!("\n===============================================================================");
    println!("              SUPPORTED PASSPORT PHOTO PRESETS & SPECIFICATIONS                ");
    println!("===============================================================================");
    println!("  Preset Key | Dimensions (mm) | Common Usage / Country Standards");
    println!("  -----------+-----------------+------------------------------------------------");
    println!("  35x45      | 35 × 45 mm      | Standard Passport: UK, Schengen (EU), India,");
    println!("             |                 | Australia, Singapore, UAE, Russia, New Zealand");
    println!("  51x51      | 50.8 × 50.8 mm  | US Passport, US Visa (2×2 inches), India OCI");
    println!("  35x35      | 35 × 35 mm      | India State Govt Portals, SSC, Police, Banking");
    println!("  30x40      | 30 × 40 mm      | Japan, South Korea, Indonesia, Philippines");
    println!("  33x48      | 33 × 48 mm      | China Visa & Passport");
    println!("  50x70      | 50 × 70 mm      | Canada Passport");
    println!("  custom     | Custom WxH      | Specify any dimensions via --preset <W>x<H>");
    println!("\n===============================================================================");
    println!("                           STANDARD PAPER SIZES                                ");
    println!("===============================================================================");
    println!("  Paper Key  | Dimensions (mm) | Notes");
    println!("  -----------+-----------------+------------------------------------------------");
    println!("  4x6        | 101.6 × 152.4 mm| 4R Photo Paper (Most economical for home/kiosk)");
    println!("  5x7        | 127.0 × 177.8 mm| 5R Photo Paper");
    println!("  a4         | 210.0 × 297.0 mm| Standard International Document Paper");
    println!("  a5         | 148.0 × 210.0 mm| Half-A4 Document Paper");
    println!("  letter     | 215.9 × 279.4 mm| US Standard Letter Paper (8.5 × 11 inches)");
    println!("===============================================================================\n");
}
