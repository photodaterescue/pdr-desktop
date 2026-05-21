// Lightweight type declaration for the pure-JS heic-convert package
// (no @types/heic-convert published). We only call the default
// export with a single shape — buffer in, JPEG/PNG/etc. buffer out
// — so a one-line module declaration is plenty.
declare module 'heic-convert' {
  interface HeicConvertOptions {
    buffer: Uint8Array | ArrayBuffer | Buffer;
    format: 'JPEG' | 'PNG';
    quality?: number;
  }
  const heicConvert: (opts: HeicConvertOptions) => Promise<ArrayBuffer>;
  export default heicConvert;
}
