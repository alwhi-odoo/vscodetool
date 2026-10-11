// HTML for the speedscope webview: the patched build in media/speedscope
// (scripts/build-speedscope.sh), with its assets served through the webview.
import * as fs from 'fs';
import * as vscode from 'vscode';

/** Webview options the speedscope page needs. */
export function speedscopeLocalResourceRoots(extensionUri: vscode.Uri): vscode.Uri[] {
  return [vscode.Uri.joinPath(extensionUri, 'media', 'speedscope')];
}

/**
 * Returns media/speedscope/index.html with:
 * - every relative `src` / `href` rewritten through `webview.asWebviewUri`;
 * - a `<base href>` on the media/speedscope folder, so URLs the bundle builds
 *   at runtime relative to the page (the jfrview .wasm, the bundled example
 *   .txt) also resolve to webview resources. The CSS references its font
 *   relative to itself, which already works once the CSS URL is rewritten;
 * - a Content-Security-Policy allowing only local resources, plus
 *   'wasm-unsafe-eval' (demangler / JFR importer instantiate WebAssembly) and
 *   'unsafe-inline' styles (aphrodite injects <style> tags).
 *
 * The webview must be created with `enableScripts: true` and
 * `localResourceRoots` including media/speedscope.
 */
export function speedscopeHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const root = vscode.Uri.joinPath(extensionUri, 'media', 'speedscope');
  const indexPath = vscode.Uri.joinPath(root, 'index.html').fsPath;
  let html: string;
  try {
    html = fs.readFileSync(indexPath, 'utf8');
  } catch {
    return missingBuildHtml(webview);
  }

  const asset = (rel: string) => webview.asWebviewUri(vscode.Uri.joinPath(root, rel)).toString();
  const isRelative = (url: string) => !/^([a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(url);

  html = html.replace(
    /(<(?:script|link|img)\b[^>]*?\s(?:src|href)=)(["'])([^"']*)\2/gi,
    (all, prefix: string, quote: string, url: string) =>
      isRelative(url) ? `${prefix}${quote}${asset(url)}${quote}` : all,
  );

  const src = webview.cspSource;
  const csp = [
    `default-src 'none'`,
    `script-src ${src} 'wasm-unsafe-eval'`,
    `style-src ${src} 'unsafe-inline'`,
    `font-src ${src}`,
    `img-src ${src} data:`,
    `connect-src ${src}`,
  ].join('; ');

  const base = webview.asWebviewUri(root).toString().replace(/\/?$/, '/');
  const head =
    `<meta http-equiv="Content-Security-Policy" content="${csp}">\n` +
    `    <base href="${base}">`;
  return html.replace(/<head>/i, `<head>\n    ${head}`);
}

function missingBuildHtml(webview: vscode.Webview): string {
  return `<!DOCTYPE html>
<html><head><meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'">
</head><body style="font-family: var(--vscode-font-family); padding: 1em">
<p>speedscope is not built. Run <code>scripts/build-speedscope.sh</code> in the extension folder.</p>
</body></html>`;
}
