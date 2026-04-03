import { once } from 'events';
import { https } from 'follow-redirects';
import fs from 'fs';
import { IncomingMessage } from 'http';
import os from 'os';
import path from 'path';
import { extract } from 'tar';
import yauzl from 'yauzl';

export const llamaVersion = 'b8648';


export const hasCUDA = (process.platform === 'linux' && process.env.NVIDIA_VISIBLE_DEVICES && process.env.NVIDIA_DRIVER_CAPABILITIES)
    || (process.platform === 'win32' && process.env.CUDA_PATH);
export const hasIntel = os.cpus().some(cpu => cpu.model.includes('Intel'));

function getBinarySuffix(backend?: string) {
    if (process.platform === 'darwin')
        return '';

    if (process.platform === 'linux' && backend === 'cpu')
        return '';

    if (backend === 'Default')
        backend = undefined;

    if (backend)
        return `-${backend}`;

    // cuda now has 12.4 and 13.1 suffixes (windows only)
    // if (hasCUDA)
    //     return `-cuda`;

    // sycl seems broken on llama.cpp
    // also is unmaintained, and vulkan is now just as fast.
    // if (hasIntel)
    //     return `-sycl`;
    return `-vulkan`;
}

function getArchiveExtension(): string {
    // Windows uses .zip, macOS/Linux use .tar.gz
    return process.platform === 'win32' ? '.zip' : '.tar.gz';
}

export function getBinaryUrl(suffix: string, version?: string): string {
    const effectiveVersion = version || llamaVersion;
    // const orgRepo = suffix === '-sycl' ? 'scryptedapp/llm' : 'ggml-org/llama.cpp';
    const orgRepo = 'ggml-org/llama.cpp';
    const platform = process.platform === 'linux'
        ? 'ubuntu'
        : process.platform === 'darwin'
            ? 'macos'
            : process.platform;
    const extension = getArchiveExtension();
    return `https://github.com/${orgRepo}/releases/download/${effectiveVersion}/llama-${effectiveVersion}-bin-${platform}${suffix}-${process.arch}${extension}`;
}

async function extractZip(buffer: Buffer, extractPath: string): Promise<void> {
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
}

async function extractTarGz(buffer: Buffer, extractPath: string): Promise<void> {
    console.log(`Extracting tar.gz to ${extractPath}`);
    const extractStream = extract({
        cwd: extractPath,
        gzip: true,
    });

    return new Promise((resolve, reject) => {
        extractStream.on('end', resolve);
        extractStream.on('error', reject);
        extractStream.on('finish', resolve);
        extractStream.end(buffer);
    });
}

export async function downloadLLama(backend?: string, version?: string) {
    version ||= llamaVersion;
    const suffix = getBinarySuffix(backend);
    const versionPath = `v${version}${suffix || '-default'}`;
    const llamaDownloadPath = path.join(process.env.SCRYPTED_PLUGIN_VOLUME!, versionPath);


    // Prefix the binary path with the backend if specified
    let llamaBinary = path.join(llamaDownloadPath, 'build', `llama-${version}`, 'llama-server');
    if (process.platform === 'win32') {
        llamaBinary += '.exe';
    }

    console.warn(`Using llama.cpp binary download path ${llamaBinary}`);

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
    const binaryUrl = getBinaryUrl(suffix, version);
    console.warn(`Downloading llama.cpp binary from ${binaryUrl}`);
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

    // Extract based on platform
    const extension = getArchiveExtension();
    if (extension === '.zip') {
        await extractZip(buffer, extractPath);
    } else {
        await extractTarGz(buffer, extractPath);
    }

    await fs.promises.rename(extractPath, buildPath);
    console.warn(`llama.cpp binary extracted to ${buildPath}`);

    if (!fs.existsSync(llamaBinary))
        throw new Error("error occured downloading llama binary.");

    return llamaBinary;
}
