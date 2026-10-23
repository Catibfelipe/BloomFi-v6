"""Joins dist-artifact/app/index.html + its JS/CSS into one self-contained HTML file (hosted link version)."""
import re, sys, pathlib
root = pathlib.Path(__file__).resolve().parent.parent / 'dist-artifact'
html = (root / 'app' / 'index.html').read_text('utf-8')
def css(m):
    return '<style>' + (root / 'app' / m.group(1)).resolve().read_text('utf-8') + '</style>'
def js(m):
    code = (root / 'app' / m.group(1)).resolve().read_text('utf-8').replace('</script', '<\\/script')
    return '<script type="module">' + code + '</script>'
html = re.sub(r'<link rel="stylesheet"[^>]*href="([^"]+)"[^>]*>', css, html)
html = re.sub(r'<script type="module"[^>]*src="([^"]+)"[^>]*></script>', js, html)
html = re.sub(r'<link rel="(?:icon|apple-touch-icon)"[^>]*>\s*', '', html)
html = html.replace('�', '\\uFFFD')
out = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else root / 'bloomfi.html')
out.write_text(html, 'utf-8')
print(out, len(html.encode()) // 1024, 'KB')
