/**
 * File-Type Classification Utility
 * Extension-based detection for routing file-open actions to the correct viewer.
 */

const IMAGE_EXTS = new Set([
    '.jpg', '.jpeg', '.png', '.gif', '.svg', '.webp', '.bmp', '.ico', '.avif',
    '.tiff', '.tif', '.heic', '.heif', '.heifs', '.jxl',
    '.raw', '.cr2', '.cr3', '.nef', '.arw', '.rw2'
]);

const VIDEO_EXTS = new Set([
    '.mp4', '.m4v', '.webm', '.ogv', '.mov', '.mkv',
    '.avi', '.flv', '.wmv', '.mpg', '.mpeg', '.mpe', '.3gp', '.vob',
    '.m2ts', '.mts', '.dat', '.prores', '.h264', '.h265', '.hevc',
]);

const AUDIO_EXTS = new Set([
    '.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a'
]);

const PDF_EXTS = new Set(['.pdf']);

const MARKDOWN_EXTS = new Set(['.md', '.markdown']);

const HTML_EXTS = new Set(['.html', '.htm', '.xhtml']);

/**
 * Thumbnail-eligible extensions — EXACT MIRROR of the backend support set
 * (src/server/thumb.rs: SUPPORTED_IMAGE_EXTS ∪ SUPPORTED_VIDEO_EXTS).
 * Keep in lockstep with the backend; decode failures fail closed
 * (failure cache → client error → grid falls back to the type icon).
 */
const THUMB_EXTS = new Set([
    // images (backend SUPPORTED_IMAGE_EXTS)
    '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff', '.tif', '.avif', '.ico',
    '.heic', '.heif', '.heifs', '.jxl', '.svg', '.raw', '.cr2', '.cr3', '.nef', '.arw', '.rw2',
    // videos (backend SUPPORTED_VIDEO_EXTS)
    '.mp4', '.mkv', '.webm', '.avi', '.mov', '.flv', '.wmv', '.m4v', '.3gp',
    '.ts', '.m2ts', '.mts', '.dat', '.vob', '.mpg', '.mpeg', '.mpe',
    '.rm', '.rmvb', '.prores', '.h264', '.h265', '.hevc'
]);

/**
 * Extract the lowercase file extension including the dot.
 * @param {string} filename
 * @returns {string} e.g. ".jpg", ".pdf", ""
 */
function getExt(filename) {
    const dot = filename.lastIndexOf('.');
    if (dot === -1 || dot === filename.length - 1) return '';
    return filename.slice(dot).toLowerCase();
}

/**
 * Classify a file by extension.
 * @param {string} filename - File name or path
 * @returns {'media'|'pdf'|'markdown'|'html'|'editor'}
 */
export function classifyFile(filename) {
    const ext = getExt(filename);
    if (IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext) || AUDIO_EXTS.has(ext)) return 'media';
    if (PDF_EXTS.has(ext)) return 'pdf';
    if (MARKDOWN_EXTS.has(ext)) return 'markdown';
    if (HTML_EXTS.has(ext)) return 'html';
    return 'editor';
}

/**
 * Sub-classify a media file into image / video / audio.
 * Returns null for non-media files.
 * @param {string} filename
 * @returns {'image'|'video'|'audio'|null}
 */
export function getMediaType(filename) {
    const ext = getExt(filename);
    if (IMAGE_EXTS.has(ext)) return 'image';
    if (VIDEO_EXTS.has(ext)) return 'video';
    if (AUDIO_EXTS.has(ext)) return 'audio';
    return null;
}

/**
 * Check if a file is eligible for server-side thumbnail generation.
 * @param {string} filename - File name or path
 * @returns {boolean}
 */
export function hasThumbnail(filename) {
    const ext = getExt(filename);
    return THUMB_EXTS.has(ext);
}
