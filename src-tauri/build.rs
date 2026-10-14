// tauri-build copies `bundle.externalBin` and `bundle.resources` next to the
// dev binary and fails if any of them is missing. The resource folders are
// produced by `pnpm package:mac`; create empty ones so a fresh checkout can
// still `cargo check`, and explain how to stage the Node.js runtime and build
// the ScreenCaptureKit live-view helper.

use std::path::Path;

fn main() {
    for dir in ["resources/server", "resources/web", "resources/claude-code"] {
        if let Err(err) = std::fs::create_dir_all(dir) {
            panic!("could not create src-tauri/{dir}: {err}");
        }
    }

    let target = std::env::var("TARGET").unwrap_or_default();
    let node = format!("binaries/node-{target}");
    if !Path::new(&node).is_file() {
        panic!(
            "src-tauri/{node} is missing. Run `pnpm package:mac --stage-only` from the repo root \
             (it copies the official Node.js 22 binary there) before building the shell."
        );
    }
    let capture = format!("binaries/iphone-ai-capture-{target}");
    if !Path::new(&capture).is_file() {
        panic!(
            "src-tauri/{capture} is missing. Run `node scripts/build-capture.mjs` (or \
             `pnpm package:mac --stage-only`) from the repo root; it compiles the ScreenCaptureKit \
             live-view helper from src-tauri/capture/main.swift (needs the Xcode Command Line Tools)."
        );
    }

    tauri_build::build()
}
