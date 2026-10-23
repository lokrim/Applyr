export function downloadMarkdown(text: string, filename = 'applyr-profile.md') {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url; link.download = filename;
  document.body.append(link); link.click(); link.remove();
  // Keep the object URL alive until the browser has consumed the click.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
