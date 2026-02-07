import { existsSync, mkdirSync, copyFileSync, readdirSync, unlinkSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { EmbedBuilder } from 'discord.js';
import { debug } from '../utils/debug.js';
import { loggingConfig } from '../config/logging.js';

const log = debug('backup');

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.DATA_DIR || join(__dirname, '../../data');
const dbPath = join(dataDir, 'bot.db');
const backupDir = join(dataDir, 'backups');

const BACKUP_INTERVAL_MS = parseInt(process.env.BACKUP_INTERVAL_HOURS ?? '6', 10) * 60 * 60 * 1000;
const MAX_BACKUPS = parseInt(process.env.MAX_BACKUPS ?? '10', 10);

let intervalId = null;
let clientRef = null;

/**
 * Send a backup failure alert to the log channel.
 */
async function notifyBackupFailure(errorMessage) {
  if (!clientRef || !loggingConfig.logChannelId) return;
  try {
    const channel = await clientRef.channels.fetch(loggingConfig.logChannelId).catch(() => null);
    if (!channel?.send) return;
    const embed = new EmbedBuilder()
      .setColor(0xed4245)
      .setTitle('⚠️ Backup Failed')
      .setDescription(`Database backup failed:\n\`\`\`${errorMessage}\`\`\``)
      .setFooter({ text: 'Check disk space and permissions' })
      .setTimestamp();
    await channel.send({ embeds: [embed] });
  } catch {}
}

/**
 * Create a timestamped backup of the database.
 */
function createBackup() {
  if (!existsSync(dbPath)) {
    log('No database file to backup');
    return false;
  }

  if (!existsSync(backupDir)) {
    mkdirSync(backupDir, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const backupPath = join(backupDir, `bot_${timestamp}.db`);

  try {
    copyFileSync(dbPath, backupPath);
    const size = statSync(backupPath).size;
    log(`Backup created: ${backupPath} (${(size / 1024).toFixed(1)} KB)`);
    cleanupOldBackups();
    return true;
  } catch (err) {
    log('Backup failed:', err?.message);
    notifyBackupFailure(err?.message || 'Unknown error');
    return false;
  }
}

/**
 * Remove old backups beyond MAX_BACKUPS limit.
 */
function cleanupOldBackups() {
  if (!existsSync(backupDir)) return;

  try {
    const files = readdirSync(backupDir)
      .filter((f) => f.startsWith('bot_') && f.endsWith('.db'))
      .map((f) => ({
        name: f,
        path: join(backupDir, f),
        mtime: statSync(join(backupDir, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime); // newest first

    if (files.length > MAX_BACKUPS) {
      const toDelete = files.slice(MAX_BACKUPS);
      for (const file of toDelete) {
        unlinkSync(file.path);
        log(`Deleted old backup: ${file.name}`);
      }
    }
  } catch (err) {
    log('Cleanup failed:', err?.message);
  }
}

/**
 * Start the periodic backup service.
 */
export function startBackupService(client) {
  if (client) clientRef = client;
  if (intervalId) clearInterval(intervalId);

  // Create initial backup on startup
  createBackup();

  intervalId = setInterval(createBackup, BACKUP_INTERVAL_MS);
  const hours = BACKUP_INTERVAL_MS / (60 * 60 * 1000);
  console.log(`[Backup] Service started — every ${hours}h, keeping ${MAX_BACKUPS} backups`);
}

export function stopBackupService() {
  if (intervalId) { clearInterval(intervalId); intervalId = null; }
}
