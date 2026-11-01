# ID card to A4

A small browser-based tool for turning front and back ID card photos into a single A4 page ready to print.

Add the front and back images, crop each to the card edges, fine-tune the layout, and export a print-ready PDF, JPEG, or PNG without leaving the browser.

## Features

- Upload front and back card images
- Crop and align each side to the exact card area
- Adjust brightness, contrast, color, sharpness, and flip/rotate options
- Choose A4 layout: stacked or side-by-side
- Keep the card shape with rounded corners and cut guide lines
- Print directly at 100% scale or download the final result
- Extra tools for converting and compressing files

## How to use

1. Open `index.html` in a browser, or serve the project locally.
2. Add the front and back card images.
3. Drag the crop box to position and resize each photo.
4. Adjust filters and layout settings in the right panel.
5. Click `Print` or download as PDF, JPEG, or PNG.

## Run locally

You can open the page directly in a browser, or run a simple local server:

```bash
python -m http.server 8000
```

Then visit:

```text
http://localhost:8000
```

## Printing tips

- Use the browser print dialog with the page scaled to 100%.
- Do not use “fit to page” or “shrink to printable area”.
- The layout is designed to keep the card size accurate when printed on A4.

## Notes

- Everything runs in the browser.
- No files are uploaded to a remote server.
- This project is a single-page static web app built with HTML, CSS, and JavaScript.
