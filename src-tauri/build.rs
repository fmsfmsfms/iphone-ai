// tauri-build copies `bundle.externalBin` and `bundle.resources` next to the
// dev binary and fails if any of them is missing. The resource folders are
// produced by `pnpm package:mac`; create empty ones so a fresh checkout can
// still `cargo check`, and explain how to stage the Node.js runtime.

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

    tauri_build::build()
}
