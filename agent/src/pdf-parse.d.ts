declare module 'pdf-parse/lib/pdf-parse.js' {
  interface PdfPageData {
    getTextContent(options?: Record<string, unknown>): Promise<{ items: { str: string; transform: number[] }[] }>;
  }
  const pdfParse: (
    data: Buffer,
    options?: { max?: number; pagerender?: (page: PdfPageData) => Promise<string> | string },
  ) => Promise<{ text: string; numpages: number; info?: Record<string, any> }>;
  export default pdfParse;
}
