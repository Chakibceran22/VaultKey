//! Prints an ONNX model's inputs and outputs, as ONNX Runtime sees them.
//!
//!   cargo run -p vaultkey-search --example inspect -- path/to/model.onnx

use ort::session::Session;

fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let env = vaultkey_search::model::environment()?;
    for path in std::env::args().skip(1) {
        let session = Session::builder(&env).map_err(|e| e.to_string())?.commit_from_file(&path)?;
        println!("{path}");
        for input in session.inputs() {
            println!("  in   {:<28} {:?}", input.name(), input.dtype());
        }
        for output in session.outputs() {
            println!("  out  {:<28} {:?}", output.name(), output.dtype());
        }
    }
    Ok(())
}
