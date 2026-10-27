import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
/** Bounded read; reject special files and symlinks before opening, including parent redirection. */
export async function readPreviewFile(path: string, maxBytes = 2000000): Promise<string> {
    const absolute = resolve(path);
    const info = await lstat(absolute);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes || await realpath(absolute) !== absolute)
        throw new Error('Preview input must be a bounded regular local file');
    const handle = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size > maxBytes || stat.ino !== info.ino || stat.dev !== info.dev)
            throw new Error('Preview input changed while opening');
        const bytes = Buffer.alloc(maxBytes + 1);
        let length = 0;
        while (length < bytes.length) {
            const result = await handle.read(bytes, length, bytes.length - length, null);
            if (result.bytesRead === 0)
                break;
            length += result.bytesRead;
        }
        if (length > maxBytes)
            throw new Error('Preview input exceeds limit');
        return bytes.subarray(0, length).toString('utf8');
    }
    finally {
        await handle.close();
    }
}
