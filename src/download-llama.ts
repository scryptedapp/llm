import fs from 'fs';
import path from 'path';

export const llamaVersion = 'b5657';

export function downloadLLama() {
    const llamaDownloadPath = path.join(process.env.SCRYPTED_PLUGIN_VOLUME!, `v${llamaVersion}`);
    let llamaBinary = path.join(llamaDownloadPath, 'build', 'bin', 'llama-server');
    if (process.platform === 'win32') {
        llamaBinary += '.exe';
    }

    if (fs.existsSync(llamaBinary)) {
        return;
    }

    
}