import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';

async function privateText(path: string): Promise<string> {
  let current = parse(path).root;
  const components = path.slice(current.length).split(sep).filter(Boolean);
  for (const [index, component] of components.entries()) {
    current = join(current, component);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (index < components.length - 1 && !info.isDirectory())) throw new Error('Unsafe native prompt path');
  }
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 131072 || (info.mode & 0o077) !== 0 || typeof process.getuid === 'function' && info.uid !== process.getuid()) throw new Error('Unsafe native prompt file');
    const value = await file.readFile('utf8');
    if (Buffer.byteLength(value) > 131072) throw new Error('Oversized native prompt file');
    return value;
  } finally { await file.close(); }
}

/** Check the native SessionStart delivery used by the prepared Agy launch; never execute a hook to inspect it. */
export async function resolveNativeAgyPrompt(home: string, role: 'conversation' | 'coordinator', original: string): Promise<string | undefined> {
  try {
    if (!isAbsolute(home) || resolve(home) !== home || home === '/') return undefined;
    const config = join(home, '.gemini', 'config');
    const script = join(config, 'bflow-session-start.mjs');
    const prompt = join(dirname(dirname(home)), `${role}.system-prompt.txt`);
    const hooks: unknown = JSON.parse(await privateText(join(config, 'hooks.json')));
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return undefined;
    const group = (hooks as Record<string, unknown>).bflow;
    if (!group || typeof group !== 'object' || Array.isArray(group)) return undefined;
    const native = group as Record<string, unknown>;
    if (native.enabled === false || !Array.isArray(native.SessionStart)) return undefined;
    const quotedScript = "'" + script.replaceAll("'", "'\\''") + "'";
    if (!native.SessionStart.some(value => value && typeof value === 'object' && value.type === 'command' &&
        typeof value.command === 'string' && value.command.endsWith(' ' + quotedScript))) return undefined;
    const source = await privateText(script);
    if (!source.includes(`const systemMessage = readFileSync(${JSON.stringify(prompt)}, "utf8");`) ||
        !source.includes('injectSteps: [{ systemMessage: { systemMessage } }]')) return undefined;
    return (await privateText(prompt)).includes(original) ? prompt : undefined;
  } catch { return undefined; }
}
