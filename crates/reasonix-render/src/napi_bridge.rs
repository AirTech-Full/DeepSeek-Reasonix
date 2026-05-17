// N-API bridge — exposes the rust renderer as a native Node addon via napi-rs.
// Replaces the previous spawn-child-process + stdio-pipe IPC architecture
// (which had unfixable race conditions on macOS with Ink's null-stdio
// composition). With napi we share an address space with Node: state pushes
// are sync function calls, events flow back via JS callbacks.
//
// Stage 1: skeleton — version() + a no-op create/shutdown pair to prove the
// toolchain end-to-end (cargo → cdylib → .node → require() → call from TS).
// Real RendererHandle (render-thread + state channel + event callbacks)
// lands in Stage 2.

use napi_derive::napi;

#[napi]
pub fn version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[napi]
pub fn ping() -> String {
    "pong".to_string()
}
