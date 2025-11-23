import { once } from 'events';
import { https } from 'follow-redirects';
import fs from 'fs';
import { IncomingMessage } from 'http';
import os from 'os';
import path from 'path';
import yauzl from 'yauzl';

export const llamaVersion = 'b6910';


export const hasCUDA = (process.platform === 'linux' && process.env.NVIDIA_VISIBLE_DEVICES && process.env.NVIDIA_DRIVER_CAPABILITIES)
    || (process.platform === 'win32' && process.env.CUDA_PATH);
export const hasIntel = os.cpus().some(cpu => cpu.model.includes('Intel'));
// radeon builds are available but apparently vulkan is good as is.
export const hasRadeon = false;

export function getBinaryUrl() {
    if (process.platform === 'darwin') {
        if (process.arch === 'x64')
            return `https://github.com/ggml-org/llama.cpp/releases/download/${llamaVersion}/llama-${llamaVersion}-bin-macos-x64.zip`;
        return `https://github.com/ggml-org/llama.cpp/releases/download/${llamaVersion}/llama-${llamaVersion}-bin-macos-arm64.zip`;
    }

    if (process.platform === 'linux') {
        if (hasCUDA)
            return `https://github.com/scryptedapp/llm/releases/download/${llamaVersion}/llama-${llamaVersion}-bin-ubuntu-cuda-x64.zip`;
        if (hasIntel)
            return `https://github.com/scryptedapp/llm/releases/download/${llamaVersion}/llama-${llamaVersion}-bin-ubuntu-sycl-x64.zip`;
        return `https://github.com/ggml-org/llama.cpp/releases/download/${llamaVersion}/llama-${llamaVersion}-bin-ubuntu-vulkan-x64.zip`;
    }

    // windows
    if (hasCUDA)
        return `https://github.com/ggml-org/llama.cpp/releases/download/${llamaVersion}/llama-${llamaVersion}-bin-win-cuda-12.4-x64.zip`;

    if (hasIntel)
        return `https://github.com/ggml-org/llama.cpp/releases/download/${llamaVersion}/llama-${llamaVersion}-bin-win-sycl-x64.zip`;

    if (hasRadeon)
        return `https://github.com/ggml-org/llama.cpp/releases/download/${llamaVersion}/llama-${llamaVersion}-bin-win-radeon-x64.zip`;

    return `https://github.com/ggml-org/llama.cpp/releases/download/${llamaVersion}/llama-${llamaVersion}-bin-win-vulkan-x64.zip`;
}

export async function downloadLLama() {
    const llamaDownloadPath = path.join(process.env.SCRYPTED_PLUGIN_VOLUME!, `v${llamaVersion}`);
    let llamaBinary = path.join(llamaDownloadPath, 'build', 'bin', 'llama-server');
    if (process.platform === 'win32') {
        llamaBinary += '.exe';
    }

    if (fs.existsSync(llamaBinary)) {
        return llamaBinary;
    }

    const cwd = llamaDownloadPath || process.cwd();
    await fs.promises.mkdir(cwd, { recursive: true });
    const buildPath = path.join(cwd, 'build');
    const extractPath = path.join(cwd, '.extract');
    try {
        await fs.promises.rm(extractPath, { recursive: true, force: true });
    }
    catch (e) {
        const oldExtractPath = path.join(cwd, '.extract-old');
        fs.promises.rm(oldExtractPath, { recursive: true, force: true });
        await fs.promises.rename(extractPath, oldExtractPath);
    }
    await fs.promises.mkdir(extractPath, { recursive: true });
    await fs.promises.rm(buildPath, { recursive: true, force: true });
    const binaryUrl = getBinaryUrl();
    const r = https.get(binaryUrl, {
        family: 4,
    });
    const [response] = await once(r, 'response') as [IncomingMessage];
    if (!response.statusCode || (response.statusCode < 200 && response.statusCode >= 300))
        throw new Error(`Failed to download libav binary: ${response.statusCode}`);

    const buffers: Buffer[] = [];
    response.on('data', (chunk: Buffer) => {
        buffers.push(chunk);
    });
    await once(response, 'end');

    const buffer = Buffer.concat(buffers);

    // Open the zip file
    const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => {
        yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
            if (err) reject(err);
            else resolve(zipfile!);
        });
    });

    // Process zip entries
    await new Promise<void>((resolve, reject) => {
        zip.on('entry', async (entry) => {
            const entryPath = path.join(extractPath, entry.fileName);

            // Skip if entry is unsafe
            if (!entryPath.startsWith(extractPath)) {
                zip.readEntry();
                return;
            }

            // Handle directories
            if (entry.fileName.endsWith('/')) {
                await fs.promises.mkdir(entryPath, { recursive: true });
                zip.readEntry();
                return;
            }

            // Ensure parent directory exists
            const dirName = path.dirname(entryPath);
            await fs.promises.mkdir(dirName, { recursive: true });

            // Open read stream for the entry
            zip.openReadStream(entry, async (err, readStream) => {
                if (err) {
                    reject(err);
                    return;
                }

                if (!readStream) {
                    reject(new Error('Failed to open read stream for zip entry'));
                    return;
                }

                // Check if entry is a symlink
                function modeFromEntry(entry: any) {
                    const attr = entry.externalFileAttributes >> 16 || 33188;

                    return [448, 56, 7]
                        .map(mask => attr & mask)
                        .reduce((a, b) => a + b, attr & 61440);
                }

                const isSymlink = ((modeFromEntry(entry) & 0o170000) === 0o120000);

                if (isSymlink) {
                    const chunks: Buffer[] = [];
                    readStream.on('data', (chunk: Buffer) => chunks.push(chunk));
                    readStream.on('end', async () => {
                        const linkTarget = Buffer.concat(chunks).toString('utf8');
                        try {
                            // Ensure parent directory exists for symlink
                            const symlinkDir = path.dirname(entryPath);
                            await fs.promises.mkdir(symlinkDir, { recursive: true });

                            // Create symlink
                            await fs.promises.symlink(linkTarget, entryPath);
                        } catch (e) {
                            // If symlink fails, write as regular file
                            const writer = fs.createWriteStream(entryPath);
                            readStream.pipe(writer);
                            writer.on('close', () => zip.readEntry());
                            writer.on('error', reject);
                            return;
                        }
                        zip.readEntry();
                    });
                    readStream.on('error', reject);
                } else {
                    // Regular file
                    const writer = fs.createWriteStream(entryPath);
                    readStream.pipe(writer);

                    // Set file permissions if available and handle next entry
                    writer.on('close', async () => {
                        if (entry.externalFileAttributes) {
                            const fileMode = (entry.externalFileAttributes >>> 16) & 0o777;
                            if (fileMode) {
                                try {
                                    await fs.promises.chmod(entryPath, fileMode);
                                } catch (e) {
                                    console.warn(`Failed to set permissions for ${entryPath}:`, e);
                                }
                            }
                        }
                        zip.readEntry();
                    });

                    writer.on('error', reject);
                }
            });
        });

        zip.on('end', () => resolve());
        zip.on('error', reject);

        // Start reading entries
        zip.readEntry();
    });

    await fs.promises.rename(path.join(extractPath, 'build'), buildPath);

    if (!fs.existsSync(llamaBinary))
        throw new Error("error occured downloading llama binary.");

    return llamaBinary;
}
