// Vellum MCP connector: lets Claude Desktop and Claude Code read and edit designs in the running Vellum app.
// Started by the Claude app with the Vellum executable in Node mode (ELECTRON_RUN_AS_NODE=1).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import os from 'os';

const dataDir = process.env.VELLUM_DATA || (process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Vellum')
  : process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Application Support', 'Vellum')
  : path.join(os.homedir(), '.config', 'Vellum'));

async function call(tool, args = {}) {
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(path.join(dataDir, 'mcp.json'), 'utf8')); }
  catch (e) { throw new Error('Vellum is not running. Open the Vellum app and try again.'); }
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${cfg.port}/cmd`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-vellum-token': cfg.token }, body: JSON.stringify({ tool, args }) });
  } catch (e) { throw new Error('Vellum is not running. Open the Vellum app and try again.'); }
  const out = await res.json();
  if (!out.ok) throw new Error(out.error || 'Vellum reported an error');
  return out.result;
}
const text = v => ({ content: [{ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) }] });
const wrap = fn => async args => { try { return await fn(args); } catch (e) { return { isError: true, content: [{ type: 'text', text: String(e.message || e) }] }; } };

const GUIDE = `Vellum is a vector interface design editor running on this computer. Work in this order: vellum_list_files or vellum_create_file, vellum_open_file, vellum_get_canvas, then edit with vellum_create_layers / vellum_update_layers, and check your work with vellum_snapshot.
Layer model: type is frame | rect | ellipse | line | polygon | star | text | path | group | comp. x,y are relative to the parent. Colors are 6-digit hex. Text: text, fs, fw (100-900), font, ta (start|center|end), fill, w (gives a wrapping text box), italic. Frames can use auto layout: auto {on:true, dir:"v"|"h", gap, pad or pt/pr/pb/pl, align:"start|center|end|stretch", just:"start|center|end|between", hugW, hugH, wrap, rtl:true for right-to-left}. Children of auto layout frames take sizeH/sizeV = "fixed" | "hug" | "fill" and optional minW/maxW/minH/maxH. Icons: {type:"path", d:"<SVG path data>", viewBox:24, w, h, stroke:"#hex", sw:2}. Images: {type:"image", src:"https://…", w, h}. Text inside a component instance is changed with vellum_update_layers on its id (becomes an override). vellum_update_layers reports ignoredProps — check it. Corner radius rad, opacity op (0-1), shadow {on:true,x,y,b,c,o}, stroke + sw. link: id of a frame to navigate to on click (prototype). component: id or name of a component to place an instance.
Design well: 8px spacing grid, clear type scale, real content, auto layout for screens and lists, components for repeated items. Mobile screens are 390x844 frames placed side by side with 100px gaps. Hebrew text aligns right automatically; set auto.rtl true on rows for Hebrew layouts.`;

const server = new McpServer({ name: 'vellum', version: '0.1.0' }, { instructions: GUIDE });
const anyObj = z.record(z.string(), z.any());

server.registerTool('vellum_list_files', { title: 'List design files', description: 'List all design files in Vellum with ids, names, projects and edit times.' },
  wrap(async () => text(await call('list_files'))));
server.registerTool('vellum_open_file', { title: 'Open a file', description: 'Open a design file in the Vellum window by id. Required before reading or editing layers.', inputSchema: { id: z.string() } },
  wrap(async ({ id }) => text(await call('open_file', { id }))));
server.registerTool('vellum_create_file', { title: 'Create a file', description: 'Create a new empty design file and open it.', inputSchema: { name: z.string() } },
  wrap(async ({ name }) => text(await call('create_file', { name }))));
server.registerTool('vellum_get_canvas', { title: 'Read the canvas', description: 'Return the open file: pages, components, color variables, selected layers and the full layer tree of the current page as JSON.', inputSchema: { page: z.string().optional().describe('Page name to switch to first') } },
  wrap(async ({ page }) => text(await call('get_canvas', { page }))));
server.registerTool('vellum_get_selection', { title: 'Read the selection', description: 'Return the layers the person has selected in Vellum right now.' },
  wrap(async () => text(await call('get_selection'))));
server.registerTool('vellum_update_layers', { title: 'Update layers', description: 'Change properties of existing layers. Each update is {id, props}.', inputSchema: { updates: z.array(z.object({ id: z.string(), props: anyObj })) } },
  wrap(async ({ updates }) => text(await call('update_layers', { updates }))));
server.registerTool('vellum_create_layers', { title: 'Create layers', description: 'Create layers (with nested children) inside parentId, or on the page when parentId is omitted. Returns the new ids.', inputSchema: { parentId: z.string().optional(), layers: z.array(anyObj) } },
  wrap(async ({ parentId, layers }) => text(await call('create_layers', { parentId, layers }))));
server.registerTool('vellum_delete_layers', { title: 'Delete layers', description: 'Delete layers by id.', inputSchema: { ids: z.array(z.string()) } },
  wrap(async ({ ids }) => text(await call('delete_layers', { ids }))));
server.registerTool('vellum_select_layers', { title: 'Select layers', description: 'Select layers and zoom to them so the person sees them.', inputSchema: { ids: z.array(z.string()) } },
  wrap(async ({ ids }) => text(await call('select_layers', { ids }))));
server.registerTool('vellum_make_component', { title: 'Make component', description: 'Turn a frame (by id) into a reusable component.', inputSchema: { id: z.string() } },
  wrap(async ({ id }) => text(await call('make_component', { id }))));
server.registerTool('vellum_add_page', { title: 'Add page', description: 'Add a page to the open file and switch to it.', inputSchema: { name: z.string() } },
  wrap(async ({ name }) => text(await call('add_page', { name }))));
server.registerTool('vellum_snapshot', { title: 'Snapshot', description: 'Return a PNG picture of the given layers (or the whole page) so you can check the design visually.', inputSchema: { ids: z.array(z.string()).optional() } },
  wrap(async ({ ids }) => { const r = await call('snapshot', { ids }); return { content: [{ type: 'image', data: r.png, mimeType: 'image/png' }] }; }));

await server.connect(new StdioServerTransport());
