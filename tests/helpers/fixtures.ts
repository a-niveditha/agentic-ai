import JSZip from 'jszip';

/** Each fixture carries a unique fact so tests can check retrieval + citation against the right source. */
export const FACTS = {
  txt: { text: 'The Zorblax Protocol operates on port 4242 and was invented by Dr. Ilsa Quill.', question: 'Which port does the Zorblax Protocol use?', answer: '4242' },
  md: { text: '# Marmalade Handbook\n\nThe Marmalade Engine requires exactly 17 oranges per batch and ferments for 9 days.', question: 'How many oranges does the Marmalade Engine need per batch?', answer: '17' },
  pdf: { text: 'The Kestrel Accord was signed in the city of Vantaroon in the year 1873.', question: 'In which city was the Kestrel Accord signed?', answer: 'Vantaroon' },
  docx: { text: 'The Plumbline Initiative allocates a budget of 5.5 million quatloos to lighthouse maintenance.', question: 'What budget does the Plumbline Initiative allocate to lighthouse maintenance?', answer: '5.5 million' },
  html: { text: 'The Orrery Society meets every third Thursday at the Brindlewick Observatory.', question: 'Where does the Orrery Society meet?', answer: 'Brindlewick' },
  csv: { text: 'name,role\nAlderfern Quibble,chief cartographer\nMarlo Thistledown,head of fermentation', question: 'What is the role of Alderfern Quibble?', answer: 'cartographer' },
  json: { text: JSON.stringify({ project: 'Halcyon Drift', launchCodename: 'Tangerine Owl', owner: 'Priya Venkataraman' }), question: 'What is the launch codename of project Halcyon Drift?', answer: 'Tangerine Owl' },
} as const;

export type FixtureKind = keyof typeof FACTS;

/** Minimal but valid single-page PDF containing `text` (text extractors can read it). */
export function buildPdf(text: string): Buffer {
  return buildPdfPages([text]);
}

/** Minimal valid PDF with one page per entry; an empty string produces a page without text. */
export function buildPdfPages(pages: string[]): Buffer {
  const fontObj = 3 + pages.length * 2;
  const objects: string[] = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${3 + i * 2} 0 R`).join(' ')}] /Count ${pages.length} >>`,
  ];
  pages.forEach((text, i) => {
    const escaped = text.replace(/[\\()]/g, (c) => `\\${c}`);
    const stream = text ? `BT /F1 12 Tf 50 750 Td (${escaped}) Tj ET` : '';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 ${fontObj} 0 R >> >> >>`);
    objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  });
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  let body = '%PDF-1.4\n';
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(body.length);
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, '0')} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body, 'latin1');
}

/** Minimal valid .docx (zip of the three required parts). */
export async function buildDocx(text: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  );
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  );
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;');
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${esc}</w:t></w:r></w:p></w:body></w:document>`,
  );
  return Buffer.from(await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' }));
}

export function buildHtml(text: string): Buffer {
  return Buffer.from(
    `<!doctype html><html><head><title>Orrery Society Notes</title></head><body><nav>Home | About</nav><article><h1>Orrery Society</h1><p>${text}</p><p>Members are welcome to bring telescopes, star charts and refreshments for the evening session, which usually runs past midnight.</p></article><script>alert('x')</script></body></html>`,
  );
}

export interface FixtureFile {
  filename: string;
  mimeType: string;
  buffer: Buffer;
  kind: FixtureKind;
}

export async function buildFixtureFiles(): Promise<FixtureFile[]> {
  return [
    { kind: 'txt', filename: 'zorblax.txt', mimeType: 'text/plain', buffer: Buffer.from(FACTS.txt.text) },
    { kind: 'md', filename: 'marmalade.md', mimeType: 'text/markdown', buffer: Buffer.from(FACTS.md.text) },
    { kind: 'pdf', filename: 'kestrel.pdf', mimeType: 'application/pdf', buffer: buildPdf(FACTS.pdf.text) },
    { kind: 'docx', filename: 'plumbline.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: await buildDocx(FACTS.docx.text) },
    { kind: 'html', filename: 'orrery.html', mimeType: 'text/html', buffer: buildHtml(FACTS.html.text) },
    { kind: 'csv', filename: 'staff.csv', mimeType: 'text/csv', buffer: Buffer.from(FACTS.csv.text) },
    { kind: 'json', filename: 'halcyon.json', mimeType: 'application/json', buffer: Buffer.from(FACTS.json.text) },
  ];
}
