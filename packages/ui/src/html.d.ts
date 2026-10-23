// For type checking this package on its own (browser types only): the runtime's Bun types describe the imported
// HTML entry as an HTML bundle.
declare module '*.html' {
  const bundle: unknown;
  export default bundle;
}
