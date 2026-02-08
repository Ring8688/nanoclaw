/**
 * File Handler - Downloads files from Telegram servers.
 * No bot instance - receives file info from main process.
 */
import fs from 'fs';
import https from 'https';
import path from 'path';

import { DATA_DIR, TELEGRAM_BOT_TOKEN, TELEGRAM_LOCAL_API_URL } from './config.js';
import { logger } from './logger.js';
import { TelegramFileInfo, DownloadResult } from './types.js';

export function downloadFile(
  fileInfo: TelegramFileInfo,
  chatId: string,
  type: string,
  retries = 2,
): Promise<DownloadResult> {
  const mediaDir = path.join(DATA_DIR, 'media', chatId);
  fs.mkdirSync(mediaDir, { recursive: true });

  const fileName = `${Date.now()}_${type}_${fileInfo.file_unique_id}`;
  const ext = path.extname(fileInfo.file_path || '') || `.${type}`;
  const localPath = path.join(mediaDir, fileName + ext);

  // Local Bot API mode: getFile returns absolute paths on the server filesystem.
  if (TELEGRAM_LOCAL_API_URL && fileInfo.file_path?.startsWith('/')) {
    const hostPath = fileInfo.file_path.replace(
      '/var/lib/telegram-bot-api',
      path.join(DATA_DIR, 'telegram-bot-api'),
    );
    fs.copyFileSync(hostPath, localPath);
    logger.debug({ hostPath, localPath }, 'File copied from local Bot API');
    return Promise.resolve({ localPath, fileName: fileName + ext });
  }

  // Official API mode: download via HTTPS
  const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${fileInfo.file_path}`;

  return new Promise<DownloadResult>((resolve, reject) => {
    const request = https.get(fileUrl, { timeout: 30000 }, (response) => {
      if (response.statusCode !== 200) {
        reject(
          new Error(`Failed to download file: HTTP ${response.statusCode}`),
        );
        return;
      }
      const writeStream = fs.createWriteStream(localPath);
      response.pipe(writeStream);
      writeStream.on('finish', () =>
        resolve({ localPath, fileName: fileName + ext }),
      );
      writeStream.on('error', reject);
    });

    request.on('error', (err) => {
      if (retries > 0) {
        logger.warn({ fileId: fileInfo.file_id, type, retries }, 'Download failed, retrying...');
        setTimeout(() => {
          downloadFile(fileInfo, chatId, type, retries - 1)
            .then(resolve)
            .catch(reject);
        }, 1000);
      } else {
        reject(err);
      }
    });

    request.on('timeout', () => {
      request.destroy();
      reject(new Error('Download timeout'));
    });
  });
}
