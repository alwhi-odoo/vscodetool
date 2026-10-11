/**
 * Modules installed in a database whose code isn't on the addons path oprof starts Odoo with.
 *
 * Odoo still applies such a module's views (they are in the database) but not its Python
 * code, so a view can name a field that doesn't exist: the web client then fails, e.g.
 * saas_trial's `is_module_official` in the Apps kanban. oprof only says so: adding such
 * folders itself loaded code of another branch (internal on master into a 20.0 database)
 * and broke the whole web client.
 */
import * as fs from 'fs';
import * as path from 'path';

const isModule = (dir: string) => fs.existsSync(path.join(dir, '__manifest__.py'));

/** The installed modules that no folder of the addons path holds. */
export function missingModules(installed: string[], addonsDirs: string[]): string[] {
  return installed.filter((name) => !addonsDirs.some((dir) => isModule(path.join(dir, name))));
}
