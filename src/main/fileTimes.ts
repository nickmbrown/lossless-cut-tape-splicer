import { utimes } from 'node:fs/promises';
import { execa } from 'execa';

import { isWindows } from './util.js';
import logger from './logger.js';

export interface FileTime {
  path: string,
  /** milliseconds since the epoch */
  ms: number,
}

// Windows exposes a file's creation time ("Date created" in Explorer), but node's fs api can
// only set access/modified times - so that one needs a PowerShell round trip. One invocation
// handles the whole export.
const setCreationTimesScript = `
$ErrorActionPreference = 'Continue'
$items = [Console]::In.ReadToEnd() | ConvertFrom-Json
foreach ($item in $items) {
  try {
    $file = Get-Item -LiteralPath $item.path
    $file.CreationTime = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$item.ms).LocalDateTime
  } catch {
    Write-Error $_
  }
}
`;

/**
 * Stamp exported files with the time their footage was actually recorded.
 */
export async function setFileTimes(items: FileTime[]) {
  if (items.length === 0) return;

  await Promise.all(items.map(async ({ path, ms }) => {
    try {
      const seconds = ms / 1000;
      await utimes(path, seconds, seconds);
    } catch (err) {
      logger.warn('Failed to set file modified time', path, err);
    }
  }));

  if (isWindows) {
    try {
      await execa('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', setCreationTimesScript], {
        input: JSON.stringify(items),
        timeout: 30_000,
      });
    } catch (err) {
      // non-fatal: the modified time above is already set
      logger.warn('Failed to set file creation times', err);
    }
  }
}
