import { createHash, randomBytes } from 'crypto';
import { EditChunk } from './changeModeChunker.js';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Logger } from './logger.js';

interface CacheEntry {
  chunks: EditChunk[];
  timestamp: number;
  promptHash: string;
}

const CACHE_DIR = path.join(os.tmpdir(), 'gemini-mcp-chunks');
const CACHE_TTL = 10 * 60 * 1000;
const MAX_CACHE_FILES = 50;
const CACHE_KEY_PATTERN = /^[a-f0-9]{8}$/i;

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
  }
  // Best-effort permission hardening (mode ignored on some platforms).
  try {
    fs.chmodSync(CACHE_DIR, 0o700);
  } catch {
    // ignore
  }
}

function resolveCachePath(cacheKey: string): string | null {
  if (!CACHE_KEY_PATTERN.test(cacheKey)) return null;
  const base = path.resolve(CACHE_DIR);
  const resolved = path.resolve(CACHE_DIR, `${cacheKey}.json`);
  if (!resolved.startsWith(base + path.sep)) return null;
  return resolved;
}

/**
 * Caches chunks from a changeMode response
 * @param prompt The original prompt (used for hash generation)
 * @param chunks The parsed and chunked edits
 * @returns A short cache key for retrieval
 */
export function cacheChunks(prompt: string, chunks: EditChunk[]): string {
  ensureCacheDir();
  cleanExpiredFiles(); // Cleanup on each write
  
  // Generate deterministic prompt hash for metadata/debugging
  const promptHash = createHash('sha256').update(prompt).digest('hex');
  
  // Use a random short key to avoid predictable keys and collisions.
  let cacheKey = randomBytes(4).toString('hex');
  let filePath = resolveCachePath(cacheKey);
  for (let i = 0; i < 5 && filePath && fs.existsSync(filePath); i++) {
    cacheKey = randomBytes(4).toString('hex');
    filePath = resolveCachePath(cacheKey);
  }
  if (!filePath) {
    // Extremely unlikely unless platform issues; fall back to prompt hash prefix.
    cacheKey = promptHash.slice(0, 8);
    filePath = resolveCachePath(cacheKey);
  }
  if (!filePath) {
    Logger.error(`Failed to generate a safe cache key/path`);
    return promptHash.slice(0, 8);
  }
  
  // Store with metadata
  const cacheData: CacheEntry = {
    chunks,
    timestamp: Date.now(),
    promptHash
  };
  
  try {
    fs.writeFileSync(filePath, JSON.stringify(cacheData), { mode: 0o600 });
    Logger.debug(`Cached ${chunks.length} chunks to file: ${cacheKey}.json`);
  } catch (error) {
    Logger.error(`Failed to cache chunks: ${error}`);
  }
  enforceFileLimits();
  return cacheKey;
}

/**
 * Retrieves cached chunks if they exist and haven't expired
 * @param cacheKey The cache key returned from cacheChunks
 * @returns The cached chunks or null if expired/not found
 */
export function getChunks(cacheKey: string): EditChunk[] | null {
  const filePath = resolveCachePath(cacheKey);
  if (!filePath) {
    Logger.debug(`Invalid cache key format: ${cacheKey}`);
    return null;
  }
  
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    
    const fileContent = fs.readFileSync(filePath, 'utf-8');
    const data: CacheEntry = JSON.parse(fileContent);
    
    if (Date.now() - data.timestamp > CACHE_TTL) {
      fs.unlinkSync(filePath);
      Logger.debug(`Cache expired for ${cacheKey}, deleted file`);
      return null;
    }
    
    Logger.debug(`Cache hit for ${cacheKey}, returning ${data.chunks.length} chunks`);
    return data.chunks;
  } catch (error) {
    Logger.debug(`Cache read error for ${cacheKey}: ${error}`);
    try {
      fs.unlinkSync(filePath); // Clean up bad file
    } catch {}
    return null;
  }
}

function cleanExpiredFiles(): void {
  try {
    ensureCacheDir();
    const files = fs.readdirSync(CACHE_DIR);
    const now = Date.now();
    let cleaned = 0;
    
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      
      const filePath = path.join(CACHE_DIR, file);
      try {
        const stats = fs.statSync(filePath);
        if (now - stats.mtimeMs > CACHE_TTL) {
          fs.unlinkSync(filePath);
          cleaned++;
        }
      } catch (error) {
        // Individual file error - continue with others
        Logger.debug(`Error checking file ${file}: ${error}`);
      }
    }
    
    if (cleaned > 0) {
      Logger.debug(`Cleaned ${cleaned} expired cache files`);
    }
  } catch (error) {
    // Non-critical, just log
    Logger.debug(`Cache cleanup error: ${error}`);
  }
}


 // maximum file count limit (FIFO) --> LRU?

function enforceFileLimits(): void {
  try {
    const files = fs.readdirSync(CACHE_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => ({
        name: f,
        path: path.join(CACHE_DIR, f),
        mtime: fs.statSync(path.join(CACHE_DIR, f)).mtimeMs
      }))
      .sort((a, b) => a.mtime - b.mtime); // Oldest first
    
    // Remove oldest files if over limit
    if (files.length > MAX_CACHE_FILES) {
      const toRemove = files.slice(0, files.length - MAX_CACHE_FILES);
      for (const file of toRemove) {
        try {
          fs.unlinkSync(file.path);
        } catch {}
      }
      Logger.debug(`Removed ${toRemove.length} old cache files to enforce limit`);
    }
  } catch (error) {
    Logger.debug(`Error enforcing file limits: ${error}`);
  }
}

export function getCacheStats(): { size: number; ttl: number; maxSize: number; cacheDir: string } {
  ensureCacheDir();
  let size = 0;
  
  try {
    const files = fs.readdirSync(CACHE_DIR);
    size = files.filter(f => f.endsWith('.json')).length;
  } catch {}
  
  return {
    size,
    ttl: CACHE_TTL,
    maxSize: MAX_CACHE_FILES,
    cacheDir: CACHE_DIR
  };
}

export function clearCache(): void { // !
  try {
    ensureCacheDir();
    const files = fs.readdirSync(CACHE_DIR);
    
    for (const file of files) {
      if (file.endsWith('.json')) {
        fs.unlinkSync(path.join(CACHE_DIR, file));
      }
    }
    
    Logger.debug('Cache emptied');
  } catch (error) {
    Logger.error(`Failed to empty cache: ${error}`);
  }
}
