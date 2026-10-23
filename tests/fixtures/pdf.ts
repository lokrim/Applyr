// Fictional, zero-content one-page PDF. Not a candidate resume.
export function syntheticPdf(label = 'fixture'): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder();
  let text = `%PDF-1.4\n% ${label}\n`;
  const offsets = [0];
  for (const [index, body] of [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>',
    '<< /Length 0 >>\nstream\n\nendstream',
  ].entries()) {
    offsets.push(encoder.encode(text).length);
    text += `${index + 1} 0 obj\n${body}\nendobj\n`;
  }
  const xref = encoder.encode(text).length;
  text += `xref\n0 5\n0000000000 65535 f \n${offsets.slice(1).map((n) => `${n.toString().padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 5 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return encoder.encode(text);
}
