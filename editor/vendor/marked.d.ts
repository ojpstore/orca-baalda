// Only what editor/main.ts uses from the vendored marked 15 ESM build.
export const marked: {
  parse(src: string, options: { async: false }): string
  use(extension: { renderer: Record<string, (this: any, token: any) => string | false> }): void
}
