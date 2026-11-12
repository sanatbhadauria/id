# Card & File Tools (ID card to A4, Convert, Compress)

A fast, private, browser-based suite of tools for identity cards and documents. Everything processes 100% locally on your device with zero server uploads.

## Tools Included

- **Home Page (`#home`)**: Central dashboard providing direct access, descriptions, and feature overviews for all available tools.
- **ID Card to A4 (`#a4-id` or `#a4`)**: Place front and back ID photos onto a single A4 page with true physical scale (85.6 × 54 mm), perspective warp, auto card edge detection, image filters, cutting guides, and print / PDF / JPEG / PNG export.
- **Convert Files (`#convert`)**: Batch convert multi-page PDFs to high-DPI JPG images, or compile multiple JPG, PNG, and WebP images into a single PDF.
- **Compress Files (`#compress`)**: Batch multi-pass compression for PDFs and images to meet strict target file sizes in KB (e.g., 100 KB or 200 KB) for online application portals, with one-click "Download all".

## Features

- **100% Client-Side Privacy**: Files never leave your browser sandbox.
- **Instant Processing**: Powered by client-side Canvas and WebAssembly.
- **Navigation & Routing**: Clean URL hash navigation (`#home`, `#a4-id`, `#convert`, `#compress`) with persistent breadcrumbs and dynamic page titles.
- **Responsive & Dark Mode**: Adapts across mobile, tablet, and desktop with automatic light/dark theme support.

## How to Use

1. Open `index.html` directly in a browser, or run a local server:
   ```bash
   python -m http.server 8000
   ```
2. Navigate to `http://localhost:8000`.
3. Choose the tool you need from the home page cards or the top navigation bar.

## Notes & Printing Tips

- **Print Scale**: When printing from the ID card tool, ensure your browser print dialog is set to **100% scale** (do not select "Fit to page" or "Shrink to printable area") to preserve physical card dimensions.
- **Offline Capable**: Once loaded in your browser, the tools work entirely offline.
