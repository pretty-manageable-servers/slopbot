import sharp from 'sharp';
import { PDFParse } from 'pdf-parse';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import { unzipSync } from 'fflate';

export interface FileContents { text: string; images: { url: string; label: string }[] }
export interface FileReader { accepts(name: string, mime: string): boolean; read(data: Uint8Array): Promise<FileContents> }
const result = (text: string): FileContents => ({ text: text.slice(0, 16000), images: [] });
function checkArchive(data: Uint8Array): void {
  let total = 0, entries = 0;
  unzipSync(data, { filter: item => {
    total += item.originalSize;
    if (++entries > 2000 || total > 24 * 1024 * 1024) throw new Error('Document expands beyond the 24 MiB limit');
    return false;
  } });
}
export class FileReaders {
  private readers: FileReader[] = [];
  register(reader: FileReader): this { this.readers.unshift(reader); return this; }
  async read(name: string, mime: string, data: Uint8Array): Promise<FileContents> {
    const reader = this.readers.find(reader => reader.accepts(name, mime));
    if (!reader) throw new Error('Unsupported file format. Use text, PDF, DOCX, XLSX, PNG, JPEG, WebP or GIF.');
    return reader.read(data);
  }
}
export function defaultFileReaders(): FileReaders {
  return new FileReaders()
    .register({ accepts: (name, mime) => /^text\//.test(mime) || /\.(txt|md|csv|json|yaml|yml|xml|html|log|ts|js|py|rs|css)$/i.test(name), read: async data => result(new TextDecoder('utf-8', { fatal: true }).decode(data)) })
    .register({ accepts: name => /\.docx$/i.test(name), read: async data => { checkArchive(data); return result((await mammoth.extractRawText({ buffer: Buffer.from(data) })).value); } })
    .register({ accepts: name => /\.xlsx$/i.test(name), read: async data => {
      checkArchive(data); const book = new ExcelJS.Workbook(); await book.xlsx.load(Buffer.from(data) as unknown as Parameters<typeof book.xlsx.load>[0]);
      let text = ''; for (const sheet of book.worksheets) { text += `\nSheet: ${sheet.name}\n`; sheet.eachRow(row => { if (text.length < 16000) text += row.values instanceof Array ? row.values.slice(1).map(value => typeof value === 'object' ? JSON.stringify(value) : String(value ?? '')).join('\t') + '\n' : ''; }); }
      return result(text);
    } })
    .register({ accepts: (name, mime) => mime === 'application/pdf' || /\.pdf$/i.test(name), read: async data => {
      const parser = new PDFParse({ data, isEvalSupported: false });
      try { const text = await parser.getText({ first: 20 }); return result(`First up to 20 pages of ${text.total}:\n${text.text}`); } finally { await parser.destroy(); }
    } })
    .register({ accepts: (name, mime) => /^image\/(png|jpeg|webp|gif|avif|tiff)$/.test(mime) || /\.(png|jpe?g|webp|gif|avif|tiff?)$/i.test(name), read: async data => {
      const options = { limitInputPixels: 16_000_000 };
      const metadata = await sharp(data, options).metadata();
      const pages = metadata.pages ?? 1;
      const indices = [...new Set(Array.from({ length: Math.min(5, pages) }, (_, i) => Math.round(i * (pages - 1) / Math.max(1, Math.min(5, pages) - 1))))];
      const images = [];
      for (const page of indices) {
        const frame = await sharp(data, { ...options, page, pages: 1 }).resize(768, 768, { fit: 'inside', withoutEnlargement: true }).flatten({ background: '#ffffff' }).jpeg({ quality: 80 }).toBuffer();
        const time = (metadata.delay ?? []).slice(0, page).reduce((a, b) => a + b, 0);
        images.push({ url: `data:image/jpeg;base64,${frame.toString('base64')}`, label: `Frame ${page + 1}/${pages}, ${time} ms` });
      }
      return { text: pages > 1 ? `Animation: ${pages} frames; ${images.length} sampled in order. Unsampled motion may be missed.` : 'Still image.', images };
    } });
}
