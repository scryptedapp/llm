import path from 'path';

export const llamaVersion = 'b5657';

export function downloadLLama() {
    const llamaPath = path.join(process.env.SCRYPTED_PLUGIN_VOLUME!, `v${llamaVersion}`);
}