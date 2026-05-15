fn main() {
    connectrpc_build::Config::new()
        .files(&["proto/lazycat/webshell/v1/capability.proto"])
        .includes(&["proto/"])
        .include_file("_connectrpc.rs")
        .compile()
        .expect("connectrpc code generation failed");
}
