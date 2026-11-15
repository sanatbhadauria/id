use crate::models::{Alignment, ComposeOptions, Orientation};
use serde::{Deserialize, Serialize};

/// Position of an individual photo on the paper sheet in millimeters.
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct PhotoItem {
    pub id: usize,
    pub x_mm: f64,
    pub y_mm: f64,
    pub w_mm: f64,
    pub h_mm: f64,
}

/// Calculated sheet layout metadata.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SheetLayout {
    pub paper_w_mm: f64,
    pub paper_h_mm: f64,
    pub cols: usize,
    pub rows: usize,
    pub max_capacity: usize,
    pub items: Vec<PhotoItem>,
    pub is_landscape: bool,
}

impl SheetLayout {
    /// Width in 72-DPI PostScript / PDF points (1 pt = 1/72 inch = 25.4/72 mm).
    pub fn paper_w_pts(&self) -> f64 {
        self.paper_w_mm * 72.0 / 25.4
    }

    /// Height in 72-DPI PostScript / PDF points.
    pub fn paper_h_pts(&self) -> f64 {
        self.paper_h_mm * 72.0 / 25.4
    }

    /// Width in pixels at the specified DPI.
    pub fn paper_w_px(&self, dpi: u32) -> u32 {
        ((self.paper_w_mm * dpi as f64 / 25.4).round()) as u32
    }

    /// Height in pixels at the specified DPI.
    pub fn paper_h_px(&self, dpi: u32) -> u32 {
        ((self.paper_h_mm * dpi as f64 / 25.4).round()) as u32
    }
}

/// Calculates the optimal grid arrangement for passport photos on the chosen paper.
pub fn calculate_sheet_layout(opts: &ComposeOptions) -> SheetLayout {
    let (base_w, base_h) = opts.paper.dimensions_mm();
    let (photo_w, photo_h) = opts.preset.dimensions_mm();
    let gap = opts.gap_mm.max(0.0);
    let margin = opts.margin_mm.max(0.0);

    // Helper to calculate capacity for a specific (w, h)
    let calc_fit = |pw: f64, ph: f64| -> (usize, usize, usize) {
        let avail_w = (pw - 2.0 * margin + gap).max(0.0);
        let avail_h = (ph - 2.0 * margin + gap).max(0.0);

        let cols = (avail_w / (photo_w + gap)).floor().max(0.0) as usize;
        let rows = (avail_h / (photo_h + gap)).floor().max(0.0) as usize;
        let cap = cols * rows;
        (cols, rows, cap)
    };

    // Determine final paper orientation
    let (final_w, final_h, is_landscape) = match opts.orientation {
        Orientation::Portrait => {
            let w = base_w.min(base_h);
            let h = base_w.max(base_h);
            (w, h, false)
        }
        Orientation::Landscape => {
            let w = base_w.max(base_h);
            let h = base_w.min(base_h);
            (w, h, true)
        }
        Orientation::Auto => {
            let port_w = base_w.min(base_h);
            let port_h = base_w.max(base_h);
            let land_w = base_w.max(base_h);
            let land_h = base_w.min(base_h);

            let (_, _, cap_port) = calc_fit(port_w, port_h);
            let (_, _, cap_land) = calc_fit(land_w, land_h);

            if let Some(target_count) = opts.count {
                // If user asked for an exact count, pick whichever fits it with less wasted space
                if cap_port >= target_count && cap_land < target_count {
                    (port_w, port_h, false)
                } else if cap_land >= target_count && cap_port < target_count {
                    (land_w, land_h, true)
                } else if cap_land > cap_port {
                    (land_w, land_h, true)
                } else {
                    (port_w, port_h, false)
                }
            } else if cap_land > cap_port {
                (land_w, land_h, true)
            } else {
                (port_w, port_h, false)
            }
        }
    };

    let (cols, rows, max_capacity) = calc_fit(final_w, final_h);
    let total_to_place = match opts.count {
        Some(c) => c.min(max_capacity),
        None => max_capacity,
    };

    if cols == 0 || rows == 0 || total_to_place == 0 {
        return SheetLayout {
            paper_w_mm: final_w,
            paper_h_mm: final_h,
            cols,
            rows,
            max_capacity,
            items: Vec::new(),
            is_landscape,
        };
    }

    // Determine active grid dimensions
    let active_rows = ((total_to_place as f64) / (cols as f64)).ceil() as usize;
    let grid_w = (cols as f64) * photo_w + ((cols - 1) as f64) * gap;
    let grid_h = (active_rows as f64) * photo_h + ((active_rows - 1) as f64) * gap;

    let (start_x, start_y) = match opts.alignment {
        Alignment::Center => {
            let sx = ((final_w - grid_w) / 2.0).max(margin);
            let sy = ((final_h - grid_h) / 2.0).max(margin);
            (sx, sy)
        }
        Alignment::TopLeft => (margin, margin),
    };

    let mut items = Vec::with_capacity(total_to_place);
    let mut placed = 0;

    for r in 0..active_rows {
        let photos_in_this_row = (total_to_place - placed).min(cols);
        let row_start_x = if opts.alignment == Alignment::Center && photos_in_this_row < cols {
            // Center incomplete last row symmetrically
            let row_w = (photos_in_this_row as f64) * photo_w + ((photos_in_this_row - 1) as f64) * gap;
            ((final_w - row_w) / 2.0).max(margin)
        } else {
            start_x
        };

        for c in 0..photos_in_this_row {
            let x = row_start_x + (c as f64) * (photo_w + gap);
            let y = start_y + (r as f64) * (photo_h + gap);
            items.push(PhotoItem {
                id: placed,
                x_mm: x,
                y_mm: y,
                w_mm: photo_w,
                h_mm: photo_h,
            });
            placed += 1;
            if placed >= total_to_place {
                break;
            }
        }
        if placed >= total_to_place {
            break;
        }
    }

    SheetLayout {
        paper_w_mm: final_w,
        paper_h_mm: final_h,
        cols,
        rows,
        max_capacity,
        items,
        is_landscape,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{PaperSize, PhotoPreset};

    #[test]
    fn test_4x6_passport_fit() {
        let opts = ComposeOptions {
            paper: PaperSize::FourBySix,
            orientation: Orientation::Auto,
            preset: PhotoPreset::Standard35x45,
            gap_mm: 2.5,
            margin_mm: 5.0,
            ..Default::default()
        };
        let layout = calculate_sheet_layout(&opts);
        // On 4x6" (101.6 x 152.4 mm), 35x45 mm with 2.5mm gap fits 8 photos (2 cols x 4 rows or vice versa)
        assert!(layout.max_capacity >= 6, "Expected at least 6 photos on 4x6");
        assert_eq!(layout.items.len(), layout.max_capacity);
    }
}
