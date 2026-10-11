import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface OprofConfig {
  url: string;
  database: string;
  python: string;
  odooSource: string;
  addonsPath: string[];
  extraArgs: string[];
  collectors: string[];
  cronMaxBatches: number;
  recordCalls: boolean;
  showProfilerFrames: boolean;
  hideMissingCode: boolean;
  retentionDays: number;
}

export function getConfig(): OprofConfig {
  const c = vscode.workspace.getConfiguration('oprof');
  return {
    url: (c.get<string>('odoo.url') || 'http://127.0.0.1:8069').replace(/\/+$/, ''),
    database: c.get<string>('odoo.database') || '',
    python: c.get<string>('python') || '',
    odooSource: c.get<string>('odooSource') || '',
    addonsPath: c.get<string[]>('addonsPath') || [],
    extraArgs: c.get<string[]>('server.extraArgs') || [],
    collectors: c.get<string[]>('collectors') || ['sql', 'traces_async', 'oprof'],
    cronMaxBatches: c.get<number>('cron.maxBatches') || 0,
    recordCalls: c.get<boolean>('recordCalls') ?? true,
    showProfilerFrames: c.get<boolean>('showProfilerFrames') ?? false,
    hideMissingCode: c.get<boolean>('hideMissingCode') ?? false,
    retentionDays: c.get<number>('retentionDays') ?? 14,
  };
}

/** Folder holding the `oprof` Odoo addon: bundled in the .vsix, or the repository's odoo_addon/. */
export function addonParentDir(extensionUri: vscode.Uri): string {
  const bundled = path.join(extensionUri.fsPath, 'odoo_addon');
  if (fs.existsSync(path.join(bundled, 'oprof', '__manifest__.py'))) {
    return bundled;
  }
  return path.resolve(extensionUri.fsPath, '..', 'odoo_addon');
}

