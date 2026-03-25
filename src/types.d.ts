declare module 'screenshot-desktop' {
  function screenshot(options?: { format?: string; screen?: string | number }): Promise<Buffer>;
  export = screenshot;
}
