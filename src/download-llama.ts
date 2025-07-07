import fs from 'fs';
import path from 'path';
import {https} from 'follow-redirects';
import os from 'os';
import { once } from 'events';
import { IncomingMessage } from 'http';
import AdmZip from 'adm-zip';

export const llamaVersion = 'b5835';


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

    const zip = new AdmZip(buffer);
    zip.extractAllTo(extractPath, true, true);
    await fs.promises.rename(path.join(extractPath, 'build'), buildPath);

    if (!fs.existsSync(llamaBinary))
        throw new Error("error occured downloading llama binary.");

    return llamaBinary;
}