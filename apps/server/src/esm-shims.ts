// Injected into the server bundle (esbuild --inject). The bundle is an ES module, where CommonJS's __dirname
// and __filename do not exist; ssh2 (SFTP destinations) reads __dirname when it loads.
export const __dirname = import.meta.dirname
export const __filename = import.meta.filename
