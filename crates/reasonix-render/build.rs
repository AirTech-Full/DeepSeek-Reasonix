// napi-rs uses build.rs to inject the N-API initialization symbol that
// Node's loader looks for when require()'ing the .node file.
fn main() {
    napi_build::setup();
}
