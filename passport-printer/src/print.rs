use std::path::Path;
use std::process::Command;

/// Attempts direct printing using the CUPS `lpr` command, or falls back to system viewer.
pub fn print_document(file_path: &Path, media_name: &str) -> Result<String, String> {
    // Check if `lpr` binary is available on the system
    let has_lpr = Command::new("which")
        .arg("lpr")
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false);

    if has_lpr {
        // Run CUPS lpr with 100% scale and media specification
        let mut cmd = Command::new("lpr");
        cmd.arg("-o").arg("fit-to-page=false");
        cmd.arg("-o").arg("scaling=100");

        // Map media name if recognized
        let cups_media = match media_name.to_lowercase().as_str() {
            "4x6" => "4x6",
            "5x7" => "5x7",
            "a4" => "A4",
            "a5" => "A5",
            "letter" => "Letter",
            _ => "",
        };

        if !cups_media.is_empty() {
            cmd.arg("-o").arg(format!("media={}", cups_media));
        }

        cmd.arg(file_path);

        match cmd.output() {
            Ok(output) if output.status.success() => {
                Ok("Document sent successfully to your system default printer (100% scale).".to_string())
            }
            Ok(output) => {
                let stderr = String::from_utf8_lossy(&output.stderr);
                // Fallback to opening default document viewer
                let _ = open::that(file_path);
                Ok(format!(
                    "lpr command returned: {}. Opened document in your default PDF viewer for printing.",
                    stderr.trim()
                ))
            }
            Err(e) => {
                let _ = open::that(file_path);
                Ok(format!(
                    "lpr error: {}. Opened document in default viewer for printing.",
                    e
                ))
            }
        }
    } else {
        // Fallback: Open file in system default viewer / print dialog
        open::that(file_path).map_err(|e| format!("Failed to open document: {}", e))?;
        Ok("Opened document in your system viewer. Select 100% scale (no fit-to-page) to print.".to_string())
    }
}
