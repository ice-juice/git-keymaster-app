use crate::error::Result;
use crate::qrscan;

#[tauri::command]
pub fn render_qr_png(text: String) -> Result<String> {
    qrscan::render_qr_png_b64(&text)
}

#[tauri::command]
pub fn decode_qr_from_image(bytes: Vec<u8>) -> Result<Vec<String>> {
    qrscan::decode_image_bytes(&bytes)
}
