fn main() {
  let lang_file = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("gam-lang.txt");
  println!("cargo:rerun-if-changed=gam-lang.txt");
  let lang = std::fs::read_to_string(&lang_file)
    .ok()
    .map(|s| s.trim().to_ascii_lowercase())
    .filter(|s| !s.is_empty())
    .unwrap_or_else(|| "zh".into());
  let lang = if lang == "en" || lang.starts_with("en-") {
    "en"
  } else {
    "zh"
  };
  println!("cargo:rustc-env=GAM_APP_LANG={lang}");
  tauri_build::build()
}
