# Passport Photo Studio (Rust)

A high-precision, standalone Rust application to format, customize, grid, and print passport and visa photos with millimeter accuracy. Everything processes 100% locally on your device with native Cairo vector PDF and 300 DPI composite image generation.

---

## Highlights & Features

- **True 1:1 Physical Scale**: Generates genuine vector PDF documents at exact physical dimensions (e.g., 4×6" photo paper or A4). Printing at 100% scale produces millimeter-perfect photos without printer distortion.
- **Dual Interface**:
  - **Visual Interactive Web Studio (`web`)**: Embedded zero-dependency web interface with live real-time print preview, drag-and-drop upload, sliders, and one-click PDF/JPEG export.
  - **Headless CLI (`compose` & `crop`)**: Full command-line automation for scripts, batch workflows, and server pipelines.
- **International Passport & Visa Presets**:
  - `35x45` (35 × 45 mm) — Standard Passport (UK, Schengen / EU, India, Australia, Singapore, UAE, etc.)
  - `51x51` (50.8 × 50.8 mm / 2 × 2") — US Visa & Passport, India OCI
  - `35x35` (35 × 35 mm) — India State Govt, Police, Banking, SSC
  - `30x40` (30 × 40 mm) — Japan, South Korea, Indonesia
  - `33x48` (33 × 48 mm) — China Visa & Passport
  - `50x70` (50 × 70 mm) — Canada Passport
  - `custom` (`--preset <W>x<H>`) — Any arbitrary millimeter dimensions
- **Multi-Paper Printing**:
  - `4x6` (101.6 × 152.4 mm / 4R Photo Paper) — standard photo lab & kiosk paper
  - `5x7` (127.0 × 177.8 mm / 5R Photo Paper)
  - `a4` (210.0 × 297.0 mm)
  - `a5` (148.0 × 210.0 mm)
  - `letter` (8.5 × 11 inches)
- **Exam & Portal Text Stamps**:
  - Candidate Full Name & Date of Photo (`DOP: DD/MM/YYYY`) or Date of Birth (`DOB`) compliant with UPSC, SSC, state PSC, and portal upload rules.
  - White strip, black strip, or dark semi-transparent overlay styles with auto-shrinking font to prevent text clipping.
- **Cutting Guides & Borders**:
  - `hairline` — 0.25mm thin cutting outline for precision scissor or rotary trimmer cuts.
  - `cropmarks` — L-shaped corner tick marks.
  - `dashed` — Dashed cut guide lines.
  - `none` — Borderless printing.
- **Image Adjustments**:
  - Brightness, contrast, saturation sliders, grayscale (B&W) conversion, 90° rotation, horizontal flip, and proportional zoom scale (50% – 200%).
- **Direct System Print**:
  - Native integration with CUPS `lpr` utility to send print jobs directly to your printer at 100% scale, or fallback to the system default viewer.

---

## Building

```bash
cd passport-printer
cargo build --release
```

The compiled binary will be placed at `target/release/passport-photo-printer`.

---

## Usage

### 1. Interactive Visual Web Studio (Recommended)

Run without arguments (or with `web`):

```bash
cargo run -- web
# or:
./target/release/passport-photo-printer web --port 8080
```

Opens your default web browser to `http://127.0.0.1:8080` with the complete visual studio:
- Drag-and-drop your photo.
- Adjust framing, presets, paper, and sliders.
- Inspect the live, real-time print preview.
- Click **Download Print-Ready PDF (100% Scale)** or **Download JPEG Sheet (300 DPI)**.

---

### 2. Command-Line Interface (CLI)

#### A. Standard Passport (35×45 mm) on 4×6" Photo Paper (PDF)
```bash
passport-photo-printer compose \
  --input photo.jpg \
  --paper 4x6 \
  --preset 35x45 \
  --output passport-4x6.pdf
```

#### B. Exam Portal Stamp (Candidate Name & DOP)
```bash
passport-photo-printer compose \
  --input photo.jpg \
  --paper 4x6 \
  --preset 35x45 \
  --text-type name_dop \
  --name "RAHUL SHARMA" \
  --date "14/11/2026" \
  --output passport-with-dop.pdf
```

#### C. US Visa 2×2" (51×51 mm) Grid on A4 Paper
```bash
passport-photo-printer compose \
  --input photo.jpg \
  --paper a4 \
  --preset 51x51 \
  --output us-visa-a4.pdf
```

#### D. High-Resolution 300 DPI JPEG Sheet (for Photo Lab Printing)
```bash
passport-photo-printer compose \
  --input photo.jpg \
  --paper 4x6 \
  --preset 35x45 \
  --dpi 300 \
  --output passport-sheet-300dpi.jpg
```

#### E. Single Cropped Photo for Online Upload Portals
```bash
passport-photo-printer crop \
  --input photo.jpg \
  --preset 35x45 \
  --text-type name_dop \
  --name "RAHUL SHARMA" \
  --output portal-upload.jpg
```

#### F. Direct Printing via System Printer (CUPS / lpr)
```bash
passport-photo-printer print \
  --input photo.jpg \
  --paper 4x6 \
  --preset 35x45
```

#### G. List All Supported Presets & Paper Sizes
```bash
passport-photo-printer presets
```

---

## CLI Options Reference

| Flag | Description | Default |
|---|---|---|
| `-i, --input <PATH>` | Path to input photo file | *(Required for CLI)* |
| `-o, --output <PATH>` | Path to output file (`.pdf`, `.jpg`, `.png`) | `passport-photos.pdf` |
| `--preset <KEY>` | `35x45`, `51x51`, `35x35`, `30x40`, `33x48`, `50x70`, or `WxH` | `35x45` |
| `--paper <KEY>` | `4x6`, `5x7`, `a4`, `a5`, `letter`, or `WxH` | `4x6` |
| `--orientation <DIR>` | `auto`, `portrait`, or `landscape` | `auto` |
| `-n, --count <N>` | Exact number of photos (omit to fill sheet) | *All fitting* |
| `--alignment <ALIGN>` | `center` or `topleft` | `center` |
| `--gap <MM>` | Spacing between photos in mm | `2.5` |
| `--margin <MM>` | Sheet outer margin in mm | `5.0` |
| `--border <STYLE>` | `hairline`, `cropmarks`, `dashed`, `none` | `hairline` |
| `--text-type <TYPE>` | `none`, `name_dop`, `name_dob`, `dop`, `dob`, `name`, `custom` | `none` |
| `--name <NAME>` | Candidate full name | *(None)* |
| `--date <DATE>` | Date in DD/MM/YYYY (omit for today's date) | *(Today)* |
| `--text-style <STYLE>`| `white_strip`, `black_strip`, `overlay` | `white_strip` |
| `--brightness <VAL>` | Brightness adjustment [-100..100] | `0` |
| `--contrast <VAL>` | Contrast adjustment [-100..100] | `0` |
| `--saturation <VAL>` | Saturation adjustment [-100..100] | `0` |
| `--grayscale` | Convert photo to black & white | `false` |
| `--rotate <DEG>` | Rotate clockwise (0, 90, 180, 270) | `0` |
| `--flip` | Flip horizontally | `false` |
| `--scale <FACTOR>` | Simultaneous zoom scale (0.5..2.0) | `1.0` |
| `--dpi <DPI>` | Raster DPI for images | `300` |
| `--jpeg-quality <Q>` | JPEG quality [10..100] | `95` |
